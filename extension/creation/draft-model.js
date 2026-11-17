// 成稿：帖子形态、人设与爆款样本、3 个候选的提示词构建与结果解析。
(() => {
  "use strict";

  const prompt = globalThis.XReplyComposePrompt;
  const { AngleType } = globalThis.XReplyAngleModel;

  const DAY = 24 * 60 * 60 * 1000;
  const CANDIDATE_COUNT = 3;
  const DRAFT_TEXT_LIMIT = 4000;
  const SAMPLE_LIMITS = Object.freeze({ ...prompt.SAMPLE_LIMITS, ownWindow: 60 * DAY });

  /**
   * 默认人设：角色、读者、口吻、立场四件事，不含任何个人信息；用户可在写作台修改。
   * 事实与安全约束在固定规则里，这里不重复。
   */
  const DEFAULT_PERSONA = [
    "你是一个中文 X（推特）账号的主笔。账号定位「小娱乐、大 AI 科技」：用好玩、好懂的方式讲 AI 和科技圈正在发生的事。",
    "读者是关注 AI 的中文用户，有从业者，也有爱尝鲜的普通人。他们刷时间线很快，一条帖子只给一两秒，所以第一句必须让人停下来。",
    "口吻像一个懂行、说话直接、偶尔毒舌的朋友：口语、短句、有判断；可以玩梗和自嘲，但不油腻、不端着、不堆术语。",
    "帖子以账号主人「我」的口吻发布。",
    "立场：观点敢下判断，事实保持原有的确定程度，也坦白不确定的地方；不吹不黑，不制造焦虑，不攻击个人。"
  ].join("\n");
  /** 之前版本的默认人设：用户没改过时（存的仍是旧默认值）自动换成新的默认人设。 */
  const PREVIOUS_PERSONAS = Object.freeze([[
    "你是一个中文 X（推特）账号的主笔。账号定位「小娱乐、大 AI 科技」：用好玩、好懂的方式讲 AI 和科技圈正在发生的事。",
    "读者是关注 AI 的中文用户，有从业者，也有爱尝鲜的普通人。他们刷时间线很快，一条帖子只给一两秒，所以第一句必须让人停下来。",
    "口吻像一个懂行、说话直接、偶尔毒舌的朋友：口语、短句、有判断；可以玩梗和自嘲，但不油腻、不端着、不堆术语。",
    "立场：敢下判断，也坦白不确定的地方；不吹不黑，不制造焦虑，不攻击个人。"
  ].join("\n"), [
    "你在为一个中文 X 账号写帖子，账号定位是「小娱乐、大 AI 科技」：用轻松、有梗但不油腻的口吻聊 AI、科技和产品。",
    "观点鲜明，敢下判断，但不夸大、不标题党；像懂行的朋友聊天，不像新闻通稿或客服。",
    "不虚构亲身经历，不冒充业内人士，不攻击个人。"
  ].join("\n")]);

  /** 存储里的人设 → 实际使用的人设：空或旧版默认值时用当前默认。 */
  function resolvePersona(saved) {
    const value = typeof saved === "string" ? saved.trim() : "";
    return !value || PREVIOUS_PERSONAS.includes(value) ? DEFAULT_PERSONA : saved;
  }

  const FORMATS = Object.freeze([
    Object.freeze({
      id: "short_opinion", label: "中短帖观点", min: 150, max: 400, quotesSource: false,
      guide: "一条独立的观点帖：第一句是钩子，随后给出事实依据和你的判断，结尾可以留一个让人想回复的问题。"
    }),
    Object.freeze({
      id: "quote", label: "引用转发", min: 50, max: 150, quotesSource: true,
      guide: "引用原帖发表看法：读者能同时看到被引用的帖子，所以不复述它，直接给出态度、补充信息或反差点。正文里不要放原帖链接，发布时会附上。"
    })
  ]);

  const PostFormat = Object.freeze({
    values: () => FORMATS,
    from: id => FORMATS.find(format => format.id === id),
    DEFAULT: FORMATS[0],
    /** 引用转发附上的原帖：优先选中素材里的 X 帖子，其次第一条有链接的素材；都没有链接（只有粘贴内容）时为 null。 */
    quoteTarget(format, materials) {
      if (!format.quotesSource) return null;
      const linked = materials.filter(material => material.url);
      return (linked.find(material => material.kind === "x_post") || linked[0])?.url || null;
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

  function angleLines(angle) {
    if (!angle) return [];
    return [
      `本次角度：${angle.type.label}。参考第一句：${angle.hook}`,
      ...(angle.outline.length ? [`提纲：${angle.outline.map((item, index) => `${index + 1}. ${item}`).join("；")}`] : []),
      "按这个角度写；参考第一句可以改得更有力，但不能比资料说得更满。"
    ];
  }

  /** 可编辑的写作要求（默认值）。 */
  const DEFAULT_GUIDE = [
    "开头：第一句就给读者停下来的理由，例如反差、具体数字、明确的判断或一个好问题；几条候选的开头手法各不相同，正文不要互相复制。",
    "结构：先给结论或态度，再给事实依据，最后落到一个具体的后果、场景或问题。",
    prompt.VOICE_RULES,
    prompt.X_POST_RULES
  ].join("\n");

  /**
   * 构建成稿请求（后台调用，输入来自页面，需要校验）。
   * @param input { materials, format, persona, angle?, samples?, instructions?, benchmark? }
   * @param options.now 当前时间；options.guide 用户改过的写作要求
   */
  function buildRequest(input, { now = Date.now(), guide } = {}) {
    const materials = prompt.checkMaterials(input?.materials);
    const format = PostFormat.from(input?.format);
    if (!format) throw new Error("请选择帖子形态。");
    const persona = prompt.checkPersona(input.persona);
    const angle = checkAngle(input.angle);
    const samples = prompt.checkSamples(input.samples);
    const instructions = prompt.checkInstructions(input.instructions);
    const benchmark = prompt.checkBenchmark(input.benchmark);
    const task = [
      `根据 <materials> 写 ${CANDIDATE_COUNT} 条可以直接发在 X 上的「${format.label}」候选，每条约 ${format.min}～${format.max} 字。`,
      format.guide,
      ...angleLines(angle),
      ...prompt.benchmarkLines(benchmark),
      ...(samples.length ? [prompt.SAMPLES_HINT] : []),
      ...(instructions ? [`本次要求：${instructions}`] : [])
    ].join("\n");
    return {
      prompt: [prompt.nowLine(now), prompt.section("persona", persona), prompt.section("task", task), prompt.guideSection(guide, DEFAULT_GUIDE),
        prompt.section("rules", prompt.SHARED_RULES), prompt.candidatesOutput(CANDIDATE_COUNT)].join("\n\n"),
      content: ["<materials>", ...materials.map(prompt.materialXml), "</materials>", ...prompt.samplesXml(samples)].join("\n")
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
    PostFormat, DEFAULT_PERSONA, resolvePersona, DEFAULT_GUIDE, CANDIDATE_COUNT, SAMPLE_LIMITS, selectSamples, buildRequest, parse
  });
})();
