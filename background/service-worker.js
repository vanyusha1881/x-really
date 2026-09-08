// X-Really 后台服务：接收检查请求，联网检索资料 + 调用 OpenAI 兼容接口完成谣言核查
// v0.5: 多角度检索（实体提取 + 去年份前缀）+ 搜索结果相关性提示
//       修复 v0.4 在长推文/真实事件被夸张叙述时易误判为"谣言"的问题
// v0.4: 支持推文配图多模态分析（下载转 base64），testVision 支持未保存配置实测，
//       图片请求报错时自动降级为纯文字分析

const XR_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  enableSearch: true,
};

const XR_MAX_TEXT_LEN = 8000; // X Premium 长推文可达 2.5 万字，8k 覆盖绝大多数；超长会截断并在卡片标注
const XR_HISTORY_KEY = "xrHistory";
const XR_CAPS_KEY = "xrCaps"; // { [model]: { vision, note, ts } } 多模态实测缓存
const XR_HISTORY_MAX = 20;
const XR_SEARCH_TIMEOUT = 10000;
const XR_SEARCH_MAX_RESULTS = 6;
const XR_IMAGE_TIMEOUT = 12000;
const XR_IMAGE_MAX_BYTES = 4.5 * 1024 * 1024;
const XR_IMAGE_MAX_COUNT = 4; // X 单条推文最多 4 张图，全部纳入分析

// 1x1 测试图片，用于多模态能力实测
const XR_TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const XR_SYSTEM_PROMPT = `你是一位严谨的事实核查员。你核查的是「推文中的具体事实是否属实」，而不是「推文听起来像不像真的」。

【判定权属 — 最高原则】
最终判定由**你的思考**产生。搜索资料只是交给你的"补充证据"，不是答案，更不是投票——你才是核查员，搜索引擎不是。资料与你的判断冲突时，由你根据信源可靠性独立裁决。

【核查流程】
1. **先基于你自身的知识独立分析**：提取核心事实点（人名 / 公司 / 地点 / 事件 / 数字 / 时间），判断真实性。这是判定的主要依据。
2. **再用搜索资料做交叉验证**：仅用于核实你不确定的细节、或覆盖你训练截止之后的新事件。
3. 冲突时的裁决规则：明确的权威搜索证据 > 你模糊的记忆；你确切知道的事实 > 低质量搜索摘要。

【判定规则 — 严格遵守】
- "rumor"（谣言）：必须满足下列任一条件——
  · 权威信源（可靠媒体 / 政府机构 / 知名辟谣平台）存在与推文相反的明确事实
  · 推文内容已被权威信源明确辟谣
  · 推文内容违反基础科学常识（如"地球是方的"）
  仅凭"听起来离奇"、"搜索结果不直接相关"、"我印象中没有"、"推文叙述夸张"都**不能**判 rumor。
- "not_rumor"（不是谣言）：核心事实与你确切掌握的知识相符，或被权威资料证实，或属于真实事件（真实事件本身往往比叙述更戏剧化，不能因为夸张就否定事实本身）。
- "suspected"（存疑）：搜索资料完全无关、且超出自身知识范围。**只在你确实无能力判断时使用**。

【关键警示 — 防止常见误判】
- 真实事件被改写/拼接/夸大（把不同时期的事件混在一起）≠ 谣言。核心事实存在时，结论应为 not_rumor，可在依据里指出"细节拼接/时间错位"。
- **严禁**以"无权威媒体报道"、"没有相关记录"、"符合谣言编造模式"、"情节离奇"作为判 rumor 的依据——你无法穷举媒体报道，真实事件往往比想象更离奇。这类说辞本身就是编造。
- 搜索资料命中"年份列表"、"无关主题"时，**忽略这些资料**，回到你自己的知识判断。
- 你确切知道的人物/事件（哪怕搜索没命中），**必须用知识判断**，不要因为搜索失败就否认事实存在。
- 推文若带配图：将图片内容纳入判断（图文是否相符、是否断章取义、伪造、移花接木）。
- 知识截止后的新事件：搜索资料是唯一可用的外部依据；此时搜索也失败则判 suspected，不要瞎猜。
- **搜索不可用时判 rumor 的额外门槛**：只有当你确切掌握与推文矛盾的具体事实（可查证的人名/机构/时间/数据）时才可判 rumor；仅凭"不知道/没听说过/情节离奇"必须判 suspected。

【输出严格 JSON】（不要输出 JSON 以外的任何文字，包括 markdown 围栏）
{
  "verdict": "rumor" | "not_rumor" | "suspected",
  "summary": "一句话明确结论（不超过 40 字），直接回答是否是谣言",
  "reasons": ["依据1", "依据2"]（最多 3 条，每条不超过 40 字，注明依据来自"搜索资料"、"配图分析"或"知识分析"）,
  "sources": ["支撑结论的来源域名，如 www.reuters.com"]（仅当使用了搜索资料时提供，最多 3 个；未用搜索资料则为空数组）
}`;

// 谣言复核 prompt：搜索失败时判 rumor 必须过这道关——给不出确切矛盾事实就降级 suspected
const XR_VERIFY_PROMPT = `你之前把下面这条推文判定为"谣言"。现在必须复核这次判定。

复核标准：
- 判"rumor"的唯一合法依据：你**确切掌握**与推文矛盾的具体事实——具体到人名、机构、时间、数据，且可查证。
- "没听说过"、"无权威媒体报道过"、"情节离奇"、"符合谣言编造模式"都**不是**依据。你无法穷举媒体报道，真实事件往往比想象更离奇（例如官员受贿数亿、劫狱脱逃等曾被大量真实报道）。
- 推文把不同时期的事件拼接、时间错位，也不改变"核心事实真实"的性质。

输出规则：
- 确切掌握矛盾事实 → 维持 "rumor"，reasons 里必须写出该具体事实（注明"知识分析"）
- 给不出 → 改判 "suspected"，summary 说明"搜索不可用，无法确证"

严格输出 JSON（不要输出任何其他文字）：
{
  "verdict": "rumor" | "suspected",
  "summary": "一句话结论（不超过 40 字）",
  "reasons": ["依据1", "依据2"]（最多 3 条，每条不超过 40 字，注明"知识分析"）,
  "sources": []
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

function fetchWithTimeout(url, opts = {}, ms = XR_SEARCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---------- 联网搜索（Bing → DuckDuckGo 兜底，无需 API Key） ----------

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

/**
 * 百度搜索（中文本地新闻覆盖远胜 Bing）
 * 百度结果链接是 https://www.baidu.com/link?url=... 跳转形式，浏览器扩展用户点开时会自动 302 到真实 URL；
 * 对插件来说只需 URL 能被模型识别即可。
 */
async function searchBaidu(query) {
  const res = await fetchWithTimeout(
    "https://www.baidu.com/s?wd=" + encodeURIComponent(query) + "&rn=10",
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
    }
  );
  if (!res.ok) throw new Error("baidu http " + res.status);
  const html = await res.text();

  const results = [];
  // 百度结构：<h3><a href="...">title</a></h3> 后续摘要块在 result 容器内
  // 用 lookahead 在 h3/容器结束/下一个结果处停止，避免吃到下一个 result 块
  const blockRe =
    /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>([\s\S]*?)(?=<h3|<\/div>\s*<div\s+class="result|<!--\s*result\s*-->|<!--\s*new\s*-->|$)/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < XR_SEARCH_MAX_RESULTS) {
    const url = m[1];
    const title = stripTags(m[2]);
    if (!title || !/^https?:/i.test(url)) continue;
    // 摘要截取：去掉 h3 后面的内嵌 JSON 元数据（百度 SPA 模板残留），只保留可见文本
    let raw = m[3] || "";
    raw = raw.split("}],")[0]; // 截断到 SPA 数据标签之前
    const snippet = stripTags(raw).slice(0, 200);
    // 过滤"百度百科/百度图片/百度知道"等导航型结果
    if (/^(百度|baidu)/i.test(title)) continue;
    results.push({ url, title, snippet });
  }
  if (!results.length) throw new Error("baidu no results");
  return results;
}

/**
 * Google 搜索（国际信源覆盖最好；需 Chrome 能访问 google.com）
 * 解析以 <h3> 为锚点（Google 结果标题结构最稳定）：
 * 向前找最近的真实链接，向后在 1200 字窗口内找摘要容器。
 * 不依赖具体 class 名，抗 Google 前端改版能力较强。
 */
async function searchGoogle(query) {
  const res = await fetchWithTimeout(
    "https://www.google.com/search?num=10&hl=zh-CN&q=" + encodeURIComponent(query),
    {
      headers: {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml",
      },
    }
  );
  if (!res.ok) throw new Error("google http " + res.status);
  const html = await res.text();

  const results = [];
  // 主解析：锚定"包含 h3 的同一个 <a>" —— 链接与标题一一对应，不会跨结果块取错
  const anchorRe = /<a[^>]*href="([^"]+)"[^>]*>\s*(?:<br>)?\s*<h3[^>]*>([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = anchorRe.exec(html)) && results.length < XR_SEARCH_MAX_RESULTS) {
    const title = stripTags(m[2]);
    const url = normalizeGoogleUrl(m[1]);
    if (title && url) {
      pushGoogleResult(results, html, m.index + m[0].length, url, title);
    }
  }

  // 兜底解析：Google 若改版导致上面失配，用"h3 前后窗口"再试一次
  if (!results.length) {
    const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
    while ((m = h3Re.exec(html)) && results.length < XR_SEARCH_MAX_RESULTS) {
      const title = stripTags(m[1]);
      if (!title) continue;
      const before = html.slice(Math.max(0, m.index - 400), m.index);
      const hrefs = [...before.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
      for (let i = hrefs.length - 1; i >= 0; i--) {
        const url = normalizeGoogleUrl(hrefs[i]);
        if (!url) continue;
        if (pushGoogleResult(results, html, m.index + m[0].length, url, title)) break;
      }
    }
  }

  if (!results.length) throw new Error("google no results");
  return results;
}

/** 处理 Google 的 href：老式 /url?q= 跳转需解码，绝对链接直接用 */
function normalizeGoogleUrl(raw) {
  if (!raw) return "";
  let url = raw;
  if (/^\/url\?/i.test(url)) {
    const qm = /[?&]q=([^&]+)/.exec(url);
    if (!qm) return "";
    try {
      url = decodeURIComponent(qm[1]);
    } catch {
      return "";
    }
  }
  if (!/^https?:/i.test(url)) return "";
  // 排除 Google 自家页面（搜索设置、图片、地图、缓存等）
  const host = hostOf(url);
  if (!host || /google\.(com|[a-z.]+)$/i.test(host)) return "";
  return url;
}

/** 抽取摘要并入 results；返回是否成功（URL 重复/无效时返回 false，便于调用方继续尝试下一个链接） */
function pushGoogleResult(results, html, from, url, title) {
  if (results.some((r) => r.url === url)) return false;
  const after = html.slice(from, from + 1200);
  const sn =
    /<div[^>]*class="[^"]*(?:VwiC3b|hgKElc|MUxGbd|lyLwlc|yDYNvb|IsZvec)[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(
      after
    ) || /<span[^>]*class="[^"]*aCOpRe[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(after);
  const snippet = sn ? stripTags(sn[1]).slice(0, 200) : "";
  results.push({ url, title, snippet });
  return true;
}

const XR_SEARCH_ENGINES = [searchGoogle, searchBing, searchDuckDuckGo, searchBaidu];
// 引擎健康度：失败后 30 分钟内不再尝试（避免每次核查都为不可达的引擎白等超时）
const XR_ENGINE_TTL = 30 * 60 * 1000;
const xrEngineDown = new Map();

function engineName(engine) {
  return engine.name.replace("search", "");
}

function engineAvailable(engine) {
  const until = xrEngineDown.get(engine.name);
  return !until || Date.now() > until;
}

function markEngineDown(engine) {
  xrEngineDown.set(engine.name, Date.now() + XR_ENGINE_TTL);
}

/** 依次尝试多个搜索引擎，全部失败时抛出 SEARCH_ERROR。
 *  顺序：Google（国际信源）→ Bing → DDG → 百度（中文本地新闻兜底）
 *  注意：能否访问 Google 取决于 Chrome 的代理配置（扩展走 Chrome 网络栈），非插件自身能力。 */
async function webSearch(query) {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 120);
  for (const engine of XR_SEARCH_ENGINES) {
    if (!engineAvailable(engine)) continue;
    try {
      const rs = await engine(q);
      return rs.map((r) => ({ ...r, engine: engineName(engine) }));
    } catch {
      markEngineDown(engine);
    }
  }
  throw makeError("联网搜索不可用", "SEARCH_ERROR");
}

// ---------- 多角度检索（v0.5：解决长推文/含年份的查询被无关结果淹没） ----------

/** 提取推文中的关键实体（公司/人名/事件/带引号名字），用于派生更精准的查询 */
function extractKeyEntities(text) {
  const ents = [];
  const push = (s) => {
    if (s && !ents.includes(s)) ents.push(s);
  };
  // 公司/机构：X公司/集团/厂/局/厅/部/医院/学校/大学/中心
  // 故意排除"所/院"等过宽泛后缀（"看守所/法院/研究院"易误匹配整段短语）
  const orgs = text.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,12}(?:公司|集团|厂|局|厅|部|医院|学校|大学|中心|党委|党组)/g);
  if (orgs) orgs.slice(0, 3).forEach(push);
  // 头衔 + 人：X总/董事长/总经理/书记/局长/情人；X+丈夫/妻子 只取 ≤4 字前缀，避免吞并整句
  const titles = text.match(/[\u4e00-\u9fa5]{1,3}(?:老总|董事长|总经理|书记|局长|省长|市长|情人|总裁|主席|主任)/g);
  if (titles) titles.slice(0, 2).forEach(push);
  const rels = text.match(/[\u4e00-\u9fa5]{1,2}(?:丈夫|妻子)/g);
  if (rels) rels.slice(0, 1).forEach(push);
  // 引号内的人名/事件
  const quoted = text.match(/[「"']([\u4e00-\u9fa5]{2,5})[」"']/g);
  if (quoted) quoted.slice(0, 2).forEach((s) => push(s.slice(1, -1)));
  // 事件关键词：X案/事件/事故/大案
  const events = text.match(/[\u4e00-\u9fa5]{2,8}(?:大案|案件|案发|事件|事故|腐败案|受贿案|脱逃案|劫狱)/g);
  if (events) events.slice(0, 1).forEach(push);
  return ents.slice(0, 4);
}

/** 从推文派生 2-3 个搜索查询，覆盖"全文"+"去年份"+"实体组合"三个角度 */
function buildSearchQueries(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  const queries = [];
  const seen = new Set();
  const add = (q) => {
    const k = q.replace(/\s+/g, " ").trim();
    if (k && k.length >= 4 && !seen.has(k)) {
      seen.add(k);
      queries.push(k);
    }
  };
  // Q1：原文前 60 字（保留最完整的语境）
  add(clean.slice(0, 60));
  // Q2：去掉开头的年份/日期前缀（年份会诱导搜索引擎返回"年度大事件"列表）
  const stripped = clean.replace(/^\s*\d{2,4}\s*年[\d月日,，:：\s]*/, "").slice(0, 60);
  if (stripped && stripped !== clean.slice(0, 60)) add(stripped);
  // Q3：实体组合
  const ents = extractKeyEntities(clean);
  if (ents.length >= 2) add(ents.join(" "));
  return queries.slice(0, 3);
}

/** 命中推文中任一实体的搜索结果视为"相关"；用于给模型可靠性提示 */
function countRelevantHits(materials, text) {
  if (!materials || !materials.length) return 0;
  const ents = extractKeyEntities(text);
  if (!ents.length) return materials.length; // 提取不出实体时全部视为相关
  let hits = 0;
  for (const r of materials) {
    const blob = ((r.title || "") + " " + (r.snippet || "")).toLowerCase();
    if (ents.some((e) => blob.includes(e.toLowerCase()))) hits++;
  }
  return hits;
}

/** 多查询并行检索（Promise.allSettled），结果汇总去重，返回前 N 条 */
async function searchMulti(queries) {
  const settled = await Promise.allSettled(queries.map((q) => webSearch(q)));
  const all = [];
  const seen = new Set();
  for (const s of settled) {
    if (s.status !== "fulfilled" || !Array.isArray(s.value)) continue;
    for (const r of s.value) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        all.push(r);
      }
    }
  }
  return all.slice(0, XR_SEARCH_MAX_RESULTS);
}

// ---------- 配图处理 ----------

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 下载图片并转为 data URL（保证任何视觉模型都能读取，无需服务商代拉远程图） */
async function downloadImageAsDataUrl(url) {
  const res = await fetchWithTimeout(url, {}, XR_IMAGE_TIMEOUT);
  if (!res.ok) throw new Error("image http " + res.status);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error("not an image");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > XR_IMAGE_MAX_BYTES) throw new Error("image too large");
  return "data:" + type.split(";")[0] + ";base64," + bufToBase64(buf);
}

function sanitizeImageUrls(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((u) => typeof u === "string" && /^https:\/\/pbs\.twimg\.com\//.test(u))
    .slice(0, XR_IMAGE_MAX_COUNT);
}

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "CHECK_TEXT":
      checkText(msg.text, msg.images, msg.quotedChars)
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
      testVision(msg.overrides)
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

async function checkText(rawText, rawImages, quotedChars) {
  const fullText = String(rawText || "").trim();
  const text = fullText.slice(0, XR_MAX_TEXT_LEN);
  const textTruncated = fullText.length > XR_MAX_TEXT_LEN;
  if (!text) throw makeError("请提供要检查的文本", "EMPTY_TEXT");

  const settings = await getSettings();
  if (!settings.apiKey) {
    throw makeError("尚未配置 API Key，请先在扩展设置中完成配置", "NO_API_KEY");
  }

  // 联网检索资料（多角度查询；全部失败时降级为纯知识分析）
  let materials = [];
  let searchFailed = false;
  let searchHitEntities = true; // 搜索结果是否与推文核心实体相关
  if (settings.enableSearch) {
    const queries = buildSearchQueries(text);
    materials = await searchMulti(queries);
    if (!materials.length) searchFailed = true;
    else searchHitEntities = countRelevantHits(materials, text) > 0;
  } else {
    searchFailed = true;
  }

  // 配图：下载转 base64（已知不支持视觉的模型直接跳过）
  const imageUrls = sanitizeImageUrls(rawImages);
  const imageTotal = imageUrls.length;
  let imageDataUrls = [];
  let imageFailed = 0;
  if (imageTotal) {
    const stored = await chrome.storage.local.get(XR_CAPS_KEY);
    const cap = (stored[XR_CAPS_KEY] || {})[settings.model];
    if (!cap || cap.vision !== "no") {
      for (const u of imageUrls) {
        try {
          imageDataUrls.push(await downloadImageAsDataUrl(u));
        } catch {
          imageFailed++;
        }
      }
    } else {
      // 已确认模型不支持视觉：不下载，直接全部计入"未分析"
      imageFailed = imageTotal;
    }
  }

  const result = await analyzeWithModel(text, settings, materials, imageDataUrls, {
    searchFailed,
    searchHitEntities,
  });

  // ---------- 谣言复核关：搜索失败/无有效资料时判 rumor，必须复核 ----------
  // 防止模型在无证据情况下以"没听说过/无媒体报道"给真实事件扣谣言帽（实测高频误判路径）
  if (result.verdict === "rumor" && !result.searched) {
    try {
      const content = await callLLM(text, settings, {
        images: imageDataUrls,
        searchFailed: true,
        verify: true,
      });
      const vr = parseVerdict(content);
      if (vr.verdict !== "rumor") {
        // 复核未通过：降级为 suspected，保留回执字段
        Object.assign(result, vr, { rumorDowngraded: true });
      }
    } catch {
      /* 复核失败时保留原判定 */
    }
  }

  // ---------- 内容回执（供卡片展示，让用户确认模型实际读到了什么） ----------
  result.searched = !!(settings.enableSearch && materials && materials.length);
  result.searchOff = !settings.enableSearch;
  result.engine = result.searched ? materials[0]?.engine || "" : "";
  result.textChars = text.length;
  result.textTruncated = textTruncated;
  result.quotedChars = Number(quotedChars) || 0;
  result.imageTotal = imageTotal;
  // 走图被模型拒绝后降级纯文本时，skippedImages 已置 true，配图全部未纳入
  result.imageCount = result.skippedImages ? 0 : imageDataUrls.length;
  result.imageFailed = result.skippedImages ? imageTotal : imageFailed;

  pushHistory(text, result).catch(() => {});
  return result;
}

/** 调用模型分析；带图请求报"不支持图片"类错误时，自动降级重试纯文字 */
async function analyzeWithModel(text, settings, materials, imageDataUrls, ctx = {}) {
  try {
    const content = await callLLM(text, settings, {
      materials,
      images: imageDataUrls,
      searchFailed: ctx.searchFailed,
      searchHitEntities: ctx.searchHitEntities,
    });
    return parseVerdict(content);
  } catch (err) {
    const imgNotSupported =
      imageDataUrls.length &&
      /image|vision|multimodal|图片|多模态|视觉|unsupported|not support/i.test(
        String(err?.message || "")
      );
    if (imgNotSupported) {
      // 降级：不带走图重新请求
      const content = await callLLM(text, settings, {
        materials,
        images: [],
        searchFailed: ctx.searchFailed,
        searchHitEntities: ctx.searchHitEntities,
      });
      const result = parseVerdict(content);
      result.skippedImages = true;
      // 记录该模型不支持视觉，避免下次重复报错
      await cacheVisionResult(settings.model, "no", "分析时实测确认不支持图片输入").catch(() => {});
      return result;
    }
    throw err;
  }
}

async function cacheVisionResult(model, vision, note) {
  if (!model) return;
  const stored = await chrome.storage.local.get(XR_CAPS_KEY);
  const caps = stored[XR_CAPS_KEY] || {};
  caps[model] = { vision, note, ts: Date.now() };
  await chrome.storage.local.set({ [XR_CAPS_KEY]: caps });
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
 * 多模态能力实测：向模型发送 1x1 测试图片，根据响应判断是否支持图片输入。
 * @param {object} [overrides] 未保存配置的实测（绑定校验用），覆盖 baseUrl/apiKey/model
 * @returns {{vision:"yes"|"no"|"unknown", note:string}}
 */
async function testVision(overrides) {
  const settings = { ...(await getSettings()), ...(overrides || {}) };
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
    const info = { vision: "yes", note: "实测通过：模型可接收图片输入" };
    await cacheVisionResult(settings.model, info.vision, info.note).catch(() => {});
    return info;
  }

  const detail = await readErrorDetail(res);
  const notSupport =
    /image|vision|multimodal|图片|多模态|视觉|unsupported|not support|invalid.*type/i.test(detail);
  if ([400, 404, 415, 422].includes(res.status) && notSupport) {
    const info = { vision: "no", note: "实测确认：该模型不支持图片输入" };
    await cacheVisionResult(settings.model, info.vision, info.note).catch(() => {});
    return info;
  }
  return {
    vision: "unknown",
    note: `无法确认 (HTTP ${res.status})${detail ? "：" + detail.slice(0, 120) : ""}`,
  };
}

async function callLLM(text, settings, opts = {}) {
  let textPart = text;
  if (opts.materials && opts.materials.length) {
    const lines = opts.materials.map(
      (r, i) => `[${i + 1}] ${r.title}\n${r.snippet || "（无摘要）"}\n来源：${hostOf(r.url) || r.url}`
    );
    const relevanceHint = opts.searchHitEntities
      ? ""
      : "\n（⚠️ 提示：以下搜索资料均未命中推文中的核心人名/公司/事件，请勿据此否定推文事实，优先依据自身知识判断）";
    textPart =
      `【待核查推文】\n${text}\n\n` +
      `【网络搜索资料】（多角度查询汇总，共 ${lines.length} 条，供参考，请自行甄别可信度与相关性）${relevanceHint}\n` +
      lines.join("\n\n");
  } else if (opts.searchFailed) {
    textPart =
      `【待核查推文】\n${text}\n\n` +
      `【重要说明】联网搜索当前不可用。注意："搜索不到"≠"不存在"。\n` +
      `- 请完全基于自身知识判断；超出知识范围时判 suspected。\n` +
      `- 严禁使用"无权威媒体报道"、"没有记录"作为判谣言的依据——你没有搜索，无法知道媒体报道了什么。\n` +
      `- 仅凭"情节离奇/没听说过"只能判 suspected，不得判 rumor。`;
  }
  if (opts.images && opts.images.length) {
    textPart += `\n\n（本消息附有 ${opts.images.length} 张推文配图，请按系统指令结合图片内容分析）`;
  }

  const userContent =
    opts.images && opts.images.length
      ? [
          { type: "text", text: textPart },
          ...opts.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : textPart;

  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: opts.verify ? XR_VERIFY_PROMPT : XR_SYSTEM_PROMPT },
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
