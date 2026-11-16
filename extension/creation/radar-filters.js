// 选题雷达的筛选规则：分类、素材类型、关键词与视图（全部／收藏／已隐藏）。
(() => {
  "use strict";

  class RadarView {
    static ALL = new RadarView("all", "全部话题");
    static SAVED = new RadarView("saved", "我的收藏");
    static HIDDEN = new RadarView("hidden", "已隐藏");

    constructor(id, label) {
      this.id = id;
      this.label = label;
      Object.freeze(this);
    }

    static values() { return [RadarView.ALL, RadarView.SAVED, RadarView.HIDDEN]; }
    static from(id) { return RadarView.values().find(view => view.id === id) || RadarView.ALL; }

    /** 按视图挑出参与聚合的素材：隐藏的素材只出现在“已隐藏”视图。 */
    includesMaterial(material) {
      const hidden = Boolean(material.marks?.hidden);
      return this === RadarView.HIDDEN ? hidden : !hidden;
    }

    includesTopic(topic) {
      return this !== RadarView.SAVED || topic.saved;
    }
  }

  /**
   * @param topic 话题摘要
   * @param filters { category: id|"all", kind: id|"all", query: string, view: RadarView }
   */
  function matchesTopic(topic, { category = "all", kind = "all", query = "", view = RadarView.ALL }) {
    if (!view.includesTopic(topic)) return false;
    if (category !== "all" && topic.category !== category) return false;
    if (kind !== "all" && !topic.members.some(member => member.kind === kind)) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return topic.members.some(member => `${member.title}\n${member.text}\n${member.author?.handle || ""}`.toLowerCase().includes(needle));
  }

  /** 各分类的话题数，用于标签上的数字。 */
  function countByCategory(topics) {
    const counts = { all: topics.length };
    for (const topic of topics) counts[topic.category] = (counts[topic.category] || 0) + 1;
    return counts;
  }

  globalThis.XReplyRadarFilters = Object.freeze({ RadarView, matchesTopic, countByCategory });
})();
