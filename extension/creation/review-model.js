// 复盘：已发草稿的数据（bot feed 中自己帖子的指标优先，其次手动录入）、发布 24 小时内的读数、按角度与形态统计。
(() => {
  "use strict";

  const HOUR = 60 * 60 * 1000;
  const FIRST_DAY = 24 * HOUR;
  const METRIC_FIELDS = Object.freeze(["views", "likes", "reposts", "replies"]);
  const NO_ANGLE = "none";
  const REWRITE_PREFIX = "rewrite:";

  /** 复盘分组：按角度写的用角度类型，改写的用“rewrite:风格”，都没有的归入未选角度。 */
  const approachOf = draft => draft.angle?.type || (draft.rewrite ? `${REWRITE_PREFIX}${draft.rewrite.style}` : NO_ANGLE);

  const MetricsOrigin = Object.freeze({
    FEED: Object.freeze({ id: "feed", label: "bot 汇报" }),
    MANUAL: Object.freeze({ id: "manual", label: "手动录入" })
  });

  function pickMetrics(source) {
    const metrics = {};
    for (const field of METRIC_FIELDS) if (Number.isFinite(source?.[field])) metrics[field] = source[field];
    return Object.keys(metrics).length ? metrics : null;
  }

  /** 发布后 24 小时内最后一次读到的浏览量（快照来自 bot feed）；没有这段时间的快照时为 null。 */
  function firstDayViews(material, publishedAt) {
    const inFirstDay = (material.snapshots || [])
      .filter(snapshot => Number.isFinite(snapshot.views) && snapshot.at >= publishedAt && snapshot.at <= publishedAt + FIRST_DAY);
    const last = inFirstDay.at(-1);
    return last ? { views: last.views, hours: Math.max(1, Math.round((last.at - publishedAt) / HOUR)) } : null;
  }

  /**
   * 用素材库中对应帖子的最新数据刷新草稿缓存（帖子素材 90 天后会被清理，草稿里保留最后一次读数）。
   * @returns 有变化时返回新草稿，否则返回原对象
   */
  function refresh(draft, material) {
    if (!draft.post || !material) return draft;
    const latest = pickMetrics(material.metrics);
    const metrics = latest ? { ...latest, observedAt: material.metricsAt || material.lastSeenAt } : draft.metrics;
    const views24h = firstDayViews(material, draft.post.publishedAt) || draft.views24h;
    if (JSON.stringify(metrics) === JSON.stringify(draft.metrics) && JSON.stringify(views24h) === JSON.stringify(draft.views24h)) return draft;
    return { ...draft, metrics, views24h };
  }

  /** 展示与统计用的数据：bot 汇报的优先，没有时用手动录入。 */
  function effectiveMetrics(draft) {
    if (draft.metrics) return { ...draft.metrics, origin: MetricsOrigin.FEED.id };
    if (draft.manualMetrics) return { ...draft.manualMetrics, origin: MetricsOrigin.MANUAL.id };
    return null;
  }

  function average(values) {
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  }

  function groupStats(entries, keyOf) {
    const groups = new Map();
    for (const entry of entries) {
      const key = keyOf(entry.draft);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    return [...groups.entries()].map(([key, items]) => {
      const views = items.map(item => item.metrics?.views).filter(Number.isFinite);
      const likes = items.map(item => item.metrics?.likes).filter(Number.isFinite);
      return { key, count: items.length, measured: views.length, avgViews: average(views), avgLikes: average(likes),
        bestViews: views.length ? Math.max(...views) : null };
    }).sort((a, b) => (b.avgViews ?? -1) - (a.avgViews ?? -1) || b.count - a.count);
  }

  /**
   * 按角度类型和帖子形态统计已发草稿。没有数据的帖子计入篇数，不计入平均值。
   * @returns {{ published, measured, avgViews, byAngle, byFormat }} byAngle 的 key 见 approachOf，byFormat 的 key 为形态 id
   */
  function summarize(drafts) {
    const entries = drafts.filter(draft => draft.status === "published").map(draft => ({ draft, metrics: effectiveMetrics(draft) }));
    const views = entries.map(entry => entry.metrics?.views).filter(Number.isFinite);
    return {
      published: entries.length, measured: views.length, avgViews: average(views),
      byAngle: groupStats(entries, approachOf),
      byFormat: groupStats(entries, draft => draft.format)
    };
  }

  /** 已发且有浏览数据的草稿 → 爆款样本候选（与 bot feed 中自己的帖子同一结构，按帖子 id 去重）。 */
  function asOwnPosts(drafts) {
    return drafts.filter(draft => draft.status === "published" && Number.isFinite(effectiveMetrics(draft)?.views)).map(draft => ({
      id: `x:${draft.post.id}`, kind: "x_post", own: true, text: draft.text,
      publishedAt: draft.post.publishedAt, metrics: { views: effectiveMetrics(draft).views }
    }));
  }

  globalThis.XReplyReviewModel = Object.freeze({ MetricsOrigin, NO_ANGLE, REWRITE_PREFIX, approachOf, firstDayViews, refresh, effectiveMetrics, summarize, asOwnPosts });
})();
