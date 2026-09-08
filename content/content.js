// X-Really content script：在推文操作栏末尾注入「检查谣言」按钮，结果卡片渲染在推文正文下方
// 依赖：shared/ui.js（XR_VERDICT_META / xrBuildCard 已注入）
// v0.2: 按钮从正文下方迁移至操作栏（回复/转发/点赞一排的末尾），样式贴合 X 原生操作按钮

(() => {
  "use strict";

  // 操作栏图标：盾牌 + 对勾（与扩展品牌一致）
  const ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>
    <path d="M9 12l2 2 4-4"/>
  </svg>`;

  // ---------- 工具 ----------

  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + "-" + text.length;
  }

  /**
   * 提取推文配图 URL（仅 pbs.twimg.com/media，排除头像/emoji）。
   * 统一转为 medium 尺寸以平衡清晰度与 token 消耗；最多 2 张。
   */
  function extractImageUrls(article) {
    const urls = [];
    const imgs = article.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
    for (const img of imgs) {
      if (urls.length >= 2) break;
      let src = img.getAttribute("src") || "";
      if (!src) continue;
      // 旧格式后缀 :small / :large 等
      src = src.replace(/:(small|medium|large|[0-9a-z]+x[0-9a-z]+)$/i, "");
      if (/([?&])name=/.test(src)) {
        src = src.replace(/([?&])name=[^&]*/, "$1name=medium");
      } else {
        src += (src.includes("?") ? "&" : "?") + "name=medium";
      }
      if (!urls.includes(src)) urls.push(src);
    }
    return urls;
  }

  /** 确保推文正文之后存在与当前文本哈希匹配的卡片容器，返回容器或 null */
  function ensureCardRoot(article, textEl, hash) {
    let root = article.querySelector(":scope .xr-root");
    if (root && root.dataset.xrHash !== hash) {
      root.remove();
      root = null;
    }
    if (!root) {
      root = document.createElement("div");
      root.className = "xr-root";
      root.dataset.xrHash = hash;
      textEl.insertAdjacentElement("afterend", root);
    }
    return root;
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

    // 1) 结果卡片容器：保持在推文正文之后，按哈希防串台
    ensureCardRoot(article, textEl, hash);

    // 2) 操作栏按钮：附加在 div[role="group"]（回复/转发/点赞一排）末尾
    const group = article.querySelector('div[role="group"]');
    if (!group || !group.isConnected) return;

    const existing = group.querySelector(":scope > .xr-act");
    if (existing && existing.dataset.xrHash === hash) return; // 已就位且文本未变
    if (existing) existing.remove(); // 文本已变化（虚拟化复用），重建以重置状态

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "xr-act";
    btn.dataset.xrHash = hash;
    btn.setAttribute("aria-label", "检查谣言");
    btn.title = "检查谣言 · X-Really";
    btn.innerHTML = ICON_SVG;
    btn.addEventListener("click", onTriggerClick);
    group.appendChild(btn);
  }

  // ---------- 检查流程 ----------

  async function onTriggerClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const btn = e.currentTarget;
    if (btn.classList.contains("xr-loading")) return;

    const article = btn.closest("article[data-testid='tweet']");
    const textEl = article && article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText.trim() : "";
    if (!text || !article) return;

    // 卡片容器以点击时刻的文本为准，避免闭包中的旧文本
    const root = ensureCardRoot(article, textEl, hashText(text));

    // 提取推文配图（若有），一并送入多模态分析
    const images = extractImageUrls(article);

    // 加载态：图标替换为旋转指示器
    btn.classList.add("xr-loading");
    btn.classList.remove("xr-v-rumor", "xr-v-suspected", "xr-v-credible", "xr-v-unknown");
    btn.innerHTML = '<span class="xr-spin"></span>';

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "CHECK_TEXT", text, images });
    } catch {
      resp = { ok: false, error: "扩展通信失败，请刷新页面重试" };
    }

    // 恢复图标 + 按判定结果着色（悬停 title 同步展示结论）
    btn.classList.remove("xr-loading");
    btn.innerHTML = ICON_SVG;
    if (resp && resp.ok) {
      const meta = XR_VERDICT_META[resp.result.verdict] || XR_VERDICT_META.suspected;
      btn.classList.add(meta.cls);
      btn.title = `X-Really：${meta.icon} ${meta.label}`;
    } else {
      btn.title = "检查失败：" + ((resp && resp.error) || "未知错误");
    }

    // 渲染结果卡片到推文正文下方
    const oldCard = root.querySelector(":scope > .xr-card");
    if (oldCard) oldCard.remove();
    root.appendChild(xrBuildCard(resp));
  }

  // ---------- 启动 ----------

  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(scan, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
})();
