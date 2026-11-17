// 改写原帖：风格、长度、英文本地化、多篇融合与原创度约束的提示词构建；改写稿与原文的重合度分级。
// 结果与成稿同一结构（3 个候选），由 XReplyDraftModel.parse 解析。
(() => {
  "use strict";

  const prompt = globalThis.XReplyComposePrompt;
  const { PostFormat, CANDIDATE_COUNT } = globalThis.XReplyDraftModel;

  function defineEnum(entries) {
    const values = Object.freeze(entries.map(entry => Object.freeze(entry)));
    return { values: () => values, from: id => values.find(entry => entry.id === id), DEFAULT: values[0] };
  }

  const RewriteStyle = Object.freeze(defineEnum([
    { id: "standard", label: "标准改写", guide: "保留原文的核心信息和大致顺序，换成我的表达，并加入一句我的判断。" },
    { id: "hook", label: "钩子开头", guide: "第一句用强钩子抓人（反差、悬念、数字或提问），随后给信息和判断。" },
    { id: "viral", label: "X 爆文体", guide: "X 爆款写法：短句、分行、节奏快；开头一句亮观点，中间 2～4 个要点，结尾一句金句或提问。" },
    { id: "narrative", label: "叙事表达", guide: "用讲故事的方式：从场景或人物切入，按发生顺序展开，最后落到观点。" },
    { id: "newsflash", label: "热点快讯", guide: "快讯写法：第一句说清发生了什么，随后 2～3 个关键信息点，最后一句说明对普通人的影响。" }
  ]));

  /** 长度：same 为接近原文的信息量，其余为目标字数。 */
  const RewriteLength = Object.freeze(defineEnum([
    { id: "same", label: "接近原文", chars: null },
    ...[100, 200, 300, 500, 800].map(chars => ({ id: String(chars), label: `约 ${chars} 字`, chars }))
  ]));

  /** 原文主要不是中文时需要本地化：中日韩文字占可读字符不到三成。 */
  function needsLocalization(texts) {
    const text = texts.join("\n").replace(/https?:\/\/\S+/g, "");
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
    const letters = (text.match(/\p{L}/gu) || []).length;
    return letters >= 20 && cjk / letters < 0.3;
  }

  /** 接近原文时的目标中文字数：中文按字数，外文按词数的 1.5 倍估算；限制在 50～1000 字。 */
  function sameLengthChars(texts, localized) {
    const text = texts.join("\n").replace(/https?:\/\/\S+/g, "");
    const size = localized ? (text.match(/[\p{L}\p{N}]+/gu) || []).length * 1.5 : (text.match(/[\p{L}\p{N}]/gu) || []).length;
    return Math.min(1000, Math.max(50, Math.round(size / 10) * 10));
  }

  const ORIGINALITY_RULE = [
    "这是二次创作，不是同义词替换：保留核心事实和信息量，用我的人设和视角重新组织，并加入我的判断。",
    "不照搬原文句子，不沿用原文独特的比喻和金句原话。",
    "原文里的“我”是原作者：不要把原作者的经历写成我的经历，需要时写成“看到有人说”“某某提到”。"
  ].join("\n");

  const LOCALIZE_RULE = "原文主要不是中文：先理解原意，再用地道的中文重写，不逐句直译；产品名、人名和专有名词保留原文或通用译名。";
  const FUSION_RULE = "多条素材讲同一话题时融合观点、去掉重复、按逻辑重组；不相关时只改写最主要的一条，不强行拼接。";

  /**
   * 构建改写请求（后台调用，输入来自页面，需要校验）。
   * @param input { materials, style, length, format, persona, samples?, instructions?, benchmark? }
   */
  function buildRequest(input, now = Date.now()) {
    const materials = prompt.checkMaterials(input?.materials);
    const style = RewriteStyle.from(input.style);
    const length = RewriteLength.from(input.length);
    const format = PostFormat.from(input.format);
    if (!style || !length || !format) throw new Error("请选择改写风格、长度和帖子形态。");
    const persona = prompt.checkPersona(input.persona);
    const samples = prompt.checkSamples(input.samples);
    const instructions = prompt.checkInstructions(input.instructions);
    const benchmark = prompt.checkBenchmark(input.benchmark);
    const texts = materials.map(item => [item.title, item.text].filter(Boolean).join("\n"));
    const localized = needsLocalization(texts);
    const chars = length.chars ?? sameLengthChars(texts, localized);
    const task = [
      `任务：把 <materials> 中的${materials.length > 1 ? "多条内容融合" : "内容"}改写成我自己的 X 帖子（「${format.label}」），写 ${CANDIDATE_COUNT} 个候选，每条约 ${chars} 字。`,
      ORIGINALITY_RULE,
      `风格「${style.label}」：${style.guide}`,
      ...(format.quotesSource ? [format.guide] : []),
      ...(materials.length > 1 ? [FUSION_RULE] : []),
      ...(localized ? [LOCALIZE_RULE] : []),
      `${CANDIDATE_COUNT} 个候选的开头手法要不同。`,
      ...prompt.benchmarkLines(benchmark),
      prompt.X_POST_RULES,
      ...(samples.length ? [prompt.SAMPLES_HINT] : []),
      ...(instructions ? [`本次要求：${instructions}`] : [])
    ].join("\n");
    return {
      prompt: [prompt.nowLine(now), persona, task, prompt.SHARED_RULES, prompt.candidatesOutput(CANDIDATE_COUNT)].join("\n\n"),
      content: ["<materials>", ...materials.map(prompt.materialXml), "</materials>", ...prompt.samplesXml(samples)].join("\n")
    };
  }

  // ---------- 原创度 ----------

  const OriginalityLevel = Object.freeze(defineEnum([
    { id: "close", label: "与原文过于接近，建议再改", min: 0.5 },
    { id: "partial", label: "部分沿用原文表达", min: 0.3 },
    { id: "rewritten", label: "表达已重组", min: 0 }
  ]));

  /**
   * 改写稿与原文的重合度：取与各条原文包含度的最大值。原文需要本地化（跨语言）时不计算，返回 null。
   * 页面侧调用，依赖 text-similarity.js。
   * @returns {{ overlap: number, level } | null}
   */
  function originality(text, sources) {
    if (!text.trim() || !sources.length || needsLocalization(sources)) return null;
    const { containment } = globalThis.XReplyTextSimilarity;
    const overlap = Math.max(...sources.map(source => containment(text, source)));
    return { overlap, level: OriginalityLevel.values().find(level => overlap >= level.min) };
  }

  globalThis.XReplyRewriteModel = Object.freeze({
    RewriteStyle, RewriteLength, OriginalityLevel, needsLocalization, sameLengthChars, buildRequest, originality
  });
})();
