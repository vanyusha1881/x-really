// X-Really 后台服务：接收检查请求，联网检索资料 + 调用 OpenAI 兼容接口完成谣言核查
// v0.8: 搜索引擎并行竞速（原串行降级在 Google 不可达时每查询白等 10s）；
//       配图并行下载 + 压缩（768px JPEG），结果 30 分钟缓存，提示词改为证据中立版（双向防误判）
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
const XR_RESULT_CACHE_KEY = "xrResultCache"; // { [key]: { ts, result } } 核查结果缓存
const XR_RESULT_CACHE_TTL = 30 * 60 * 1000; // 30 分钟内相同内容直接复用
const XR_RESULT_CACHE_MAX = 50;
const XR_HISTORY_MAX = 20;
const XR_SEARCH_TIMEOUT = 7000; // 引擎并行竞速，无需长超时
const XR_COLLECT_WINDOW = 1500; // 首个引擎成功后，再等 1.5s 收集其他引擎结果（多引擎合并提高覆盖）
const XR_SEARCH_MAX_RESULTS = 8;
const XR_IMAGE_TIMEOUT = 12000;
const XR_IMAGE_MAX_BYTES = 4.5 * 1024 * 1024;
const XR_IMAGE_MAX_COUNT = 4; // X 单条推文最多 4 张图，全部纳入分析
const XR_IMAGE_MAX_DIM = 768; // 配图压缩后最长边（像素），base64 体积缩小一个数量级

// 1x1 测试图片，用于多模态能力实测
const XR_TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const XR_SYSTEM_PROMPT = `你是一位严谨的事实核查员。你核查的是「推文核心事实是否属实」，不是「表述是否夸张」——真实事件的叙述往往比虚构更离奇，判断只看事实本身。

【核查流程】
1. 提取核心事实点（人名/机构/事件/时间/地点/数字），把评论、情绪、演绎与事实分开。
2. 逐点核实：先依据你确切掌握的知识独立判断，再用搜索资料交叉验证（搜索能覆盖你知识截止之后的新事件）。
3. 证据权级：权威信源（政府/主流媒体/知名辟谣平台）与你的确切知识 > 一般网页摘要 > 你的模糊印象。资料与你的确切知识冲突时，按权级独立裁决，不盲从任何一方。

【判定规则 — 严格遵守】
- "rumor"（谣言）：核心事实与权威证据或你确切掌握的知识相矛盾；已被权威信源明确辟谣；明显违背基础常识；或图文不符/拼接篡改导致核心事实失实。
- "not_rumor"（不是谣言）：核心事实被权威资料证实，或与你确切掌握的知识相符。细节夸张但核心事实为真，仍判 not_rumor（在依据中指出"细节夸大"即可）。
- "suspected"（存疑）：核心事实超出你的知识范围，且搜索资料无关或不足以判断。禁止用 suspected 回避结论——能判断就必须给出判断。

【双向防误判 — 两个方向都严防】
- 无媒体报道 ≠ 谣言：你无法穷举报道，"没听说过/查无报道/情节离奇/像编的"不能作为判 rumor 的依据。
- 表述可信 ≠ 事实：情绪强烈、细节生动、流传甚广都不能证明其为真；判 not_rumor 必须有正面证据（确切知识或权威资料）。
- 搜索资料命中"年份列表"、无关主题时，忽略这些资料，回到知识判断。
- 搜索不可用且超出知识范围 → suspected，不要猜测；但搜索不可用时你确切知道为假的事实（含常识错误）仍应判 rumor。
- 推文若带配图：将图片内容纳入判断（图文是否相符、是否断章取义、伪造、移花接木）。

【输出严格 JSON】（不要输出 JSON 以外的任何文字，包括 markdown 围栏）
{
  "verdict": "rumor" | "not_rumor" | "suspected",
  "summary": "一句话明确结论（不超过 40 字），直接回答是否是谣言",
  "reasons": ["依据1", "依据2"]（最多 3 条，每条不超过 40 字，注明依据来自"搜索资料"、"配图分析"或"知识分析"）,
  "sources": ["支撑结论的来源域名，如 www.reuters.com"]（仅当使用了搜索资料时提供，最多 3 个；未用搜索资料则为空数组）
}`;

// 谣言复核 prompt：搜索失败时判 rumor 必须过这道关——给不出确切矛盾事实就降级 suspected
const XR_VERIFY_PROMPT = `你之前把下面这条推文判定为"谣言"，且当时联网搜索不可用。现在必须复核这次判定。

复核标准：
- 维持 "rumor" 的唯一合法依据：你**确切掌握**与推文矛盾的具体事实——具体到人名、机构、时间、数据，且可查证；或明显违背基础常识。
- "没听说过"、"无权威媒体报道过"、"情节离奇"、"符合谣言编造模式"都**不是**依据。你无法穷举媒体报道，真实事件往往比想象更离奇。
- 推文把不同时期的事件拼接、时间错位，若核心事实本身为真，不属于谣言。

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
  const snippet = sn ? stripTags(sn[1]).slice(0, 300) : "";
  results.push({ url, title, snippet });
  return true;
}

const XR_SEARCH_ENGINES = [searchGoogle, searchBing, searchDuckDuckGo, searchBaidu];
// 引擎健康度：失败后 30 分钟内不再尝试（并行竞速下无延迟代价，只省掉无谓请求）
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 并行发起所有可用引擎，首个成功后再等 1.5s 收集其他引擎结果，合并去重返回。
 * - 速度：总耗时 ≈ 最快成功引擎（原串行降级在 Google 不可达时每查询白等超时）
 * - 准确性：多引擎结果合并，资料覆盖远好于"只取第一个成功引擎"
 * - 能否访问 Google 取决于 Chrome 的代理配置（扩展走 Chrome 网络栈），失败自动被并行竞速淘汰
 */
async function webSearch(query) {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 120);
  const engines = XR_SEARCH_ENGINES.filter(engineAvailable);
  if (!engines.length) throw makeError("联网搜索不可用", "SEARCH_ERROR");

  const settled = [];
  const tasks = engines.map((engine) =>
    engine(q).then(
      (rs) => {
        settled.push(...rs.map((r) => ({ ...r, engine: engineName(engine) })));
        return true;
      },
      () => {
        markEngineDown(engine);
        throw makeError("engine failed", "ENGINE_ERROR");
      }
    )
  );

  try {
    await Promise.any(tasks); // 等第一个引擎成功（全部失败才抛 AggregateError）
    await sleep(XR_COLLECT_WINDOW); // 收集窗口：并入其余引擎已返回的结果
  } catch {
    /* 全部引擎失败，走下面统一抛错 */
  }

  if (!settled.length) throw makeError("联网搜索不可用", "SEARCH_ERROR");
  return settled;
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

/** 下载图片并压缩为最长边 XR_IMAGE_MAX_DIM 的 JPEG data URL。
 *  medium 尺寸原图 base64 往往数百 KB～数 MB，压缩后约 100KB，多模态请求显著提速；
 *  压缩失败时降级返回原图 data URL（保证任何视觉模型都能读取，无需服务商代拉远程图） */
async function downloadImageAsDataUrl(url) {
  const res = await fetchWithTimeout(url, {}, XR_IMAGE_TIMEOUT);
  if (!res.ok) throw new Error("image http " + res.status);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error("not an image");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > XR_IMAGE_MAX_BYTES) throw new Error("image too large");
  const mime = type.split(";")[0];
  try {
    return await compressImage(new Blob([buf], { type: mime }), XR_IMAGE_MAX_DIM);
  } catch {
    return "data:" + mime + ";base64," + bufToBase64(buf);
  }
}

/** OffscreenCanvas 压缩：保持宽高比缩放到最长边 maxDim，输出 JPEG（GIF 取首帧，核查够用） */
async function compressImage(blob, maxDim, quality = 0.78) {
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return await blobToDataUrl(out);
  } finally {
    bmp.close();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
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

  // 结果缓存：30 分钟内相同内容（文本 + 配图张数）直接复用，跳过搜索与模型调用
  const imageUrls = sanitizeImageUrls(rawImages);
  const cacheKey = hashString(text) + "-i" + imageUrls.length;
  const cached = await readCachedResult(cacheKey);
  if (cached) return cached;

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

  // 配图：并行下载 + 压缩（已知不支持视觉的模型直接跳过）
  const imageTotal = imageUrls.length;
  let imageDataUrls = [];
  let imageFailed = 0;
  if (imageTotal) {
    const stored = await chrome.storage.local.get(XR_CAPS_KEY);
    const cap = (stored[XR_CAPS_KEY] || {})[settings.model];
    if (!cap || cap.vision !== "no") {
      const settled = await Promise.allSettled(imageUrls.map((u) => downloadImageAsDataUrl(u)));
      for (const s of settled) {
        if (s.status === "fulfilled") imageDataUrls.push(s.value);
        else imageFailed++;
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

  writeCachedResult(cacheKey, result);
  pushHistory(text, result).catch(() => {});
  return result;
}

// ---------- 结果缓存（30 分钟内相同内容直接复用） ----------

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + "-" + s.length;
}

async function readCachedResult(key) {
  try {
    const stored = await chrome.storage.local.get(XR_RESULT_CACHE_KEY);
    const hit = (stored[XR_RESULT_CACHE_KEY] || {})[key];
    if (hit && Date.now() - hit.ts <= XR_RESULT_CACHE_TTL) {
      return { ...hit.result, cached: true };
    }
  } catch {
    /* 缓存失败不影响主流程 */
  }
  return null;
}

async function writeCachedResult(key, result) {
  try {
    const stored = await chrome.storage.local.get(XR_RESULT_CACHE_KEY);
    const cache = stored[XR_RESULT_CACHE_KEY] || {};
    cache[key] = { ts: Date.now(), result };
    const keys = Object.keys(cache).sort((a, b) => cache[a].ts - cache[b].ts);
    while (keys.length > XR_RESULT_CACHE_MAX) delete cache[keys.shift()];
    await chrome.storage.local.set({ [XR_RESULT_CACHE_KEY]: cache });
  } catch {
    /* 缓存失败不影响主流程 */
  }
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

/** 发起 chat/completions 请求（网络层失败统一转 NETWORK_ERROR） */
async function postChat(settings, body) {
  try {
    return await fetch(apiUrl(settings, "/chat/completions"), {
      method: "POST",
      headers: authHeaders(settings),
      body: JSON.stringify(body),
    });
  } catch {
    throw makeError("网络请求失败，请检查接口地址与网络连接", "NETWORK_ERROR");
  }
}

async function callLLM(text, settings, opts = {}) {
  let textPart = text;
  if (opts.materials && opts.materials.length) {
    const lines = opts.materials.map(
      (r, i) => `[${i + 1}] ${r.title}\n${r.snippet || "（无摘要）"}\n来源：${hostOf(r.url) || r.url}`
    );
    const relevanceHint = opts.searchHitEntities
      ? ""
      : "\n（⚠️ 提示：以下搜索资料未命中推文中的核心人名/公司/事件，可能不相关；与推文核心事实无关的资料请直接忽略，回到知识判断）";
    textPart =
      `【待核查推文】\n${text}\n\n` +
      `【网络搜索资料】（多角度查询汇总，共 ${lines.length} 条，供参考，请自行甄别可信度与相关性）${relevanceHint}\n` +
      lines.join("\n\n");
  } else if (opts.searchFailed) {
    textPart =
      `【待核查推文】\n${text}\n\n` +
      `【重要说明】联网搜索当前不可用，请完全基于你确切掌握的知识判断：\n` +
      `- 确切知道核心事实为假（含常识错误、张冠李戴、已被辟谣）→ 判 rumor，依据注明"知识分析"\n` +
      `- 确切知道核心事实为真 → 判 not_rumor\n` +
      `- 超出知识范围、无法确认 → 判 suspected。注意"搜索不到"≠"不存在"，不得以"无媒体报道/没听说过"为由判 rumor`;
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
    temperature: 0, // 事实核查要确定性输出，降低结果抖动
  };
  if (opts.maxTokens) {
    body.max_tokens = opts.maxTokens;
  } else {
    // JSON 模式：大幅降低输出混入散文/围栏的概率（测试连接等非 JSON 场景不启用）
    body.response_format = { type: "json_object" };
  }

  let res = await postChat(settings, body);
  // 个别服务商不支持 response_format：识别相关报错后去掉该参数重试一次
  if (!res.ok && body.response_format) {
    const d1 = await readErrorDetail(res);
    if (res.status === 400 || /response_format|json_object|json mode/i.test(d1)) {
      delete body.response_format;
      res = await postChat(settings, body);
    }
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
