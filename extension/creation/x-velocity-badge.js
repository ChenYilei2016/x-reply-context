// X 帖子流速标签（运行于 x.com 内容脚本）：在作者行末尾显示发布以来平均每小时浏览和爆文倍数，点击收藏为创作素材。
// 数据来自页面已加载的响应（observe.js 发出 CREATION_POST_METRICS），不额外请求 X。
(() => {
  "use strict";

  const CHANNEL = "x-reply-context-v1";
  const SETTING_KEY = "creationVelocityBadge";
  const CACHE_LIMIT = 3000;
  const RENDER_DELAY = 200;
  const HOUR = 60 * 60 * 1000;
  /** 与素材模型一致：刚发布的帖子按至少 15 分钟计算流速。 */
  const MIN_AGE = 15 * 60 * 1000;

  class VelocityTier {
    static SLOW = new VelocityTier("slow", "🌱", "起步", 0);
    static MEDIUM = new VelocityTier("medium", "🚀", "中速", 1000);
    static FAST = new VelocityTier("fast", "🔥", "高速", 10000);

    constructor(id, icon, label, minimum) {
      this.id = id;
      this.icon = icon;
      this.label = label;
      this.minimum = minimum;
      Object.freeze(this);
    }

    static values() { return [VelocityTier.FAST, VelocityTier.MEDIUM, VelocityTier.SLOW]; }
    static of(velocity) { return VelocityTier.values().find(tier => velocity >= tier.minimum); }
  }

  /** 标签内容；缺浏览量或发布时间时返回 null。 */
  function badgeContent(metrics, now, format) {
    const publishedAt = Date.parse(metrics.publishedAt);
    if (!Number.isFinite(metrics.views) || !Number.isFinite(publishedAt)) return null;
    const velocity = metrics.views / (Math.max(now - publishedAt, MIN_AGE) / HOUR);
    const tier = VelocityTier.of(velocity);
    const ratio = metrics.followers ? metrics.views / metrics.followers : null;
    const text = `${tier.icon} ${format.velocity(velocity)}${ratio !== null && ratio >= 1 ? ` · ${format.ratio(ratio)}粉` : ""}`;
    const title = [`${tier.label}：发布以来平均每小时浏览 ${format.count(velocity)}`, `浏览 ${format.count(metrics.views)}`,
      metrics.followers !== undefined ? `作者粉丝 ${format.count(metrics.followers)}` : "", "点击收藏为创作素材"].filter(Boolean).join(" · ");
    return { text, title, tier };
  }

  function tweetIdOf(article) {
    const href = article.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href") || "";
    return href.match(/\/status\/(\d{1,25})/)?.[1] || "";
  }

  /**
   * @param deps { document, window, chrome, format, clock }
   */
  function create({ document, window, chrome, format, clock = Date.now }) {
    const metrics = new Map();
    const saved = new Set();
    let enabled = true;
    let timer;

    function remember(posts) {
      for (const post of posts.slice(0, 500)) {
        if (typeof post?.id !== "string" || !post.id.startsWith("x:")) continue;
        metrics.delete(post.id);
        metrics.set(post.id, { views: post.views, publishedAt: post.publishedAt, followers: post.followers });
        if (metrics.size > CACHE_LIMIT) metrics.delete(metrics.keys().next().value);
      }
      schedule();
    }

    function schedule() {
      timer ??= setTimeout(() => { timer = undefined; render(); }, RENDER_DELAY);
    }

    function badgeFor(host, postId, content) {
      const existing = host.querySelector(":scope > .xrc-velocity");
      const isSaved = saved.has(postId);
      if (existing?.title === content.title && existing.dataset.saved === String(isSaved)) return;
      const badge = existing || document.createElement("button");
      if (!existing) {
        badge.type = "button";
        badge.className = "xrc-velocity";
        badge.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          void save(badge.dataset.postId);
        });
        host.append(badge);
      }
      badge.dataset.postId = postId;
      badge.dataset.tier = content.tier.id;
      badge.dataset.saved = String(isSaved);
      badge.textContent = content.text;
      badge.title = isSaved ? `${content.title}（已收藏）` : content.title;
      badge.setAttribute("aria-label", badge.title);
    }

    function render() {
      const now = clock();
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const host = article.querySelector('[data-testid="User-Name"]');
        if (!host) continue;
        const postId = tweetIdOf(article);
        const data = enabled && postId ? metrics.get(`x:${postId}`) : undefined;
        const content = data ? badgeContent(data, now, format) : null;
        if (content) badgeFor(host, postId, content);
        else host.querySelector(":scope > .xrc-velocity")?.remove();
      }
    }

    async function save(postId) {
      const result = await chrome.runtime.sendMessage({ type: "CREATION_SAVE_X_POST", postId }).catch(() => null);
      if (!result?.ok) return;
      saved.add(postId);
      render();
    }

    function start() {
      window.addEventListener("message", event => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.channel === CHANNEL && event.data.type === "CREATION_POST_METRICS" && Array.isArray(event.data.posts)) remember(event.data.posts);
      });
      new window.MutationObserver(() => { if (metrics.size) schedule(); }).observe(document.documentElement, { childList: true, subtree: true });
      void chrome.storage.local.get(SETTING_KEY).then(value => { enabled = value[SETTING_KEY] !== false; schedule(); });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[SETTING_KEY]) { enabled = changes[SETTING_KEY].newValue !== false; schedule(); }
      });
    }

    return { start, remember, render };
  }

  globalThis.XReplyVelocityBadge = Object.freeze({ VelocityTier, badgeContent, tweetIdOf, create, SETTING_KEY });
})();
