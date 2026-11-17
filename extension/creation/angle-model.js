// 结构化角度：提示词构建、模型结果容错解析、与同话题 X 帖子的对照。
// “已有人写／新角度”由模型对照参考帖给出编号，编号越界即丢弃；潜力只取同角度参考帖的真实浏览与流速，没有依据就不给。
(() => {
  "use strict";

  const prompt = globalThis.XReplyComposePrompt;

  const ANGLE_LIMITS = Object.freeze({ min: 3, max: 5, hook: 120, outline: 4, outlineItem: 120, risk: 120 });

  function defineEnum(entries) {
    const values = Object.freeze(entries.map(entry => Object.freeze(entry)));
    return {
      values: () => values,
      /** 按编号或中文名查找，模型有时返回中文名。 */
      from: value => values.find(entry => entry.id === value || entry.label === value)
    };
  }

  const AngleType = Object.freeze({
    ...defineEnum([
      { id: "interpret", label: "解读" }, { id: "contrarian", label: "反常识" }, { id: "listicle", label: "清单" },
      { id: "tutorial", label: "教程" }, { id: "roast", label: "吐槽" }, { id: "prediction", label: "预测" },
      { id: "comparison", label: "对比" }, { id: "story", label: "故事" }
    ]),
    labels() { return this.values().map(type => type.label).join("、"); }
  });

  const COVERED = Object.freeze({ id: "covered", label: "已有人写" });
  const NEW = Object.freeze({ id: "new", label: "新角度" });
  const AngleCoverage = Object.freeze({ COVERED, NEW, from: id => [COVERED, NEW].find(entry => entry.id === id) });

  const TASK = () => [
    `任务：为 <materials> 中的素材找 ${ANGLE_LIMITS.min}～${ANGLE_LIMITS.max} 个适合发 X 中短帖的写作角度，角度之间要有明显区别。`,
    "每个角度包含：",
    `- type：${AngleType.labels()} 之一`,
    "- hook：帖子第一句的钩子，不超过 60 字",
    `- outline：2～${ANGLE_LIMITS.outline} 条提纲`,
    "- evidence：支撑该角度的素材编号，例如 [\"M1\"]",
    "- risk：风险提示，例如事实不足、时效已过、容易引战；没有则为空字符串",
    "- covered_by：<references> 中已经用这个角度写过的参考帖编号，例如 [\"R2\"]；没有则为 []",
    "不要声称全网无人写过，不要给出热度或潜力评分。"
  ].join("\n");

  const OUTPUT_FORMAT = "只输出 <reply>{\"angles\":[{\"type\":\"\",\"hook\":\"\",\"outline\":[],\"evidence\":[],\"risk\":\"\",\"covered_by\":[]}]}</reply>，reply 内是合法 JSON，不要输出其他内容。";

  /**
   * 构建找角度请求（后台调用，输入来自页面，需要校验）。
   * @param input { materials, references, persona }
   * @returns {{ prompt, content }} system 与 user 消息
   */
  function buildRequest(input, now = Date.now()) {
    const materials = prompt.checkMaterials(input?.materials);
    const references = prompt.checkReferences(input?.references);
    const persona = prompt.checkPersona(input?.persona);
    return {
      prompt: [prompt.nowLine(now), persona, TASK(), prompt.SHARED_RULES, OUTPUT_FORMAT].join("\n\n"),
      content: [
        "<materials>", ...materials.map(prompt.materialXml), "</materials>",
        "<references>", ...(references.length ? references.map(prompt.referenceXml) : ["（没有同话题的 X 帖子）"]), "</references>"
      ].join("\n")
    };
  }

  function parseAngle(raw, counts) {
    if (!raw || typeof raw !== "object") return null;
    const type = AngleType.from(raw.type);
    const hook = typeof raw.hook === "string" ? raw.hook.trim().slice(0, ANGLE_LIMITS.hook) : "";
    if (!type || !hook) return null;
    return {
      type: type.id, hook,
      outline: prompt.stringList(raw.outline, ANGLE_LIMITS.outline, ANGLE_LIMITS.outlineItem),
      evidence: prompt.indexList(raw.evidence, "M", counts.materials),
      risk: typeof raw.risk === "string" ? raw.risk.trim().slice(0, ANGLE_LIMITS.risk) : "",
      coveredBy: prompt.indexList(raw.covered_by ?? raw.coveredBy, "R", counts.references)
    };
  }

  /**
   * 解析模型输出。缺类型或钩子的角度丢弃；一个可用角度都没有时报错。
   * @param counts { materials, references } 本次发送的素材与参考帖数量，用于校验编号
   */
  function parse(text, counts) {
    const data = prompt.extractJson(text);
    const list = Array.isArray(data) ? data : data?.angles;
    if (!Array.isArray(list)) throw new Error("模型返回的结果里没有角度列表，请重试。");
    const angles = list.map(raw => parseAngle(raw, counts)).filter(Boolean).slice(0, ANGLE_LIMITS.max);
    if (!angles.length) throw new Error("模型返回的角度都缺少类型或钩子，请重试或换一个模型。");
    return { angles, dropped: Math.min(list.length, ANGLE_LIMITS.max) - angles.length };
  }

  const maxOf = values => {
    const present = values.filter(Number.isFinite);
    return present.length ? Math.max(...present) : null;
  };

  /**
   * 对照参考帖：有同角度参考帖的标为“已有人写”，潜力取这些帖子的最高浏览与流速；否则为“新角度”，潜力无依据。
   * 结果自带参考帖摘要（coveringPosts），保存后不依赖当时的参考帖列表。
   * @param references 与请求中顺序一致的参考帖（含 views、velocity、url）
   */
  function assess(angles, references) {
    return angles.map(angle => {
      const covering = angle.coveredBy.map(index => references[index]).filter(Boolean);
      const views = maxOf(covering.map(item => item.views));
      const velocity = maxOf(covering.map(item => item.velocity));
      return {
        ...angle,
        coverage: covering.length ? AngleCoverage.COVERED.id : AngleCoverage.NEW.id,
        coveringPosts: covering.map(item => ({ url: item.url, author: item.author, views: item.views, velocity: item.velocity })),
        potential: views !== null || velocity !== null ? { views, velocity, basis: covering.length } : null
      };
    });
  }

  globalThis.XReplyAngleModel = Object.freeze({ AngleType, AngleCoverage, ANGLE_LIMITS, buildRequest, parse, assess });
})();
