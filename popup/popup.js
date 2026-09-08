// X-Really popup：状态栏 + 手动文本检查 + 历史记录

const XR_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};
const HISTORY_KEY = "xrHistory";

const $ = (id) => document.getElementById(id);

const IDLE_BTN_HTML = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
       stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>
    <path d="M9 12l2 2 4-4"/>
  </svg>
  <span>开始检查</span>`;

// ---------- 状态栏 ----------

async function refreshStatus() {
  const s = { ...XR_DEFAULTS, ...(await chrome.storage.sync.get(XR_DEFAULTS)) };
  const bar = $("statusBar");

  if (!s.apiKey) {
    bar.className = "status warn";
    bar.innerHTML =
      '⚠️ 尚未配置 API，检查功能不可用 <button class="text-btn" id="goCfg">去配置 →</button>';
    $("goCfg").addEventListener("click", () => chrome.runtime.openOptionsPage());
  } else {
    let host = "";
    try {
      host = new URL(s.baseUrl).host;
    } catch {
      /* 非法 URL 时仅显示模型 */
    }
    bar.className = "status ok";
    bar.innerHTML = `<span class="dot"></span>已就绪 · ${xrEscapeHtml(s.model)}${
      host ? " · " + xrEscapeHtml(host) : ""
    }`;
  }
}

// ---------- 手动检查 ----------

async function runCheck() {
  const text = $("inputText").value.trim();
  if (!text) {
    $("inputText").focus();
    return;
  }

  setChecking(true);
  $("resultBox").innerHTML = "";

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "CHECK_TEXT", text });
  } catch {
    resp = { ok: false, error: "扩展通信失败，请重试" };
  }

  setChecking(false);
  $("resultBox").appendChild(xrBuildCard(resp));
  refreshHistory();
}

function setChecking(on) {
  const btn = $("checkBtn");
  btn.disabled = on;
  btn.innerHTML = on ? '<span class="xr-spin"></span><span>AI 分析中…</span>' : IDLE_BTN_HTML;
}

// ---------- 历史记录 ----------

function timeAgo(t) {
  const d = Date.now() - t;
  if (d < 60e3) return "刚刚";
  if (d < 3600e3) return Math.floor(d / 60e3) + " 分钟前";
  if (d < 86400e3) return Math.floor(d / 3600e3) + " 小时前";
  return new Date(t).toLocaleDateString("zh-CN");
}

async function refreshHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = stored[HISTORY_KEY] || [];
  const ul = $("historyList");
  ul.innerHTML = "";

  if (!list.length) {
    ul.innerHTML = '<li class="empty">暂无检测记录</li>';
    return;
  }

  for (const item of list) {
    const meta = XR_VERDICT_META[item.verdict] || XR_VERDICT_META.unknown;
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="h-badge ${meta.cls}">${meta.icon} ${meta.label}</span>
      <div class="h-body">
        <div class="h-text" title="${xrEscapeHtml(item.text)}">${xrEscapeHtml(item.text)}</div>
        <div class="h-time">${timeAgo(item.t)}${
          item.summary ? " · " + xrEscapeHtml(item.summary) : ""
        }</div>
      </div>`;
    ul.appendChild(li);
  }
}

// ---------- 初始化 ----------

setChecking(false);
refreshStatus();
refreshHistory();

$("checkBtn").addEventListener("click", runCheck);
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("clearHistory").addEventListener("click", async () => {
  await chrome.storage.local.remove(HISTORY_KEY);
  refreshHistory();
});
$("inputText").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runCheck();
  }
});
