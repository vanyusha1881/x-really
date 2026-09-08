// X-Really 后台服务：接收检查请求，调用 OpenAI 兼容接口完成谣言分析

const XR_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};

const XR_MAX_TEXT_LEN = 4000;
const XR_HISTORY_KEY = "xrHistory";
const XR_HISTORY_MAX = 20;

const XR_SYSTEM_PROMPT = `你是一位专业的社交媒体内容事实核查员，任务是判断用户提供的推文内容是否包含谣言或虚假信息。

请按以下维度分析：
1. 事实性陈述：文中是否存在可核查的事实性断言（数据、事件、引语、因果论断等）
2. 可疑信号：情绪化煽动、绝对化表述、无信源、诱导转发、"震惊体"等谣言常见特征
3. 常识与逻辑：内容是否违背基本常识、内部逻辑是否自洽
4. 已知谣言模式：是否与广为流传的谣言套路或已被辟谣的说法相符

注意：你无法实时联网核实，请基于自身知识审慎判断，不要武断下结论。

严格输出以下 JSON（不要输出 JSON 以外的任何文字）：
{
  "verdict": "rumor" | "suspected" | "credible" | "unknown",
  "confidence": 0-100 的整数，表示你对该判断的置信度,
  "summary": "一句话结论（不超过 60 字）",
  "reasons": ["理由1", "理由2"]（2-4 条，每条不超过 80 字）,
  "advice": "给读者的一条建议（不超过 60 字）"
}

verdict 含义：
- rumor：内容包含明显虚假、已被证伪或高度可信为谣言的信息
- suspected：存在可疑信号但证据不足，无法确认也无法证伪
- credible：未见明显谣言特征，内容与已知事实不冲突
- unknown：信息无法评估（过短、过于模糊或超出判断能力）`;

// ---------- 工具 ----------

function makeError(message, code) {
  const err = new Error(message);
  err.code = code || "";
  return err;
}

async function getSettings() {
  return { ...XR_DEFAULTS, ...(await chrome.storage.sync.get(XR_DEFAULTS)) };
}

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "CHECK_TEXT":
      checkText(msg.text)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) =>
          sendResponse({ ok: false, error: err?.message || String(err), code: err?.code || "" })
        );
      return true; // 异步响应

    case "TEST_CONNECTION":
      testConnection()
        .then((info) => sendResponse({ ok: true, info }))
        .catch((err) =>
          sendResponse({ ok: false, error: err?.message || String(err), code: err?.code || "" })
        );
      return true;

    case "OPEN_OPTIONS":
      chrome.runtime.openOptionsPage();
      return;
  }
});

// ---------- 核心逻辑 ----------

async function checkText(rawText) {
  const text = String(rawText || "").trim().slice(0, XR_MAX_TEXT_LEN);
  if (!text) throw makeError("请提供要检查的文本", "EMPTY_TEXT");

  const settings = await getSettings();
  if (!settings.apiKey) {
    throw makeError("尚未配置 API Key，请先在扩展设置中完成配置", "NO_API_KEY");
  }

  const content = await callLLM(text, settings);
  const result = parseVerdict(content);
  pushHistory(text, result).catch(() => {});
  return result;
}

async function testConnection() {
  const settings = await getSettings();
  if (!settings.apiKey) throw makeError("请先填写并保存 API Key", "NO_API_KEY");
  const t0 = Date.now();
  await callLLM("请只回复两个字符：OK", settings, { maxTokens: 16 });
  return { latencyMs: Date.now() - t0, model: settings.model };
}

async function callLLM(text, settings, opts = {}) {
  const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: XR_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    temperature: 0.2,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw makeError("网络请求失败，请检查接口地址与网络连接", "NETWORK_ERROR");
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error?.message || (typeof j?.error === "string" ? j.error : "") || "";
    } catch {
      /* 忽略解析失败 */
    }
    throw makeError(
      `接口请求失败 (HTTP ${res.status})${detail ? "：" + detail : ""}`,
      "API_ERROR"
    );
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw makeError("接口返回的不是有效 JSON", "API_ERROR");
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw makeError("接口返回内容为空", "API_ERROR");
  return content;
}

const XR_VERDICTS = new Set(["rumor", "suspected", "credible", "unknown"]);

function parseVerdict(content) {
  let raw = String(content).trim();
  raw = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) {
    throw makeError("AI 返回内容无法解析为 JSON", "PARSE_ERROR");
  }

  let obj;
  try {
    obj = JSON.parse(raw.slice(s, e + 1));
  } catch {
    throw makeError("AI 返回 JSON 解析失败", "PARSE_ERROR");
  }

  const verdict = XR_VERDICTS.has(obj.verdict) ? obj.verdict : "unknown";

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 50;
  confidence = Math.round(Math.min(100, Math.max(0, confidence)));

  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.map((x) => String(x)).filter(Boolean).slice(0, 6)
    : [];

  return {
    verdict,
    confidence,
    summary: String(obj.summary || "").slice(0, 200),
    reasons,
    advice: String(obj.advice || "").slice(0, 200),
  };
}

async function pushHistory(text, result) {
  const stored = await chrome.storage.local.get(XR_HISTORY_KEY);
  const list = stored[XR_HISTORY_KEY] || [];
  const item = {
    t: Date.now(),
    verdict: result.verdict,
    summary: result.summary,
    text: text.slice(0, 160),
  };
  const next = [item, ...list.filter((x) => x.text !== item.text)].slice(0, XR_HISTORY_MAX);
  await chrome.storage.local.set({ [XR_HISTORY_KEY]: next });
}
