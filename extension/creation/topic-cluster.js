// 话题聚合：把不同渠道里讲同一件事的素材合并成一个话题。
// 做法：中文按双字切分、英文/型号按词切分，用批内逆文档频率加权；
// 热榜、新闻标题优先作为话题锚点，后续素材只与锚点比较（避免 A≈B≈C 链式误并），且时间相差不超过 48 小时。
// 本文件不含排序策略，热度由调用方传入。
(() => {
  "use strict";

  const WINDOW = 48 * 60 * 60 * 1000;
  /**
   * 与锚点的加权重合度阈值（按较短一方计算）。
   * 2026-11-16 用 9 个渠道 234 条实拉素材校准：0.35 合并同一热点且无误并；0.30 起出现只共享一个词的误并。
   */
  const SIMILARITY_THRESHOLD = 0.35;
  /** 至少共享的词数，避免只靠一个泛词合并。 */
  const MIN_SHARED_TOKENS = 2;
  /** X 帖子只取开头部分参与匹配，长帖的后文多是展开论述。 */
  const POST_MATCH_CHARS = 140;
  /** 批内过半素材都有的词视为泛词，不参与匹配。 */
  const COMMON_RATIO = 0.2;

  const STOP_BIGRAMS = new Set([
    "发布", "宣布", "表示", "消息", "今天", "今日", "最新", "官方", "回应", "正式", "网友", "曝光", "热议", "一个", "我们",
    "他们", "你们", "什么", "如何", "为何", "怎么", "这个", "那个", "没有", "已经", "可以", "就是", "还是", "不是", "真的",
    "时候", "现在", "目前", "相关", "进行", "推出", "上线", "全新", "首次", "终于", "如果", "因为", "所以", "但是", "而且"
  ]);
  const STOP_WORDS = new Set([
    "the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "is", "are", "be", "was", "it", "its", "this", "that",
    "at", "by", "from", "as", "has", "have", "will", "can", "now", "just", "new", "how", "why", "what", "you", "your", "we", "our",
    "i", "my", "me", "they", "their", "about", "into", "more", "than", "not", "no", "so", "if", "but", "all", "out", "up", "rt",
    "via", "here", "there", "one", "get", "got", "today", "show", "hn"
  ]);

  /** 匹配用文本：热榜、文章用标题（无标题时用正文开头），X 帖子用正文开头。 */
  function matchText(material) {
    if (material.kind === "x_post") return material.text.slice(0, POST_MATCH_CHARS);
    return material.title || material.text.slice(0, POST_MATCH_CHARS);
  }

  /** 切分为去重后的词集合：中文双字 + 英文词/型号（保留 gpt-5.2、c++ 这类形式）。 */
  function tokenize(text) {
    const tokens = new Set();
    const clean = text.replace(/https?:\/\/\S+/g, " ").replace(/[@#][\w一-鿿]+/g, match => ` ${match.slice(1)} `);
    for (const run of clean.match(/[一-鿿]{2,}/g) || []) {
      for (let index = 0; index < run.length - 1; index++) {
        const bigram = run.slice(index, index + 2);
        if (!STOP_BIGRAMS.has(bigram)) tokens.add(bigram);
      }
    }
    for (const raw of clean.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*[a-z0-9+#]|[a-z0-9]/g) || []) {
      const word = raw.replace(/\.+$/, "");
      if (word.length < 2 || STOP_WORDS.has(word) || /^\d{1,3}$/.test(word)) continue;
      tokens.add(word);
    }
    return tokens;
  }

  const materialTime = material => material.publishedAt || material.firstSeenAt;

  /** 加权重合度：共享词权重之和 ÷ 较短一方的权重之和。 */
  function similarity(a, b, weight) {
    let shared = 0, count = 0, totalA = 0, totalB = 0;
    for (const token of a) totalA += weight(token);
    for (const token of b) {
      const value = weight(token);
      totalB += value;
      if (a.has(token)) { shared += value; if (value > 0) count++; }
    }
    const base = Math.min(totalA, totalB);
    return { score: base > 0 ? shared / base : 0, count };
  }

  /** 锚点优先级：热榜 > 文章 > X 帖子；同类按热度降序。 */
  const KIND_PRIORITY = Object.freeze({ hot_topic: 0, article: 1, x_post: 2 });

  /**
   * 聚合素材为话题。
   * @param materials 素材数组（同一窗口内，已由调用方限量）
   * @param options.heat (material) => number，越大越热，用于选锚点顺序
   * @returns {{ leader, members }[]} 话题数组，members 含 leader
   */
  function cluster(materials, { heat = () => 0 } = {}) {
    const entries = materials.map(material => ({ material, tokens: tokenize(matchText(material)), heat: heat(material) }));
    const documentFrequency = new Map();
    for (const { tokens } of entries) for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    const total = entries.length;
    const commonLimit = total >= 50 ? total * COMMON_RATIO : Infinity;
    const weight = token => {
      const frequency = documentFrequency.get(token) || 1;
      return frequency > commonLimit ? 0 : Math.log(1 + total / frequency);
    };

    entries.sort((a, b) => (KIND_PRIORITY[a.material.kind] ?? 3) - (KIND_PRIORITY[b.material.kind] ?? 3) || b.heat - a.heat);
    const topics = [];
    const index = new Map();
    for (const entry of entries) {
      const candidates = new Set();
      for (const token of entry.tokens) if (weight(token) > 0) for (const topic of index.get(token) || []) candidates.add(topic);
      let best = null;
      for (const topic of candidates) {
        if (Math.abs(materialTime(topic.leader.material) - materialTime(entry.material)) > WINDOW) continue;
        const { score, count } = similarity(topic.leader.tokens, entry.tokens, weight);
        if (score >= SIMILARITY_THRESHOLD && count >= MIN_SHARED_TOKENS && (!best || score > best.score)) best = { topic, score };
      }
      if (best) {
        best.topic.members.push(entry.material);
        continue;
      }
      const topic = { leader: entry, members: [entry.material] };
      topics.push(topic);
      for (const token of entry.tokens) {
        if (!index.has(token)) index.set(token, []);
        index.get(token).push(topic);
      }
    }
    return topics.map(topic => ({ leader: topic.leader.material, members: topic.members }));
  }

  globalThis.XReplyTopicCluster = Object.freeze({ cluster, tokenize, matchText, SIMILARITY_THRESHOLD, WINDOW });
})();
