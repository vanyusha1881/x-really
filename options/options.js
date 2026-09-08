// X-Really options：读取/保存 API 配置，并支持连接测试

const XR_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};

const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const s = { ...XR_DEFAULTS, ...(await chrome.storage.sync.get(XR_DEFAULTS)) };
  $("optBaseUrl").value = s.baseUrl;
  $("optApiKey").value = s.apiKey;
  $("optModel").value = s.model;
}

function collectSettings() {
  return {
    baseUrl: $("optBaseUrl").value.trim() || XR_DEFAULTS.baseUrl,
    apiKey: $("optApiKey").value.trim(),
    model: $("optModel").value.trim() || XR_DEFAULTS.model,
  };
}

function showToast(text) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

async function save() {
  const s = collectSettings();
  await chrome.storage.sync.set(s);
  showToast("✅ 已保存");
}

async function testConnection() {
  const box = $("testResult");
  const btn = $("testBtn");

  // 先保存再测试，保证测试的是当前填写的配置
  const s = collectSettings();
  await chrome.storage.sync.set(s);

  btn.disabled = true;
  box.className = "test-result";
  box.textContent = "⏳ 正在连接…";

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
  } catch {
    resp = { ok: false, error: "扩展通信失败" };
  }
  btn.disabled = false;

  if (resp && resp.ok) {
    const { latencyMs, model } = resp.info;
    box.className = "test-result ok";
    box.textContent = `✅ 连接成功 · 模型 ${model} · 耗时 ${latencyMs}ms`;
  } else {
    box.className = "test-result err";
    box.textContent = "❌ " + ((resp && resp.error) || "未知错误");
  }
}

loadSettings();
$("saveBtn").addEventListener("click", save);
$("testBtn").addEventListener("click", testConnection);
