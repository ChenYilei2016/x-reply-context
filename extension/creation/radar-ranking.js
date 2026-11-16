// 选题雷达的话题摘要与排序。综合分是透明的启发式规则，界面上同时展示各项原始指标，不虚构“爆文指数”。
(() => {
  "use strict";

  const HOUR = 60 * 60 * 1000;
  const TITLE_LIMIT = 80;

  /** 素材热度，只用于聚合时决定锚点顺序：X 帖子用流速，热榜用名次。 */
  function materialHeat(material, now, model) {
    const velocity = model.velocity(material, now);
    if (velocity !== null) return velocity;
    const rank = material.metrics?.rank;
    return rank ? 1000 / rank : 0;
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
   * 综合分（越大越值得写）：
   *  跨渠道印证 1.5×(来源数−1) + X 流速 log10(1+每小时浏览) + 热榜名次（第 1 名 2.5 分，约第 46 名降到 0）
   *  + 爆文倍数 log10(1+倍数)（上限 2）+ 新鲜度（6 小时内 1，24 小时内 0.5）
   */
  function compositeScore(summary, now) {
    const corroboration = 1.5 * (summary.sourceCount - 1);
    const velocity = summary.maxVelocity ? Math.log10(1 + summary.maxVelocity) : 0;
    const rank = summary.bestRank ? Math.max(0, 2.5 - 1.5 * Math.log10(summary.bestRank)) : 0;
    const breakout = summary.maxBreakout ? Math.min(2, Math.log10(1 + summary.maxBreakout)) : 0;
    const age = now - summary.latestAt;
    const freshness = age <= 6 * HOUR ? 1 : age <= 24 * HOUR ? 0.5 : 0;
    return corroboration + velocity + rank + breakout + freshness;
  }

  /**
   * 把聚合结果整理成界面用的话题摘要。
   * @param topic { leader, members }
   */
  function summarize(topic, now, model) {
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
      usedAt: maxOf(members.map(member => member.marks?.usedAt))
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
    const topics = cluster(materials, { heat: material => materialHeat(material, now, model) });
    return topics.map(topic => summarize(topic, now, model)).sort((a, b) => sort.compare(a, b));
  }

  globalThis.XReplyRadarRanking = Object.freeze({ RadarSort, rank, summarize, compositeScore, materialHeat });
})();
