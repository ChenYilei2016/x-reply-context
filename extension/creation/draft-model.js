// 成稿：帖子形态、人设与爆款样本、3 个候选的提示词构建与结果解析。
(() => {
  "use strict";

  const prompt = globalThis.XReplyComposePrompt;
  const { AngleType } = globalThis.XReplyAngleModel;

  const DAY = 24 * 60 * 60 * 1000;
  const CANDIDATE_COUNT = 3;
  const DRAFT_TEXT_LIMIT = 4000;
  const INSTRUCTIONS_LIMIT = 500;
  const SAMPLE_LIMITS = Object.freeze({ count: 5, text: 600, ownWindow: 60 * DAY });

  /** 默认人设：只写账号定位，不含任何个人信息；用户可在工作台修改。 */
  const DEFAULT_PERSONA = [
    "你在为一个中文 X 账号写帖子，账号定位是「小娱乐、大 AI 科技」：用轻松、有梗但不油腻的口吻聊 AI、科技和产品。",
    "观点鲜明，敢下判断，但不夸大、不标题党；像懂行的朋友聊天，不像新闻通稿或客服。",
    "不虚构亲身经历，不冒充业内人士，不攻击个人。"
  ].join("\n");

  const FORMATS = Object.freeze([
    Object.freeze({
      id: "short_opinion", label: "中短帖观点", min: 150, max: 400, quotesSource: false,
      guide: "一条独立的观点帖：第一句是钩子，随后给出事实依据和你的判断，结尾可以留一个让人想回复的问题。"
    }),
    Object.freeze({
      id: "quote", label: "引用转发", min: 50, max: 150, quotesSource: true,
      guide: "引用原帖发表看法：不复述原帖，直接给出态度、补充信息或反差点。正文里不要放原帖链接，发布时会附上。"
    })
  ]);

  const PostFormat = Object.freeze({
    values: () => FORMATS,
    from: id => FORMATS.find(format => format.id === id),
    DEFAULT: FORMATS[0],
    /** 引用转发附上的原帖：优先选中素材里的 X 帖子，其次第一条素材。 */
    quoteTarget(format, materials) {
      if (!format.quotesSource || !materials.length) return null;
      return (materials.find(material => material.kind === "x_post") || materials[0]).url;
    }
  });

  // ---------- 爆款样本 ----------

  /**
   * 选出发给模型的样本：手动样本在前（视为置顶），再补自己近 60 天浏览最高的帖子（feed 标记 own），排除用户排除的。
   * @param options.manual [{ id, text }] 手动粘贴的样本
   * @param options.own 素材库里 own 为 true 的素材
   * @param options.excluded 被排除的素材 id
   * @returns [{ id, text, origin: "manual" | "own", views? }]
   */
  function selectSamples({ manual = [], own = [], excluded = [], now = Date.now() } = {}) {
    const skip = new Set(excluded);
    const manualSamples = manual.filter(sample => sample?.text?.trim())
      .map(sample => ({ id: sample.id, text: sample.text.trim().slice(0, SAMPLE_LIMITS.text), origin: "manual" }));
    const ownSamples = own
      .filter(material => material.own && material.kind === "x_post" && material.text && !skip.has(material.id) &&
        now - (material.publishedAt || material.firstSeenAt) <= SAMPLE_LIMITS.ownWindow)
      .sort((a, b) => (b.metrics?.views ?? -1) - (a.metrics?.views ?? -1))
      .map(material => ({ id: material.id, text: material.text.slice(0, SAMPLE_LIMITS.text), origin: "own", views: material.metrics?.views }));
    return [...manualSamples, ...ownSamples].slice(0, SAMPLE_LIMITS.count);
  }

  // ---------- 请求 ----------

  function checkAngle(angle) {
    if (angle === undefined || angle === null) return null;
    const type = AngleType.from(angle.type);
    const hook = typeof angle.hook === "string" ? angle.hook.trim().slice(0, 120) : "";
    if (!type || !hook) throw new Error("所选角度无效，请重新选择。");
    return { type, hook, outline: prompt.stringList(angle.outline, 4, 120) };
  }

  function checkSamples(samples) {
    if (samples === undefined) return [];
    if (!Array.isArray(samples) || samples.length > SAMPLE_LIMITS.count) throw new Error(`样本最多 ${SAMPLE_LIMITS.count} 条。`);
    return samples.filter(text => typeof text === "string" && text.trim()).map(text => text.trim().slice(0, SAMPLE_LIMITS.text));
  }

  function checkInstructions(value) {
    if (value === undefined) return "";
    if (typeof value !== "string" || value.length > INSTRUCTIONS_LIMIT) throw new Error(`附加要求最多 ${INSTRUCTIONS_LIMIT} 字。`);
    return value.trim();
  }

  function angleLines(angle) {
    if (!angle) return [];
    return [
      `本次角度：${angle.type.label}。参考钩子：${angle.hook}`,
      ...(angle.outline.length ? [`提纲：${angle.outline.map((item, index) => `${index + 1}. ${item}`).join("；")}`] : []),
      "按这个角度写，钩子可以改写得更有力。"
    ];
  }

  const outputFormat = () =>
    `只输出 <reply>{"drafts":[{"hook_style":"","text":""}]}</reply>，drafts 恰好 ${CANDIDATE_COUNT} 条，hook_style 用几个字说明开头手法，text 是完整正文；reply 内是合法 JSON，不要输出其他内容。`;

  /**
   * 构建成稿请求（后台调用，输入来自页面，需要校验）。
   * @param input { materials, format, persona, angle?, samples?, instructions? }
   */
  function buildRequest(input, now = Date.now()) {
    const materials = prompt.checkMaterials(input?.materials);
    const format = PostFormat.from(input?.format);
    if (!format) throw new Error("请选择帖子形态。");
    const persona = prompt.checkPersona(input.persona);
    const angle = checkAngle(input.angle);
    const samples = checkSamples(input.samples);
    const instructions = checkInstructions(input.instructions);
    const task = [
      `任务：根据 <materials> 写 ${CANDIDATE_COUNT} 条可以直接发在 X 上的「${format.label}」候选，每条约 ${format.min}～${format.max} 字。`,
      format.guide,
      `${CANDIDATE_COUNT} 条的开头要用不同手法（例如提问、反差、数字、场景），正文不要互相复制。`,
      ...angleLines(angle),
      "X 时间线只显示前约 140 个汉字（280 加权字符），钩子和核心信息必须放在这之前。",
      "话题标签最多 1 个，不堆 emoji，不用“家人们”“震惊”这类营销腔。",
      ...(samples.length ? ["<samples> 是我过去表现好的帖子，只学习语气、节奏和排版，不照搬内容和观点。"] : []),
      ...(instructions ? [`本次要求：${instructions}`] : [])
    ].join("\n");
    const content = ["<materials>", ...materials.map(prompt.materialXml), "</materials>"];
    if (samples.length) content.push("<samples>", ...samples.map(text => `<sample>${prompt.xml(text)}</sample>`), "</samples>");
    return {
      prompt: [prompt.nowLine(now), persona, task, prompt.SHARED_RULES, outputFormat()].join("\n\n"),
      content: content.join("\n")
    };
  }

  // ---------- 结果 ----------

  /** 去掉模型常加的整段引号。 */
  const unquote = text => text.replace(/^[“"「](.*)[”"」]$/s, "$1").trim();

  /** 解析候选：去空、去重，最多 3 条；一条都没有时报错。 */
  function parse(text) {
    const data = prompt.extractJson(text);
    const list = Array.isArray(data) ? data : data?.drafts;
    if (!Array.isArray(list)) throw new Error("模型返回的结果里没有候选稿，请重试。");
    const seen = new Set();
    const drafts = [];
    for (const raw of list) {
      const body = typeof raw === "string" ? raw : raw?.text;
      if (typeof body !== "string") continue;
      const value = unquote(body.trim()).slice(0, DRAFT_TEXT_LIMIT);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const hookStyle = typeof raw?.hook_style === "string" ? raw.hook_style.trim().slice(0, 20) : "";
      drafts.push({ hookStyle, text: value });
      if (drafts.length >= CANDIDATE_COUNT) break;
    }
    if (!drafts.length) throw new Error("模型没有返回可用的候选稿，请重试或换一个模型。");
    return drafts;
  }

  globalThis.XReplyDraftModel = Object.freeze({
    PostFormat, DEFAULT_PERSONA, CANDIDATE_COUNT, SAMPLE_LIMITS, INSTRUCTIONS_LIMIT, selectSamples, buildRequest, parse
  });
})();
