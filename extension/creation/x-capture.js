// X 浏览采集（运行于 x.com 页面 MAIN world）。
// 从页面已经加载的 GraphQL 帖子节点中提取正文、作者粉丝和互动指标，转换为 xrc.feed/v1 条目，
// 合批后交给 observe.js 发送。不发起任何额外的 X 请求。
(() => {
  "use strict";

  const FLUSH_INTERVAL = 5000;
  const BATCH_SIZE = 200;
  const MEDIA_TYPES = Object.freeze({ photo: "image", video: "video", animated_gif: "gif" });

  const count = value => {
    const number = typeof value === "string" ? Number(value) : value;
    return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
  };

  /** 去掉正文末尾 X 自动附加的媒体短链。 */
  const stripTrailingShortLinks = text => text.replace(/(?:\s*https:\/\/t\.co\/\w+)+\s*$/u, "").trim();

  function authorOf(node) {
    const user = node.core?.user_results?.result;
    if (!user) return null;
    const handle = user.core?.screen_name || user.legacy?.screen_name;
    if (!handle) return null;
    return {
      handle,
      name: user.core?.name || user.legacy?.name || "",
      followers: count(user.legacy?.followers_count) ?? count(user.relationship_counts?.followers)
    };
  }

  function metricsOf(node, legacy, now) {
    const views = node.views?.state === "EnabledWithCount" ? count(node.views.count) : undefined;
    const metrics = {
      views, likes: count(legacy.favorite_count), reposts: count(legacy.retweet_count),
      replies: count(legacy.reply_count), quotes: count(legacy.quote_count), bookmarks: count(legacy.bookmark_count)
    };
    return Object.values(metrics).some(value => value !== undefined) ? { ...metrics, observedAt: new Date(now).toISOString() } : undefined;
  }

  function mediaOf(legacy) {
    const media = legacy.extended_entities?.media || legacy.entities?.media;
    if (!Array.isArray(media)) return [];
    return media.slice(0, 4)
      .map(item => ({ type: MEDIA_TYPES[item?.type], url: item?.media_url_https }))
      .filter(item => item.type && typeof item.url === "string");
  }

  /**
   * 把 core.extract 识别出的帖子及其原始节点转换为素材条目。
   * 回复不作为选题素材（含自己的回复），只采集独立帖子和引用帖。
   * @returns feed item，或 null
   */
  function postFromNode(tweet, node, now) {
    const legacy = node?.legacy;
    if (!legacy || tweet.parentId) return null;
    const author = authorOf(node);
    const publishedAt = Date.parse(legacy.created_at);
    if (!author || !Number.isFinite(publishedAt)) return null;
    const text = stripTrailingShortLinks(tweet.text || "");
    const media = mediaOf(legacy);
    if (!text && !media.length) return null;
    return {
      id: `x:${tweet.id}`, kind: "x_post", coverage: "full",
      url: `https://x.com/${author.handle}/status/${tweet.id}`,
      text, lang: typeof legacy.lang === "string" ? legacy.lang : "",
      publishedAt: new Date(publishedAt).toISOString(),
      author, metrics: metricsOf(node, legacy, now), media
    };
  }

  /**
   * 合批收集器。同一帖子在一批内只保留最新一次。
   * @param send (posts) => boolean，返回 false 表示暂时不能发送（页面桥接未就绪），条目保留到下次
   */
  function createCollector({ send, clock = Date.now, schedule = setTimeout }) {
    const pending = new Map();
    /** 供页面流速标签即时显示的精简指标；入库仍按批次。 */
    const display = new Map();
    let timer;

    function flush() {
      timer = undefined;
      while (pending.size) {
        const batch = [...pending.values()].slice(0, BATCH_SIZE);
        if (!send(batch)) break;
        for (const post of batch) pending.delete(post.id);
      }
      if (pending.size) timer = schedule(flush, FLUSH_INTERVAL);
    }

    function add(tweet, node) {
      const post = postFromNode(tweet, node, clock());
      if (!post) return;
      pending.set(post.id, post);
      if (post.metrics?.views !== undefined) {
        display.set(post.id, { id: post.id, views: post.metrics.views, publishedAt: post.publishedAt, followers: post.author.followers });
      }
      timer ??= schedule(flush, FLUSH_INTERVAL);
    }

    /** 取出自上次以来新增的展示数据。 */
    function takeDisplay() {
      const posts = [...display.values()];
      display.clear();
      return posts;
    }

    return { add, flush, takeDisplay, size: () => pending.size };
  }

  globalThis.XReplyXCapture = Object.freeze({ postFromNode, createCollector, FLUSH_INTERVAL, BATCH_SIZE });
})();
