// X-Really content script：在每条推文下方注入「检查谣言」按钮与结果卡片
// 依赖：shared/ui.js（XR_VERDICT_META / xrBuildCard 已注入）

(() => {
  "use strict";

  // ---------- 工具 ----------

  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + "-" + text.length;
  }

  // ---------- 推文扫描 ----------

  function scan() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      try {
        processArticle(article);
      } catch {
        /* 单条失败不影响其余 */
      }
    }
  }

  function processArticle(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl || !textEl.isConnected) return;

    const text = textEl.innerText.trim();
    if (!text) return;

    const hash = hashText(text);
    const root = article.querySelector(".xr-root");

    // 已处理且推文内容未变化 → 跳过（应对虚拟化 DOM 复用）
    if (root && root.dataset.xrHash === hash && root.isConnected) return;

    if (root) root.remove();
    textEl.insertAdjacentElement("afterend", buildRoot(text, hash));
  }

  // ---------- UI 构建 ----------

  function buildRoot(text, hash) {
    const root = document.createElement("div");
    root.className = "xr-root";
    root.dataset.xrHash = hash;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "xr-btn";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
           stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>
        <path d="M9 12l2 2 4-4"/>
      </svg>
      <span>检查谣言</span>`;
    btn.addEventListener("click", () => runCheck(btn, root, text));

    root.appendChild(btn);
    return root;
  }

  async function runCheck(btn, root, text) {
    if (btn.disabled) return;
    setLoading(btn, true);

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "CHECK_TEXT", text });
    } catch {
      resp = { ok: false, error: "扩展通信失败，请刷新页面后重试" };
    }
    setLoading(btn, false);

    const oldCard = root.querySelector(":scope > .xr-card");
    if (oldCard) oldCard.remove();
    root.appendChild(xrBuildCard(resp));
  }

  function setLoading(btn, on) {
    if (on) {
      btn.dataset.orig = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add("xr-loading");
      btn.innerHTML = `<span class="xr-spin"></span><span>AI 分析中…</span>`;
    } else {
      btn.disabled = false;
      btn.classList.remove("xr-loading");
      if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
    }
  }

  // ---------- 启动与监听 ----------

  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(scan, 300);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  scan();
})();
