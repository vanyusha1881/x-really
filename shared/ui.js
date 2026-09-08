// X-Really 共享 UI 工具：判定元数据、HTML 转义与结果卡片构建
// 供 content script 与 popup 页面共同使用
// v0.3: 三档明确判定（谣言/不是谣言/存疑），移除置信度与建议，新增来源标注

const XR_VERDICT_META = {
  rumor: { label: "谣言", icon: "🚫", cls: "xr-v-rumor" },
  not_rumor: { label: "不是谣言", icon: "✅", cls: "xr-v-credible" },
  suspected: { label: "存疑", icon: "⚠️", cls: "xr-v-suspected" },
  // 旧版本历史记录兼容映射
  credible: { label: "不是谣言", icon: "✅", cls: "xr-v-credible" },
  unknown: { label: "存疑", icon: "⚠️", cls: "xr-v-suspected" },
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
    const meta = XR_VERDICT_META[r.verdict] || XR_VERDICT_META.suspected;
    card.className = "xr-card " + meta.cls;
    const reasons = (r.reasons || [])
      .slice(0, 3)
      .map((x) => `<li>${xrEscapeHtml(x)}</li>`)
      .join("");
    const sources = (r.sources || []).slice(0, 3);
    card.innerHTML = `
      <div class="xr-card-head">
        <span class="xr-badge">${meta.icon} ${meta.label}</span>
        <button class="xr-close" type="button" title="关闭">×</button>
      </div>
      ${r.summary ? `<div class="xr-summary">${xrEscapeHtml(r.summary)}</div>` : ""}
      ${reasons ? `<ul class="xr-reasons">${reasons}</ul>` : ""}
      ${sources.length ? `<div class="xr-src">🔍 来源：${sources.map(xrEscapeHtml).join(" · ")}</div>` : ""}
      ${r.searched === false ? `<div class="xr-foot">联网检索不可用，本次基于 AI 知识判断</div>` : ""}
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
