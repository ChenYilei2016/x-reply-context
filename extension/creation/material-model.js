// 创作工作台的素材领域模型：统一结构、枚举规则、校验归一化、合并与派生指标。
// 所有渠道（bot feed、热榜、RSS）都先转换成这里定义的 Material。
(() => {
  "use strict";

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const LIMITS = Object.freeze({
    id: 300, title: 300, text: 10000, url: 2048, note: 200, lang: 16,
    handle: 50, authorName: 100, tags: 8, tag: 20, media: 4, snapshots: 8
  });
  /** 两次快照至少间隔 30 分钟，避免同一次浏览反复记录。 */
  const SNAPSHOT_INTERVAL = 30 * 60 * 1000;
  /** 刚发布的帖子按至少 15 分钟计算流速，避免分母过小。 */
  const MIN_VELOCITY_AGE = 15 * 60 * 1000;
  const METRIC_FIELDS = Object.freeze(["views", "likes", "reposts", "replies", "quotes", "bookmarks", "stars", "rank"]);

  class MaterialKind {
    static X_POST = new MaterialKind("x_post", "X 帖子");
    static ARTICLE = new MaterialKind("article", "文章");
    static HOT_TOPIC = new MaterialKind("hot_topic", "热榜");

    constructor(id, label) {
      this.id = id;
      this.label = label;
      Object.freeze(this);
    }

    static values() { return [MaterialKind.X_POST, MaterialKind.ARTICLE, MaterialKind.HOT_TOPIC]; }
    static from(id) { return MaterialKind.values().find(kind => kind.id === id); }
  }

  class Coverage {
    static TITLE = new Coverage("title", "仅标题", 0);
    static EXCERPT = new Coverage("excerpt", "摘要", 1);
    static FULL = new Coverage("full", "正文", 2);

    constructor(id, label, rank) {
      this.id = id;
      this.label = label;
      this.rank = rank;
      Object.freeze(this);
    }

    static values() { return [Coverage.TITLE, Coverage.EXCERPT, Coverage.FULL]; }
    static from(id) { return Coverage.values().find(coverage => coverage.id === id); }

    /** 没有声明完整度时按正文长度推断；渠道声明的值优先。 */
    static infer(text) { return text.trim().length >= 400 ? Coverage.FULL : text.trim() ? Coverage.EXCERPT : Coverage.TITLE; }

    richerThan(other) { return this.rank > other.rank; }
  }

  class MetricsSource {
    static CHANNEL_REPORTED = new MetricsSource("channel_reported", "渠道报告", 2);
    static RANK_ONLY = new MetricsSource("rank_only", "仅名次", 1);
    static NONE = new MetricsSource("none", "无指标", 0);

    constructor(id, label, trust) {
      this.id = id;
      this.label = label;
      this.trust = trust;
      Object.freeze(this);
    }

    static values() { return [MetricsSource.CHANNEL_REPORTED, MetricsSource.RANK_ONLY, MetricsSource.NONE]; }
    static from(id) { return MetricsSource.values().find(source => source.id === id); }

    /** 可信度更高的来源覆盖低的；同级时较新的覆盖旧的。 */
    replaces(other) { return this.trust >= other.trust; }
  }

  class MaterialCategory {
    static AI = new MaterialCategory("ai", "AI", ["AI"],
      /\b(?:AI|AGI|GPT|LLMs?|ChatGPT|Claude|Gemini|Grok|OpenAI|Anthropic|DeepSeek|Qwen|Kimi|Llama|Sora|Midjourney|Copilot|Cursor|Codex|Agents?)\b|人工智能|大模型|智能体|机器学习|深度学习|生成式|多模态|算力/i);
    static TECH = new MaterialCategory("tech", "科技", ["科技"],
      /\b(?:Apple|iPhone|iPad|Android|Google|Microsoft|NVIDIA|Tesla|SpaceX|Samsung|GPU|chips?)\b|苹果|华为|小米|芯片|手机|英伟达|特斯拉|半导体|微软|谷歌|安卓|鸿蒙|电动车|卫星/i);
    static PRODUCT = new MaterialCategory("product", "产品", ["产品"]);
    static OPEN_SOURCE = new MaterialCategory("open_source", "开源", ["开源"]);
    static HOT = new MaterialCategory("hot", "热点", ["热点"]);
    static ENTERTAINMENT = new MaterialCategory("entertainment", "娱乐", ["娱乐"]);
    static OTHER = new MaterialCategory("other", "其他", []);

    constructor(id, label, tags, keywords) {
      this.id = id;
      this.label = label;
      this.tags = Object.freeze(tags);
      this.keywords = keywords;
      Object.freeze(this);
    }

    static values() {
      return [MaterialCategory.AI, MaterialCategory.TECH, MaterialCategory.PRODUCT, MaterialCategory.OPEN_SOURCE,
        MaterialCategory.HOT, MaterialCategory.ENTERTAINMENT, MaterialCategory.OTHER];
    }
    static from(id) { return MaterialCategory.values().find(category => category.id === id); }

    /** bot 等渠道用中文标签声明分类，取第一个能识别的标签。 */
    static fromTags(tags) {
      for (const tag of tags) {
        const category = MaterialCategory.values().find(value => value.tags.includes(tag));
        if (category) return category;
      }
      return undefined;
    }

    /** 按关键词识别 AI、科技内容；识别不出时使用渠道默认分类。AI 优先，因为它是账号主方向。 */
    static classify(text, fallback = MaterialCategory.OTHER) {
      return [MaterialCategory.AI, MaterialCategory.TECH].find(category => category.keywords.test(text)) || fallback;
    }

    isUnclassified() { return this === MaterialCategory.OTHER; }
  }

  const MediaType = Object.freeze(["image", "video", "gif"]);

  // ---------- 校验与归一化 ----------

  const cleanString = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";

  function safeUrl(value) {
    if (typeof value !== "string" || value.length > LIMITS.url) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return "";
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/^utm_|^(?:fbclid|gclid)$/.test(key)) url.searchParams.delete(key);
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function timestamp(value) {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== "string" || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

  function normalizeMetrics(raw) {
    if (!raw || typeof raw !== "object") return null;
    const metrics = {};
    for (const field of METRIC_FIELDS) {
      const value = count(raw[field]);
      if (value !== undefined) metrics[field] = value;
    }
    return Object.keys(metrics).length ? metrics : null;
  }

  function normalizeAuthor(raw) {
    if (!raw || typeof raw !== "object") return null;
    const author = {
      handle: cleanString(raw.handle, LIMITS.handle).replace(/^@/, ""),
      name: cleanString(raw.name, LIMITS.authorName)
    };
    const followers = count(raw.followers);
    if (followers !== undefined) author.followers = followers;
    return author.handle || author.name ? author : null;
  }

  function normalizeMedia(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, LIMITS.media)
      .map(item => ({ type: MediaType.includes(item?.type) ? item.type : "", url: safeUrl(item?.url) }))
      .filter(item => item.type && item.url);
  }

  function normalizeTags(raw) {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map(tag => cleanString(tag, LIMITS.tag)).filter(Boolean))].slice(0, LIMITS.tags);
  }

  /**
   * 把渠道条目（xrc.feed/v1 的 item，或适配器产出的同结构对象）转换为 Material。
   * @param raw 条目
   * @param context { channelId, now, metricsSource, defaultCategory }
   * @returns {{material?: object, error?: string}}
   */
  function normalize(raw, context) {
    if (!raw || typeof raw !== "object") return { error: "条目不是对象" };
    const id = cleanString(raw.id, LIMITS.id);
    if (!id) return { error: "缺少 id" };
    const kind = MaterialKind.from(raw.kind);
    if (!kind) return { error: `未知类型 ${raw.kind}` };
    const url = safeUrl(raw.url);
    if (!url) return { error: "链接无效，只接受 HTTPS" };
    const title = cleanString(raw.title, LIMITS.title);
    const text = cleanString(raw.text, LIMITS.text);
    if (!title && !text) return { error: "标题和正文都为空" };

    const coverage = Coverage.from(raw.coverage) || Coverage.infer(text);
    const tags = normalizeTags(raw.tags);
    const declared = MaterialCategory.from(raw.category) || MaterialCategory.fromTags(tags);
    const category = declared || MaterialCategory.classify(`${title}\n${text}`, context.defaultCategory || MaterialCategory.OTHER);
    const metrics = normalizeMetrics(raw.metrics);
    const metricsSource = !metrics ? MetricsSource.NONE :
      Object.keys(metrics).every(field => field === "rank") ? MetricsSource.RANK_ONLY :
      context.metricsSource || MetricsSource.CHANNEL_REPORTED;
    const metricsAt = metrics ? timestamp(raw.metrics.observedAt) || context.now : null;

    return {
      material: {
        id, kind: kind.id, category: category.id, channelIds: [context.channelId],
        title, text, coverage: coverage.id, url, lang: cleanString(raw.lang, LIMITS.lang),
        author: normalizeAuthor(raw.author),
        publishedAt: timestamp(raw.publishedAt),
        firstSeenAt: context.now, lastSeenAt: context.now,
        metrics, metricsSource: metricsSource.id, metricsAt,
        snapshots: metrics?.views !== undefined ? [snapshot(metrics, metricsSource, metricsAt)] : [],
        media: normalizeMedia(raw.media), tags, note: cleanString(raw.note, LIMITS.note),
        own: raw.own === true, marks: {}
      }
    };
  }

  function snapshot(metrics, source, at) {
    return { at, source: source.id, ...metrics };
  }

  // ---------- 合并 ----------

  function mergeText(existing, incoming) {
    const oldCoverage = Coverage.from(existing.coverage);
    const newCoverage = Coverage.from(incoming.coverage);
    const incomingBetter = newCoverage.richerThan(oldCoverage) ||
      newCoverage === oldCoverage && incoming.text.length > existing.text.length;
    return incomingBetter ? { text: incoming.text, coverage: incoming.coverage } : { text: existing.text, coverage: existing.coverage };
  }

  function mergeSnapshots(existing, incoming) {
    const snapshots = [...existing.snapshots];
    for (const next of incoming.snapshots) {
      const last = snapshots.findLast(item => item.source === next.source);
      if (!last || next.at - last.at >= SNAPSHOT_INTERVAL) snapshots.push(next);
      else if (next.at > last.at) snapshots[snapshots.lastIndexOf(last)] = next;
    }
    return snapshots.sort((a, b) => a.at - b.at).slice(-LIMITS.snapshots);
  }

  function mergeMetrics(existing, incoming) {
    if (!incoming.metrics) return pick(existing);
    if (!existing.metrics) return pick(incoming);
    const oldSource = MetricsSource.from(existing.metricsSource);
    const newSource = MetricsSource.from(incoming.metricsSource);
    const newer = (incoming.metricsAt || 0) >= (existing.metricsAt || 0);
    const replace = newSource.trust > oldSource.trust || newSource === oldSource && newer;
    return pick(replace ? incoming : existing);

    function pick(source) {
      return { metrics: source.metrics, metricsSource: source.metricsSource, metricsAt: source.metricsAt };
    }
  }

  /** 同一 id 的素材再次出现时合并：内容取更完整的，指标取更可信或更新的，用户标记始终保留。 */
  function merge(existing, incoming) {
    if (!existing) return incoming;
    const author = existing.author || incoming.author ? { ...existing.author, ...incoming.author } : null;
    const category = MaterialCategory.from(existing.category).isUnclassified() ? incoming.category : existing.category;
    return {
      ...existing,
      ...mergeText(existing, incoming),
      ...mergeMetrics(existing, incoming),
      title: existing.title || incoming.title,
      lang: existing.lang || incoming.lang,
      category,
      channelIds: [...new Set([...existing.channelIds, ...incoming.channelIds])],
      author,
      publishedAt: existing.publishedAt || incoming.publishedAt,
      firstSeenAt: Math.min(existing.firstSeenAt, incoming.firstSeenAt),
      lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt),
      snapshots: mergeSnapshots(existing, incoming),
      media: existing.media.length ? existing.media : incoming.media,
      tags: [...new Set([...existing.tags, ...incoming.tags])].slice(0, LIMITS.tags),
      note: incoming.note || existing.note,
      own: existing.own || incoming.own,
      marks: existing.marks
    };
  }

  // ---------- 派生指标（只基于真实数据，缺数据返回 null） ----------

  /** 发布以来平均每小时浏览量。 */
  function velocity(material, now) {
    const views = material.metrics?.views;
    if (views === undefined || !material.publishedAt) return null;
    return views / (Math.max(now - material.publishedAt, MIN_VELOCITY_AGE) / HOUR);
  }

  /** 浏览量 ÷ 作者粉丝数，用于发现小号爆帖。 */
  function breakoutRatio(material) {
    const views = material.metrics?.views;
    const followers = material.author?.followers;
    if (views === undefined || !followers) return null;
    return views / followers;
  }

  /** 最近两次同来源快照之间每小时新增浏览量。 */
  function acceleration(material) {
    const withViews = material.snapshots.filter(item => item.views !== undefined);
    const last = withViews.at(-1);
    if (!last) return null;
    const previous = withViews.findLast(item => item !== last && item.source === last.source && last.at - item.at >= SNAPSHOT_INTERVAL);
    if (!previous) return null;
    return (last.views - previous.views) / ((last.at - previous.at) / HOUR);
  }

  // ---------- 保留策略 ----------

  const DEFAULT_RETENTION = Object.freeze({
    maxAge: 7 * DAY,
    ownMaxAge: 90 * DAY,
    lowSignalAfter: 2 * DAY,
    lowSignalViews: 1000,
    maxCount: 20000
  });

  /** 单条素材是否过期。收藏的永不过期；自己的帖子（feed 标记 own）保留更久，用于样本与复盘；低浏览的 X 帖子 48 小时后先清理。 */
  function isExpired(material, now, policy = DEFAULT_RETENTION) {
    if (material.marks?.saved) return false;
    const idle = now - material.lastSeenAt;
    if (material.own) return idle > policy.ownMaxAge;
    if (idle > policy.maxAge) return true;
    const lowSignal = material.kind === MaterialKind.X_POST.id && (material.metrics?.views ?? 0) < policy.lowSignalViews;
    return lowSignal && now - material.firstSeenAt > policy.lowSignalAfter;
  }

  globalThis.XReplyMaterialModel = Object.freeze({
    MaterialKind, Coverage, MetricsSource, MaterialCategory, LIMITS, SNAPSHOT_INTERVAL, DEFAULT_RETENTION,
    safeUrl, normalize, merge, velocity, breakoutRatio, acceleration, isExpired
  });
})();
