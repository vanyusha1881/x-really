// X-Really 共享 UI 工具：判定元数据、HTML 转义与结果卡片构建
// 供 content script 与 popup 页面共同使用

const XR_VERDICT_META = {
  rumor: { label: "谣言", icon: "🚫", cls: "xr-v-rumor" },
  suspected: { label: "存疑", icon: "⚠️", cls: "xr-v-suspected" },
  credible: { label: "未见谣言特征", icon: "✅", cls: "xr-v-credible" },
  unknown: { label: "无法判断", icon: "❔", cls: "xr-v-unknown" },
};

function xrEscapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/**
 * 根据后台返回的响应构建结果卡片 DOM 元素
 * @param {{ok:boolean, result?:object, error?:string, code?:string}} resp
 * @returns {HTMLElement}
 */
function xrBuildCard(resp) {
  const card = document.createElement("div");

  if (!resp || !resp.ok) {
    const code = resp && resp.code;
    const msg = xrEscapeHtml((resp && resp.error) || "未知错误");
    card.className = "xr-card xr-v-error";
    card.innerHTML = `
      <div class="xr-card-head">
        <span class="xr-badge">❌ 检查失败</span>
        <button class="xr-close" type="button" title="关闭">×</button>
      </div>
      <div class="xr-summary">${msg}</div>
      ${code === "NO_API_KEY" ? '<button class="xr-cfg-btn" type="button">前往配置 API →</button>' : ""}
    `;
  } else {
    const r = resp.result || {};
    const meta = XR_VERDICT_META[r.verdict] || XR_VERDICT_META.unknown;
    card.className = "xr-card " + meta.cls;
    const reasons = (r.reasons || []).map((x) => `<li>${xrEscapeHtml(x)}</li>`).join("");
    const conf = Number.isFinite(r.confidence) ? r.confidence : 50;
    card.innerHTML = `
      <div class="xr-card-head">
        <span class="xr-badge">${meta.icon} ${meta.label}</span>
        <span class="xr-conf">置信度 ${conf}%</span>
        <button class="xr-close" type="button" title="关闭">×</button>
      </div>
      ${r.summary ? `<div class="xr-summary">${xrEscapeHtml(r.summary)}</div>` : ""}
      ${reasons ? `<ul class="xr-reasons">${reasons}</ul>` : ""}
      ${r.advice ? `<div class="xr-advice">💡 ${xrEscapeHtml(r.advice)}</div>` : ""}
      <div class="xr-foot">由 AI 分析生成，仅供参考，不构成事实结论</div>
    `;
  }

  const closeBtn = card.querySelector(".xr-close");
  if (closeBtn) closeBtn.addEventListener("click", () => card.remove());

  const cfgBtn = card.querySelector(".xr-cfg-btn");
  if (cfgBtn) {
    cfgBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
    });
  }
  return card;
}
