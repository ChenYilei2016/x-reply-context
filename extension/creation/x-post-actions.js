// X 页面帖子操作栏上的「改写」「选入」按钮（内容脚本，隔离环境）。
// 只在点击时读取被点的那一条帖子，交给后台写入素材库；不在后台读取或批量采集。可在扩展弹窗关闭。
(() => {
  "use strict";

  const SETTING = "creationPostActions";
  const ARTICLE = 'article[data-testid="tweet"]';
  const QUOTE = 'div[role="link"]';
  const ACTIONS_CLASS = "xrc-post-actions";
  const SCAN_DELAY = 300;
  const TOAST_MS = 2600;
  const reader = globalThis.XReplyXPostReader;

  let enabled = false;
  let scanTimer = 0;
  let toast = null;
  let toastTimer = 0;

  const actionBar = article => [...article.querySelectorAll('[role="group"]')].find(group => !group.closest(QUOTE)) || null;

  function showToast(text, error = false) {
    toast ||= Object.assign(document.createElement("div"), { className: "xrc-post-toast", role: "status" });
    if (!toast.isConnected) (document.body || document.documentElement).append(toast);
    toast.textContent = text;
    toast.dataset.error = String(error);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast?.remove(), TOAST_MS);
  }

  async function send(action, article) {
    const post = reader.read(article);
    if (!post) { showToast("没有读到这条帖子的正文或链接。", true); return; }
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "CREATION_PICK_POST", action, post });
    } catch {
      showToast("扩展已更新，请刷新本页后再试。", true);
      return;
    }
    if (!reply?.ok) { showToast(reply?.error || "写作台暂不可用。", true); return; }
    if (action === "rewrite") showToast("已带入写作台，选好风格后点「改写」。");
    else showToast(reply.alreadyPicked ? `这条已在已选素材里（${reply.basketCount}/3）。` : `已选入（${reply.basketCount}/3），可在写作台融合改写。`);
  }

  function button(action, label, title) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `xrc-post-action xrc-post-${action}`;
    node.textContent = label;
    node.title = title;
    node.setAttribute("aria-label", title);
    // 直接在按钮上拦截，避免 X 把点击当成打开帖子。
    node.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const article = node.closest(ARTICLE);
      if (article) void send(action, article);
    });
    return node;
  }

  function actions() {
    const container = document.createElement("span");
    container.className = ACTIONS_CLASS;
    container.append(
      button("rewrite", "改写", "用回过了写作台改写这条帖子"),
      button("pick", "选入", "选入写作台素材（最多 3 条，可融合改写）"));
    return container;
  }

  function decorate() {
    scanTimer = 0;
    if (!enabled) return;
    for (const article of document.querySelectorAll(ARTICLE)) {
      const bar = actionBar(article);
      if (bar && !bar.querySelector(`:scope > .${ACTIONS_CLASS}`)) bar.append(actions());
    }
  }

  function schedule() {
    if (enabled && !scanTimer) scanTimer = setTimeout(decorate, SCAN_DELAY);
  }

  function setEnabled(value) {
    enabled = value;
    if (enabled) schedule();
    else for (const node of document.querySelectorAll(`.${ACTIONS_CLASS}`)) node.remove();
  }

  new MutationObserver(records => {
    if (enabled && !scanTimer && records.some(record => record.addedNodes.length && !record.target.closest?.(`.${ACTIONS_CLASS}`))) schedule();
  }).observe(document, { childList: true, subtree: true });

  chrome.storage.local.get(SETTING).then(saved => setEnabled(saved[SETTING] !== false), () => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTING]) setEnabled(changes[SETTING].newValue !== false);
  });
})();
