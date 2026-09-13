// X-Really options：
// 1) 服务商预设卡片（默认展示 DeepSeek / OpenAI / 智谱 GLM，其余折叠）
// 2) 模型拉取（OpenAI 兼容 /models），带搜索下拉与本地缓存
// 3) 图片理解不再有独立 UI：后台核查时自动探测（支持则用图，不支持自动降级纯文字）

const XR_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  enableSearch: true,
};
const XR_MODEL_CACHE_KEY = "xrModelCache"; // { [cacheKey]: { ts, models } }
const XR_CACHE_TTL = 24 * 3600 * 1000;

// ---------- 可选主机权限（必需权限仅 x.com，其余域在用户手势中按需申请） ----------

const XR_SEARCH_ORIGIN_PATTERNS = [
  "https://www.google.com/*",
  "https://www.bing.com/*",
  "https://html.duckduckgo.com/*",
  "https://www.baidu.com/*",
];
const XR_IMAGE_ORIGIN_PATTERN = "https://pbs.twimg.com/*";

function apiOriginPattern(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.protocol + "//" + u.hostname + "/*"; // match pattern 不支持端口
  } catch {
    return null;
  }
}

/** 在用户手势（点击）中调用：为接口地址 + 四个搜索引擎 + 推文配图域统一申请可选权限。
 *  已授权过的来源不会重复弹窗；用户拒绝则返回 false，功能按已有降级路径处理。 */
async function ensureHostPermissions(s) {
  const origins = [
    ...new Set(
      [apiOriginPattern(s.baseUrl), ...XR_SEARCH_ORIGIN_PATTERNS, XR_IMAGE_ORIGIN_PATTERN].filter(
        Boolean
      )
    ),
  ];
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

const $ = (id) => document.getElementById(id);

// ---------- 基础工具 ----------

function collectSettings() {
  return {
    baseUrl: $("optBaseUrl").value.trim() || XR_DEFAULTS.baseUrl,
    apiKey: $("optApiKey").value.trim(),
    model: $("optModel").value.trim() || XR_DEFAULTS.model,
    enableSearch: $("optSearch").checked,
  };
}

function modelCacheKey(s) {
  // 不落盘 API Key 本身，仅用长度作指纹区分不同 Key 的列表缓存
  return s.baseUrl + "#" + (s.apiKey ? "k" + s.apiKey.length : "nokey");
}

function showToast(text) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function markDirty() {
  $("dirtyHint").classList.remove("hidden");
}

function setTestResult(text, cls) {
  const box = $("testResult");
  box.className = "test-result" + (cls ? " " + cls : "");
  box.textContent = text;
}

// ---------- 服务商预设 ----------

let currentProviderId = "custom";
// 默认只展示这三个 + 当前选中的服务商，其余折叠到「展开更多服务商」里
const XR_PRESET_VISIBLE = ["deepseek", "openai", "zhipu"];
let presetsExpanded = false;

function renderPresetGrid() {
  const grid = $("presetGrid");
  grid.innerHTML = "";
  let extraCount = 0;
  for (const p of XR_PROVIDERS) {
    const isExtra = !XR_PRESET_VISIBLE.includes(p.id) && p.id !== currentProviderId;
    if (isExtra) extraCount++;

    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset" + (p.id === currentProviderId ? " active" : "");
    card.dataset.id = p.id;
    if (isExtra) card.classList.add("extra");
    if (isExtra && !presetsExpanded) card.classList.add("hidden");
    card.innerHTML = `
      <div class="preset-top">
        <span class="preset-logo" style="background:${p.accent}">${xrEscapeHtml(p.name[0] || "?")}</span>
        <span class="preset-name">${xrEscapeHtml(p.name)}</span>
        ${p.tag ? `<span class="preset-tag">${xrEscapeHtml(p.tag)}</span>` : ""}
      </div>
      <span class="preset-url">${p.baseUrl ? xrEscapeHtml(p.baseUrl) : "手动填写接口地址"}</span>
      ${p.note ? `<span class="preset-note">${xrEscapeHtml(p.note)}</span>` : ""}
    `;
    card.addEventListener("click", () => applyPreset(p));
    grid.appendChild(card);
  }

  const toggle = $("presetToggle");
  if (extraCount) {
    toggle.classList.remove("hidden");
    toggle.textContent = presetsExpanded ? "收起更多服务商" : `展开更多服务商（${extraCount}）`;
  } else {
    toggle.classList.add("hidden");
  }
}

function applyPreset(p) {
  currentProviderId = p.id;
  if (p.baseUrl) $("optBaseUrl").value = p.baseUrl;
  if (p.defaultModel) $("optModel").value = p.defaultModel;

  renderPresetGrid();
  renderChips(p);
  updateKeyLink(p);
  updateOverview();
  markDirty();
}

function renderChips(p) {
  const box = $("modelChips");
  box.innerHTML = "";
  for (const m of p.models || []) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = m;
    chip.addEventListener("click", () => {
      $("optModel").value = m;
      updateOverview();
      markDirty();
    });
    box.appendChild(chip);
  }
}

function updateKeyLink(p) {
  const link = $("keyLink");
  if (p && p.keyUrl) {
    link.href = p.keyUrl;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }
}

// ---------- 模型拉取与下拉选择 ----------

let fetchedModels = null; // 本次会话内已拉取的列表

async function fetchModels() {
  const btn = $("fetchModels");
  const hint = $("fetchHint");

  // 先保存再拉取，保证后台读到的 baseUrl / Key 与界面一致
  const s = collectSettings();
  await chrome.storage.sync.set(s);

  // 拉取走接口域名，先确保已授权（点击即手势）
  if (!(await ensureHostPermissions(s))) {
    hint.className = "hint";
    hint.textContent = "❌ 未授予接口访问权限，无法拉取模型列表";
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="xr-spin"></span> 拉取中…';
  hint.className = "hint";
  hint.textContent = "正在从接口拉取模型列表…";

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "LIST_MODELS" });
  } catch {
    resp = { ok: false, error: "扩展通信失败" };
  }

  btn.disabled = false;
  btn.textContent = "拉取模型列表";

  if (resp && resp.ok) {
    fetchedModels = resp.info.models;
    // 写入本地缓存（按 baseUrl+Key指纹）
    const s = collectSettings();
    const stored = await chrome.storage.local.get(XR_MODEL_CACHE_KEY);
    const cache = stored[XR_MODEL_CACHE_KEY] || {};
    cache[modelCacheKey(s)] = { ts: Date.now(), models: fetchedModels };
    await chrome.storage.local.set({ [XR_MODEL_CACHE_KEY]: cache });

    hint.className = "hint";
    hint.textContent = `✅ 已拉取 ${fetchedModels.length} 个模型，点击模型输入框选择（24h 内缓存复用）`;
    openDrop();
  } else {
    hint.className = "hint";
    hint.textContent = "❌ " + ((resp && resp.error) || "拉取失败");
  }
}

async function getCachedModels() {
  if (fetchedModels) return fetchedModels;
  const s = collectSettings();
  const stored = await chrome.storage.local.get(XR_MODEL_CACHE_KEY);
  const entry = (stored[XR_MODEL_CACHE_KEY] || {})[modelCacheKey(s)];
  if (entry && Date.now() - entry.ts < XR_CACHE_TTL && Array.isArray(entry.models)) {
    fetchedModels = entry.models;
    return fetchedModels;
  }
  return null;
}

function renderModelList(filter) {
  const list = $("modelList");
  const kw = String(filter || "").toLowerCase();
  list.innerHTML = "";

  const visionTag = (m) =>
    xrDetectVisionStatic(m) === "yes" ? '<span class="v-tag">👁 多模态</span>' : "";

  let items = [];
  if (fetchedModels && fetchedModels.length) {
    items.push({ label: `接口返回（${fetchedModels.length}）`, group: true });
    items = items.concat(fetchedModels.map((m) => ({ name: m })));
  }
  const preset = XR_PROVIDERS.find((p) => p.id === currentProviderId);
  if (preset && preset.models.length) {
    items.push({ label: "常用模型", group: true });
    items = items.concat(preset.models.map((m) => ({ name: m })));
  }

  const seen = new Set();
  let shown = 0;
  for (const item of items) {
    if (item.group) {
      if (shown) {
        const li = document.createElement("li");
        li.className = "group-label";
        li.textContent = item.label;
        list.appendChild(li);
      }
      continue;
    }
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    if (kw && !item.name.toLowerCase().includes(kw)) continue;
    const li = document.createElement("li");
    li.innerHTML = `${xrEscapeHtml(item.name)}${visionTag(item.name)}`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault(); // 避免输入框失焦
      $("optModel").value = item.name;
      closeDrop();
      updateOverview();
      markDirty();
    });
    list.appendChild(li);
    shown++;
  }

  if (!shown) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = kw ? `无匹配「${kw}」，可直接使用输入的名称` : "暂无列表，可拉取或直接输入";
    list.appendChild(li);
  }
}

function openDrop() {
  $("modelDrop").classList.remove("hidden");
  renderModelList($("modelSearch").value);
}

function closeDrop() {
  $("modelDrop").classList.add("hidden");
}

// ---------- 配置概览（顶部仪表盘） ----------
// 说明：图片理解的检测 UI 已移除，能力由后台在核查时自动探测（支持则用图、不支持自动降级纯文字）。

async function updateOverview() {
  const baseUrl = $("optBaseUrl").value.trim();
  const model = $("optModel").value.trim();
  const search = $("optSearch").checked;

  // 服务商名
  const p = xrFindProvider(baseUrl);
  $("ovProvider").textContent = p ? p.name : baseUrl ? "自定义" : "未配置";

  // 模型
  $("ovModel").textContent = model || "未选择";

  // 联网搜索
  const ovSearch = $("ovSearch");
  ovSearch.textContent = search ? "开启" : "已关";
  ovSearch.className = "pill " + (search ? "st-on" : "st-off");
}

// ---------- 读取 / 保存 / 测试连接 ----------

async function loadSettings() {
  const s = { ...XR_DEFAULTS, ...(await chrome.storage.sync.get(XR_DEFAULTS)) };
  $("optBaseUrl").value = s.baseUrl;
  $("optApiKey").value = s.apiKey;
  $("optModel").value = s.model;
  $("optSearch").checked = s.enableSearch !== false;

  // 回显预设选中状态
  const p = xrFindProvider(s.baseUrl);
  currentProviderId = p ? p.id : "custom";
  renderPresetGrid();
  renderChips(p || XR_PROVIDERS[XR_PROVIDERS.length - 1]);
  updateKeyLink(p);
  updateOverview();
}

async function save() {
  const s = collectSettings();
  const btn = $("saveBtn");
  const idle = "保存设置";

  btn.disabled = true;
  btn.innerHTML = '<span class="xr-spin"></span> 保存中…';

  await chrome.storage.sync.set({ ...s, provider: currentProviderId });
  $("dirtyHint").classList.add("hidden");
  updateOverview();

  // 保存即授权：为接口地址 + 搜索引擎 + 配图域申请可选权限（已授权则静默通过）
  const granted = await ensureHostPermissions(s);
  btn.disabled = false;
  btn.textContent = idle;

  if (!granted) {
    setTestResult(
      "⚠️ 已保存，但未授予网络访问权限：AI 调用与联网核查将不可用。重新点击「保存设置」可再次授权",
      "warn"
    );
    showToast("⚠️ 已保存，但缺少网络访问授权");
    return;
  }

  setTestResult("✅ 保存成功", "ok");
  showToast("✅ 已保存");
}

async function testConnection() {
  const box = $("testResult");
  const btn = $("testBtn");

  // 先保存再测试，保证测试的是当前填写的配置
  const s = collectSettings();
  await chrome.storage.sync.set({ ...s, provider: currentProviderId });

  // 连接走接口域名，先确保已授权（点击即手势）
  if (!(await ensureHostPermissions(s))) {
    setTestResult("❌ 未授予接口访问权限，无法测试连接", "err");
    return;
  }

  btn.disabled = true;
  setTestResult("⏳ 正在连接…", "info");

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
  } catch {
    resp = { ok: false, error: "扩展通信失败" };
  }
  btn.disabled = false;

  if (resp && resp.ok) {
    const { latencyMs, model } = resp.info;
    setTestResult(`✅ 连接成功 · 模型 ${model} · 耗时 ${latencyMs}ms`, "ok");
  } else {
    setTestResult("❌ " + ((resp && resp.error) || "未知错误"), "err");
  }
}

// ---------- 初始化与事件绑定 ----------

loadSettings();

// 版本徽标：读 manifest，自动跟随版本号
$("verBadge").textContent = "v" + chrome.runtime.getManifest().version;

$("saveBtn").addEventListener("click", save);
$("testBtn").addEventListener("click", testConnection);
$("fetchModels").addEventListener("click", fetchModels);
$("presetToggle").addEventListener("click", () => {
  presetsExpanded = !presetsExpanded;
  renderPresetGrid();
});

$("toggleKey").addEventListener("click", () => {
  const input = $("optApiKey");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "隐藏" : "显示";
});

// 模型下拉交互
$("optModel").addEventListener("focus", openDrop);
$("optModel").addEventListener("input", () => {
  openDrop();
  updateOverview();
  markDirty();
});
$("modelSearch").addEventListener("input", (e) => renderModelList(e.target.value));
document.addEventListener("mousedown", (e) => {
  if (!$("modelDrop").contains(e.target) && e.target !== $("optModel")) closeDrop();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrop();
});

// 变更检测
for (const id of ["optBaseUrl", "optApiKey"]) {
  $(id).addEventListener("input", markDirty);
}
$("optSearch").addEventListener("change", () => {
  markDirty();
  updateOverview();
});
$("optBaseUrl").addEventListener("change", async () => {
  // baseUrl 变化时重新匹配预设（仅更新高亮与链接，不覆盖用户输入）
  const p = xrFindProvider($("optBaseUrl").value.trim());
  currentProviderId = p ? p.id : "custom";
  renderPresetGrid();
  updateKeyLink(p);
  updateOverview();
});
