// X-Really options（v0.2）：
// 1) 服务商预设卡片（一键填充 baseUrl + 推荐模型）
// 2) 模型拉取（OpenAI 兼容 /models，参考 cc-switch），带搜索下拉与本地缓存
// 3) 多模态能力检测（静态命名识别 + 1x1 图片实测，结果按模型缓存）

const XR_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};
const XR_MODEL_CACHE_KEY = "xrModelCache"; // { [cacheKey]: { ts, models } }
const XR_CAPS_CACHE_KEY = "xrCaps"; // { [model]: { vision, note, ts } }
const XR_CACHE_TTL = 24 * 3600 * 1000;

const $ = (id) => document.getElementById(id);

// ---------- 基础工具 ----------

function collectSettings() {
  return {
    baseUrl: $("optBaseUrl").value.trim() || XR_DEFAULTS.baseUrl,
    apiKey: $("optApiKey").value.trim(),
    model: $("optModel").value.trim() || XR_DEFAULTS.model,
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

function renderPresetGrid() {
  const grid = $("presetGrid");
  grid.innerHTML = "";
  for (const p of XR_PROVIDERS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset" + (p.id === currentProviderId ? " active" : "");
    card.dataset.id = p.id;
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
}

function applyPreset(p) {
  currentProviderId = p.id;
  if (p.baseUrl) $("optBaseUrl").value = p.baseUrl;
  if (p.defaultModel) $("optModel").value = p.defaultModel;

  renderPresetGrid();
  renderChips(p);
  updateKeyLink(p);
  updateCapBadge(); // 切换模型后同步刷新静态能力识别
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
      updateCapBadge();
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
  await chrome.storage.sync.set(collectSettings());

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
      updateCapBadge();
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

// ---------- 多模态能力检测 ----------

const CAP_LABELS = { yes: "✅ 支持多模态", no: "🚫 不支持图片", unknown: "❓ 未知" };

async function updateCapBadge() {
  const model = $("optModel").value.trim();
  const badge = $("capBadge");
  const note = $("capNote");

  if (!model) {
    badge.className = "cap-badge unknown";
    badge.textContent = "❓ 未知";
    note.textContent = "请先填写模型名称";
    return;
  }

  // 优先使用实测缓存
  const stored = await chrome.storage.local.get(XR_CAPS_CACHE_KEY);
  const tested = (stored[XR_CAPS_CACHE_KEY] || {})[model];
  const stat = xrDetectVisionStatic(model);

  if (tested) {
    badge.className = "cap-badge " + tested.vision;
    badge.textContent = CAP_LABELS[tested.vision];
    note.textContent = `实测于 ${new Date(tested.ts).toLocaleString("zh-CN")}`;
    return;
  }

  badge.className = "cap-badge " + stat;
  badge.textContent = CAP_LABELS[stat];
  note.textContent =
    stat === "yes" ? "根据模型命名识别" : stat === "no" ? "根据模型命名识别" : "命名无法识别，可实测检测";
}

async function runVisionTest() {
  const btn = $("testVision");
  const note = $("capNote");

  // 先保存再实测
  await chrome.storage.sync.set(collectSettings());

  btn.disabled = true;
  note.textContent = "正在发送测试图片…";

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "TEST_VISION" });
  } catch {
    resp = { ok: false, error: "扩展通信失败" };
  }
  btn.disabled = false;

  if (resp && resp.ok) {
    const { vision, note: n } = resp.info;
    const badge = $("capBadge");
    badge.className = "cap-badge " + vision;
    badge.textContent = CAP_LABELS[vision];
    note.textContent = n || "";

    // 按模型缓存实测结果
    const model = $("optModel").value.trim();
    if (model) {
      const stored = await chrome.storage.local.get(XR_CAPS_CACHE_KEY);
      const caps = stored[XR_CAPS_CACHE_KEY] || {};
      caps[model] = { vision, note: n, ts: Date.now() };
      await chrome.storage.local.set({ [XR_CAPS_CACHE_KEY]: caps });
    }
  } else {
    note.textContent = "❌ " + ((resp && resp.error) || "检测失败");
  }
}

// ---------- 读取 / 保存 / 测试连接 ----------

async function loadSettings() {
  const s = { ...XR_DEFAULTS, ...(await chrome.storage.sync.get(XR_DEFAULTS)) };
  $("optBaseUrl").value = s.baseUrl;
  $("optApiKey").value = s.apiKey;
  $("optModel").value = s.model;

  // 回显预设选中状态
  const p = xrFindProvider(s.baseUrl);
  currentProviderId = p ? p.id : "custom";
  renderPresetGrid();
  renderChips(p || XR_PROVIDERS[XR_PROVIDERS.length - 1]);
  updateKeyLink(p);
  updateCapBadge();
}

async function save() {
  const s = collectSettings();
  await chrome.storage.sync.set({ ...s, provider: currentProviderId });
  $("dirtyHint").classList.add("hidden");
  showToast("✅ 已保存");
  updateCapBadge();
}

async function testConnection() {
  const box = $("testResult");
  const btn = $("testBtn");

  // 先保存再测试，保证测试的是当前填写的配置
  await chrome.storage.sync.set({ ...collectSettings(), provider: currentProviderId });

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

$("saveBtn").addEventListener("click", save);
$("testBtn").addEventListener("click", testConnection);
$("fetchModels").addEventListener("click", fetchModels);
$("testVision").addEventListener("click", runVisionTest);

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
  updateCapBadge();
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
$("optBaseUrl").addEventListener("change", async () => {
  // baseUrl 变化时重新匹配预设（仅更新高亮与链接，不覆盖用户输入）
  const p = xrFindProvider($("optBaseUrl").value.trim());
  currentProviderId = p ? p.id : "custom";
  renderPresetGrid();
  updateKeyLink(p);
});
