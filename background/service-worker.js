// X-Really 后台服务：接收检查请求，联网检索资料 + 调用 OpenAI 兼容接口完成谣言核查
// v0.3: 明确三档判定（谣言/不是谣言/存疑）、联网搜索（Bing→DuckDuckGo 兜底）、
//       移除置信度/建议，结果附引用来源

const XR_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  enableSearch: true,
};

const XR_MAX_TEXT_LEN = 4000;
const XR_HISTORY_KEY = "xrHistory";
const XR_HISTORY_MAX = 20;
const XR_SEARCH_TIMEOUT = 8000;
const XR_SEARCH_MAX_RESULTS = 6;

// 1x1 测试图片，用于多模态能力实测
const XR_TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const XR_SYSTEM_PROMPT = `你是一位严格的事实核查员，必须对收到的推文做出明确的真假判断。

判断规则（必须遵守）：
1. 内容明显虚假、与可靠信源矛盾、或符合已被辟谣的谣言模式 → 判定"rumor"（谣言）
2. 内容与已知事实相符、或信源可靠且无矛盾 → 判定"not_rumor"（不是谣言）
3. "suspected"（存疑）只允许在确实无法判断时使用：信息过少、话题完全超出可查证范围、且搜索后仍无任何相关资料。严禁用"存疑"回避明确判断，绝大多数推文都应给出 rumor 或 not_rumor。

你会收到推文原文，以及（可能提供的）网络搜索资料。请：
1. 优先依据搜索资料中信源可靠的内容（权威媒体、政府机构、专业辟谣平台）进行判断
2. 搜索资料仅供参考，注意甄别其可信度与时效性；资料与推文无关时忽略之
3. 没有可用搜索资料时，基于你自身知识分析判断，同样必须给出明确结论
4. 输出必须简洁明确，不要冗余说明

严格输出以下 JSON（不要输出 JSON 以外的任何文字）：
{
  "verdict": "rumor" | "not_rumor" | "suspected",
  "summary": "一句话明确结论（不超过 40 字），直接回答是否是谣言",
  "reasons": ["依据1", "依据2"]（最多 3 条，每条不超过 40 字，注明依据来自"搜索资料"还是"知识分析"）,
  "sources": ["支撑结论的来源域名，如 www.reuters.com"]（仅当使用了搜索资料时提供，最多 3 个，未用搜索资料则为空数组）
}`;

// ---------- 工具 ----------

function makeError(message, code) {
  const err = new Error(message);
  err.code = code || "";
  return err;
}

async function getSettings() {
  return { ...XR_DEFAULTS, ...(await chrome.storage.sync.get(XR_DEFAULTS)) };
}

function apiUrl(settings, path) {
  return settings.baseUrl.replace(/\/+$/, "") + path;
}

function authHeaders(settings, extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (settings.apiKey) h.Authorization = "Bearer " + settings.apiKey;
  return h;
}

async function readErrorDetail(res) {
  try {
    const j = await res.json();
    return j?.error?.message || (typeof j?.error === "string" ? j.error : "") || j?.message || "";
  } catch {
    return "";
  }
}

/** 校验接口配置是否足以发起请求（本地服务如 Ollama 允许无 Key） */
async function requireEndpoint(settings) {
  if (!settings.baseUrl) throw makeError("请先配置接口地址", "NO_BASE_URL");
  const isLocal = /localhost|127\.0\.0\.1/.test(settings.baseUrl);
  if (!settings.apiKey && !isLocal) {
    throw makeError("请先填写并保存 API Key", "NO_API_KEY");
  }
}

// ---------- 联网搜索（Bing → DuckDuckGo 兜底，无需 API Key） ----------

function fetchWithTimeout(url, opts = {}, ms = XR_SEARCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function searchBing(query) {
  const res = await fetchWithTimeout(
    "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&count=10&setlang=zh-hans",
    { headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } }
  );
  if (!res.ok) throw new Error("bing http " + res.status);
  const html = await res.text();

  const results = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html)) && results.length < XR_SEARCH_MAX_RESULTS) {
    const url = m[1];
    const title = stripTags(m[2]);
    if (title && /^https?:/i.test(url)) {
      results.push({ url, title, snippet: stripTags(m[3]) });
    }
  }
  if (!results.length) throw new Error("bing no results");
  return results;
}

async function searchDuckDuckGo(query) {
  const res = await fetchWithTimeout(
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
    { headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } }
  );
  if (!res.ok) throw new Error("ddg http " + res.status);
  const html = await res.text();

  const links = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && links.length < XR_SEARCH_MAX_RESULTS) {
    let url = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        /* 保留原链接 */
      }
    }
    if (/^https?:/i.test(url)) links.push({ url, title: stripTags(m[2]) });
  }

  const snips = [];
  const snRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snRe.exec(html)) && snips.length < links.length) snips.push(stripTags(m[1]));

  const results = links.map((l, i) => ({ ...l, snippet: snips[i] || "" }));
  if (!results.length) throw new Error("ddg no results");
  return results;
}

/** 依次尝试多个搜索引擎，全部失败时抛出 SEARCH_ERROR */
async function webSearch(query) {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 120);
  for (const engine of [searchBing, searchDuckDuckGo]) {
    try {
      return await engine(q);
    } catch {
      /* 尝试下一个引擎 */
    }
  }
  throw makeError("联网搜索不可用", "SEARCH_ERROR");
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

    case "LIST_MODELS":
      listModels()
        .then((info) => sendResponse({ ok: true, info }))
        .catch((err) =>
          sendResponse({ ok: false, error: err?.message || String(err), code: err?.code || "" })
        );
      return true;

    case "TEST_VISION":
      testVision()
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

  // 联网检索资料（失败不阻塞，降级为纯知识分析）
  let materials = null;
  if (settings.enableSearch) {
    try {
      materials = await webSearch(text);
    } catch {
      materials = null;
    }
  }

  const content = await callLLM(text, settings, { materials });
  const result = parseVerdict(content);
  result.searched = !!(settings.enableSearch && materials && materials.length);
  pushHistory(text, result).catch(() => {});
  return result;
}

async function testConnection() {
  const settings = await getSettings();
  await requireEndpoint(settings);
  const t0 = Date.now();
  await callLLM("请只回复两个字符：OK", settings, { maxTokens: 16 });
  return { latencyMs: Date.now() - t0, model: settings.model };
}

/** 拉取模型列表：GET {baseUrl}/models，兼容 OpenAI / Ollama / 硅基流动等返回结构 */
async function listModels() {
  const settings = await getSettings();
  await requireEndpoint(settings);

  let res;
  try {
    res = await fetch(apiUrl(settings, "/models"), {
      method: "GET",
      headers: authHeaders(settings),
    });
  } catch {
    throw makeError("网络请求失败，请检查接口地址与网络连接", "NETWORK_ERROR");
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw makeError(
      `拉取失败 (HTTP ${res.status})${detail ? "：" + detail : ""}。该服务可能不支持 /models 接口，可手动输入模型名。`,
      "API_ERROR"
    );
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw makeError("接口返回的不是有效 JSON", "API_ERROR");
  }

  let models = [];
  if (Array.isArray(data?.data)) {
    models = data.data.map((m) => m?.id).filter((x) => typeof x === "string");
  } else if (Array.isArray(data?.models)) {
    models = data.models.map((m) => (typeof m === "string" ? m : m?.name || m?.model));
  } else if (Array.isArray(data)) {
    models = data.map((m) => (typeof m === "string" ? m : m?.id || m?.name));
  }
  models = [...new Set(models.filter(Boolean))].sort((a, b) => a.localeCompare(b));

  if (!models.length) {
    throw makeError("接口返回的模型列表为空，可手动输入模型名", "API_ERROR");
  }
  return { models };
}

/**
 * 多模态能力实测：向模型发送 1x1 测试图片，根据响应判断是否支持图片输入
 * @returns {{vision:"yes"|"no"|"unknown", note:string}}
 */
async function testVision() {
  const settings = await getSettings();
  await requireEndpoint(settings);
  if (!settings.model) throw makeError("请先填写模型名称", "NO_MODEL");

  const body = {
    model: settings.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image? Reply with one word." },
          { type: "image_url", image_url: { url: XR_TEST_IMAGE } },
        ],
      },
    ],
    max_tokens: 16,
  };

  let res;
  try {
    res = await fetch(apiUrl(settings, "/chat/completions"), {
      method: "POST",
      headers: authHeaders(settings),
      body: JSON.stringify(body),
    });
  } catch {
    throw makeError("网络请求失败，请检查接口地址与网络连接", "NETWORK_ERROR");
  }

  if (res.ok) {
    return { vision: "yes", note: "实测通过：模型可接收图片输入" };
  }

  const detail = await readErrorDetail(res);
  const notSupport =
    /image|vision|multimodal|图片|多模态|视觉|unsupported|not support|invalid.*type/i.test(detail);
  if ([400, 404, 415, 422].includes(res.status) && notSupport) {
    return { vision: "no", note: "实测确认：该模型不支持图片输入" };
  }
  return {
    vision: "unknown",
    note: `无法确认 (HTTP ${res.status})${detail ? "：" + detail.slice(0, 120) : ""}`,
  };
}

async function callLLM(text, settings, opts = {}) {
  let userContent = text;
  if (opts.materials && opts.materials.length) {
    const lines = opts.materials.map(
      (r, i) => `[${i + 1}] ${r.title}\n${r.snippet || "（无摘要）"}\n来源：${hostOf(r.url) || r.url}`
    );
    userContent =
      `【待核查推文】\n${text}\n\n` +
      `【网络搜索资料】（共 ${lines.length} 条，供参考，请自行甄别可信度与相关性）\n` +
      lines.join("\n\n");
  }

  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: XR_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  let res;
  try {
    res = await fetch(apiUrl(settings, "/chat/completions"), {
      method: "POST",
      headers: authHeaders(settings),
      body: JSON.stringify(body),
    });
  } catch {
    throw makeError("网络请求失败，请检查接口地址与网络连接", "NETWORK_ERROR");
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
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

const XR_VERDICTS = new Set(["rumor", "not_rumor", "suspected"]);
// 旧版本输出兼容
const XR_VERDICT_MAP = { credible: "not_rumor", unknown: "suspected" };

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

  const verdict = XR_VERDICTS.has(obj.verdict)
    ? obj.verdict
    : XR_VERDICT_MAP[obj.verdict] || "suspected";

  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 3)
    : [];

  const sources = Array.isArray(obj.sources)
    ? obj.sources
        .map((x) => hostOf(String(x)) || String(x).trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 3)
    : [];

  return {
    verdict,
    summary: String(obj.summary || "").slice(0, 80),
    reasons,
    sources,
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
