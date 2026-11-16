// 选题雷达的话题摘要与排序。综合分是透明的启发式规则，界面上同时展示各项原始指标，不虚构“爆文指数”。
(() => {
  "use strict";

  const HOUR = 60 * 60 * 1000;
  const TITLE_LIMIT = 80;

  /**
   * 账号定位权重（小娱乐、大 AI 科技）：综合分按话题分类加权。
   * 只影响“综合”排序；其他排序方式按原始指标。
   */
  const FOCUS_WEIGHTS = Object.freeze({ ai: 1, tech: 0.9, product: 0.85, open_source: 0.85, hot: 0.7, entertainment: 0.6, other: 0.5 });

  /**
   * 素材在本渠道内的热度，按 [层级, 数值] 比较：有流速用流速，其次热榜名次，否则按发布时间。
   * 不同渠道的数值单位不同（B站播放量与 X 帖子浏览量不可比），因此只在同一渠道内比较。
   */
  function materialHeat(material, now, model) {
    const velocity = model.velocity(material, now);
    if (velocity !== null) return [2, velocity];
    const rank = material.metrics?.rank;
    if (rank) return [1, -rank];
    return [0, material.publishedAt || material.firstSeenAt];
  }

  const compareHeat = (a, b) => b[0] - a[0] || b[1] - a[1];

  /** 每条素材在其主渠道内的百分位（1 为本渠道最热），用于跨渠道公平比较。 */
  function channelPercentiles(materials, now, model) {
    const byChannel = new Map();
    for (const material of materials) {
      const channel = material.channelIds[0];
      if (!byChannel.has(channel)) byChannel.set(channel, []);
      byChannel.get(channel).push({ material, heat: materialHeat(material, now, model) });
    }
    const percentiles = new Map();
    for (const entries of byChannel.values()) {
      entries.sort((a, b) => compareHeat(a.heat, b.heat));
      entries.forEach((entry, index) => percentiles.set(entry.material.id, (entries.length - index) / entries.length));
    }
    return percentiles;
  }

  const maxOf = values => {
    const present = values.filter(value => value !== null && value !== undefined);
    return present.length ? Math.max(...present) : null;
  };

  function topicTitle(leader) {
    const text = leader.title || leader.text.split("\n").find(line => line.trim()) || leader.text;
    return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT)}…` : text;
  }

  function topicCategory(leader, members, model) {
    if (!model.MaterialCategory.from(leader.category).isUnclassified()) return leader.category;
    return members.find(member => !model.MaterialCategory.from(member.category).isUnclassified())?.category || leader.category;
  }

  /**
   * 综合分（越大越值得写）＝ 定位权重 ×（3×渠道内热度百分位 + 1.5×(来源数−1) + 爆文倍数 log10(1+倍数)（上限 2）+ 新鲜度）
   * 新鲜度：6 小时内 1，24 小时内 0.5。
   */
  function compositeScore(summary, now) {
    const channelTop = 3 * summary.channelTop;
    const corroboration = 1.5 * (summary.sourceCount - 1);
    const breakout = summary.maxBreakout ? Math.min(2, Math.log10(1 + summary.maxBreakout)) : 0;
    const age = now - summary.latestAt;
    const freshness = age <= 6 * HOUR ? 1 : age <= 24 * HOUR ? 0.5 : 0;
    return (FOCUS_WEIGHTS[summary.category] ?? FOCUS_WEIGHTS.other) * (channelTop + corroboration + breakout + freshness);
  }

  /**
   * 把聚合结果整理成界面用的话题摘要。
   * @param topic { leader, members }
   * @param percentiles channelPercentiles 的结果
   */
  function summarize(topic, now, model, percentiles = new Map()) {
    const { leader } = topic;
    const velocityOf = member => model.velocity(member, now);
    const members = [...topic.members].sort((a, b) =>
      (velocityOf(b) ?? -1) - (velocityOf(a) ?? -1) || (a.metrics?.rank ?? Infinity) - (b.metrics?.rank ?? Infinity));
    const channelIds = [...new Set(members.flatMap(member => member.channelIds))];
    const summary = {
      id: leader.id,
      title: topicTitle(leader),
      category: topicCategory(leader, members, model),
      leader, members, channelIds,
      sourceCount: channelIds.length,
      xPostCount: members.filter(member => member.kind === "x_post").length,
      maxViews: maxOf(members.map(member => member.metrics?.views)),
      maxVelocity: maxOf(members.map(velocityOf)),
      maxBreakout: maxOf(members.map(member => model.breakoutRatio(member))),
      maxAcceleration: maxOf(members.map(member => model.acceleration(member))),
      bestRank: members.reduce((best, member) => member.metrics?.rank ? Math.min(best ?? Infinity, member.metrics.rank) : best, null),
      latestAt: Math.max(...members.map(member => member.publishedAt || member.firstSeenAt)),
      saved: members.some(member => member.marks?.saved),
      usedAt: maxOf(members.map(member => member.marks?.usedAt)),
      channelTop: maxOf(members.map(member => percentiles.get(member.id))) ?? 0
    };
    summary.score = compositeScore(summary, now);
    return summary;
  }

  class RadarSort {
    static COMPOSITE = new RadarSort("composite", "综合", summary => summary.score);
    static VELOCITY = new RadarSort("velocity", "流速", summary => summary.maxVelocity);
    static BREAKOUT = new RadarSort("breakout", "爆文倍数", summary => summary.maxBreakout);
    static SOURCES = new RadarSort("sources", "来源数", summary => summary.sourceCount);
    static LATEST = new RadarSort("latest", "最新", summary => summary.latestAt);

    constructor(id, label, key) {
      this.id = id;
      this.label = label;
      this.key = key;
      Object.freeze(this);
    }

    static values() { return [RadarSort.COMPOSITE, RadarSort.VELOCITY, RadarSort.BREAKOUT, RadarSort.SOURCES, RadarSort.LATEST]; }
    static from(id) { return RadarSort.values().find(sort => sort.id === id) || RadarSort.COMPOSITE; }

    /** 降序；缺少该指标的话题排在后面，再按综合分。 */
    compare(a, b) {
      const left = this.key(a), right = this.key(b);
      if ((left === null) !== (right === null)) return left === null ? 1 : -1;
      return (right ?? 0) - (left ?? 0) || b.score - a.score;
    }
  }

  /** 聚合 + 摘要 + 排序的完整流程。 */
  function rank(materials, { now, sort = RadarSort.COMPOSITE, model, cluster }) {
    const percentiles = channelPercentiles(materials, now, model);
    const topics = cluster(materials, { heat: material => percentiles.get(material.id) });
    return topics.map(topic => summarize(topic, now, model, percentiles)).sort((a, b) => sort.compare(a, b));
  }

  globalThis.XReplyRadarRanking = Object.freeze({ RadarSort, rank, summarize, compositeScore, materialHeat, channelPercentiles, FOCUS_WEIGHTS });
})();
