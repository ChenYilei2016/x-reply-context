// 写作台页（单栏）：基于内容（粘贴正文、链接、已选素材）→ AI 改写或找角度写 → 3 个候选 → 编辑（加权字数、首屏、原创度）
// → 保存草稿、去 X 发布 → 一键配图。来源见 studio-sources.js，写作设置见 studio-settings.js。
(() => {
  "use strict";

  const model = globalThis.XReplyMaterialModel;
  const format = globalThis.XReplyFormat;
  const prompt = globalThis.XReplyComposePrompt;
  const { AngleType, AngleCoverage, ...angleModel } = globalThis.XReplyAngleModel;
  const { PostFormat, ...draftModel } = globalThis.XReplyDraftModel;
  const { RewriteStyle, RewriteLength, OriginalityLevel, ...rewriteModel } = globalThis.XReplyRewriteModel;
  const { ImageStyle, ImageRatio } = globalThis.XReplyImageModel;
  const xText = globalThis.XReplyXText;
  const record = globalThis.XReplyDraftRecord;
  const publishLink = globalThis.XReplyPublishLink;
  const styleModel = globalThis.XReplyStyleModel;
  const { LinkStatus } = globalThis.XReplyStudioSources;

  const db = globalThis.XReplyMaterialDB.create();
  const store = globalThis.XReplyStudioStore.create({ db, cluster: globalThis.XReplyTopicCluster.cluster, draftModel, prompt });
  const drafts = globalThis.XReplyDraftsStore.create({ db });
  const styleTemplates = globalThis.XReplyStyleStore.create();
  const ai = globalThis.XReplyModelClient.create({ onChange: () => render(), onError: error => setStatus(error.message, true) });
  const settings = globalThis.XReplyStudioSettings.create({ store, drafts, onError: error => setStatus(error.message, true) });

  const SAVE_DELAY = 400;
  /** 写法：AI 改写（改写任务）、找角度写（成稿任务）；手写的候选不属于任何一种。 */
  const ComposeMode = Object.freeze({ REWRITE: "rewrite", ANGLE: "angle", MANUAL: "manual" });
  const SOURCE_PLACEHOLDER = Object.freeze({
    rewrite: "粘贴正文或链接；正文和链接可以混合输入，多个链接建议一行一个。也可以在 X 上点帖子下的「改写」直接带入。",
    angle: "输入文章标题、事件，或粘贴正文、链接，然后点「找角度」。"
  });

  const $ = id => document.getElementById(id);
  const state = {
    channelNames: {}, templates: [], references: [],
    composeMode: ComposeMode.REWRITE, sourceText: "",
    angles: [], angleIndex: null, angleSignature: "",
    rewriteStyle: RewriteStyle.DEFAULT.id, rewriteLength: RewriteLength.DEFAULT.id,
    formatId: PostFormat.DEFAULT.id, benchmarkId: "", instructions: "",
    candidates: [], candidateIndex: 0,
    imageStyle: ImageStyle.DEFAULT.id, imageRatio: ImageRatio.DEFAULT.id, imagePrompt: "",
    /** 出图结果只留在内存，不写入存储（base64 图片较大）。 */
    image: null, imagePending: null
  };
  const timers = {};

  const sourceName = material => material.channelIds.map(id => state.channelNames[id] || id).join("、");
  const sources = globalThis.XReplyStudioSources.create({ db, store, prompt, sourceName, onChange: () => render() });

  // ---------- 工具 ----------

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function link(text, href) {
    const node = element("a", text);
    node.href = href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  }

  function setStatus(text, error = false) {
    $("status").textContent = text;
    $("status").dataset.error = String(error);
    $("status").hidden = !text;
  }

  /** 延迟执行，连续输入只保存一次。 */
  function later(key, work) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => void work().catch(error => setStatus(error.message, true)), SAVE_DELAY);
  }

  const currentFormat = () => PostFormat.from(state.formatId) || PostFormat.DEFAULT;
  const currentCandidate = () => state.candidates[state.candidateIndex];
  const currentBenchmark = () => state.templates.find(template => template.id === state.benchmarkId) || null;
  const promptSources = () => sources.sources().map(source => source.prompt);
  const sourceTexts = () => promptSources().map(source => [source.title, source.text].filter(Boolean).join("\n"));
  const sourceChars = () => sourceTexts().join("").replace(/\s/g, "").length;
  const libraryIds = () => sources.sources().map(source => source.library?.id).filter(Boolean);
  /** 改写出的候选与原文的重合度；其他候选不计算。 */
  const candidateOriginality = candidate =>
    candidate.approach?.mode === ComposeMode.REWRITE ? rewriteModel.originality(candidate.text, sourceTexts()) : null;
  const anglesCurrent = () => state.angleSignature === sources.signature();

  // ---------- 数据 ----------

  async function loadChannelNames() {
    const status = await chrome.runtime.sendMessage({ type: "CREATION_CHANNELS_STATUS" });
    if (status?.ok) for (const channel of [...status.channels, ...status.manualChannels]) state.channelNames[channel.id] = channel.name;
  }

  async function loadTemplates() {
    state.templates = await styleTemplates.list();
  }

  async function restoreSession() {
    const saved = await store.session();
    if (!saved) return;
    if (Object.values(ComposeMode).includes(saved.composeMode) && saved.composeMode !== ComposeMode.MANUAL) state.composeMode = saved.composeMode;
    if (typeof saved.sourceText === "string") state.sourceText = saved.sourceText;
    if (Array.isArray(saved.angles)) state.angles = saved.angles.filter(angle => AngleType.from(angle?.type));
    state.angleSignature = typeof saved.angleSignature === "string" ? saved.angleSignature : "";
    state.angleIndex = Number.isInteger(saved.angleIndex) && state.angles[saved.angleIndex] ? saved.angleIndex : null;
    if (RewriteStyle.from(saved.rewriteStyle)) state.rewriteStyle = saved.rewriteStyle;
    if (RewriteLength.from(saved.rewriteLength)) state.rewriteLength = saved.rewriteLength;
    if (PostFormat.from(saved.formatId)) state.formatId = saved.formatId;
    for (const key of ["benchmarkId", "instructions", "imagePrompt"]) if (typeof saved[key] === "string") state[key] = saved[key];
    if (ImageStyle.from(saved.imageStyle)) state.imageStyle = saved.imageStyle;
    if (ImageRatio.from(saved.imageRatio)) state.imageRatio = saved.imageRatio;
    if (Array.isArray(saved.candidates)) {
      state.candidates = saved.candidates.filter(item => typeof item?.text === "string" && typeof item.original === "string");
    }
    state.candidateIndex = Number.isInteger(saved.candidateIndex) && state.candidates[saved.candidateIndex] ? saved.candidateIndex : 0;
  }

  const saveSession = () => store.saveSession({
    composeMode: state.composeMode, sourceText: state.sourceText,
    angles: state.angles, angleSignature: state.angleSignature, angleIndex: state.angleIndex,
    rewriteStyle: state.rewriteStyle, rewriteLength: state.rewriteLength, formatId: state.formatId,
    benchmarkId: state.benchmarkId, instructions: state.instructions,
    candidates: state.candidates, candidateIndex: state.candidateIndex,
    imageStyle: state.imageStyle, imageRatio: state.imageRatio, imagePrompt: state.imagePrompt
  });

  // ---------- 渲染：写法与来源 ----------

  function renderModes() {
    for (const tab of $("compose-modes").children) tab.setAttribute("aria-selected", String(tab.dataset.mode === state.composeMode));
    for (const node of document.querySelectorAll("[data-mode-only]")) node.hidden = node.dataset.modeOnly !== state.composeMode;
    $("source-text").placeholder = SOURCE_PLACEHOLDER[state.composeMode];
  }

  const LINK_LABELS = Object.freeze({ idle: "生成时读取", loading: "读取中…", ok: "已读取", error: "读取失败" });

  function chip(text, className, onRemove, title) {
    const item = element("li", undefined, `chip ${className}`);
    item.append(element("span", text));
    if (title) item.title = title;
    if (onRemove) {
      const remove = element("button", "×", "chip-remove");
      remove.type = "button";
      remove.setAttribute("aria-label", "移出");
      remove.disabled = Boolean(ai.pending);
      remove.addEventListener("click", onRemove);
      item.append(remove);
    }
    return item;
  }

  function renderSources() {
    if (document.activeElement !== $("source-text")) $("source-text").value = state.sourceText;
    const chips = [];
    for (const entry of sources.links()) {
      const title = entry.status === LinkStatus.OK ? (entry.material.title || entry.material.text).slice(0, 40) : entry.url.replace(/^https?:\/\//, "").slice(0, 40);
      chips.push(chip(`链接 · ${LINK_LABELS[entry.status]} · ${title}`, `link ${entry.status}`, null, entry.error || entry.url));
    }
    for (const material of sources.basket()) {
      const label = `${material.kind === "x_post" && material.author?.handle ? `@${material.author.handle}` : sourceName(material)} · ${(material.title || material.text).slice(0, 36)}`;
      chips.push(chip(`已选 · ${label}`, "basket", () => void sources.removeFromBasket(material.id).catch(error => setStatus(error.message, true)), material.url));
    }
    $("source-chips").replaceChildren(...chips);
    const list = sources.sources();
    const parts = [];
    if (sources.body()) parts.push(`粘贴正文 ${sources.body().length} 字`);
    const linkCount = sources.links().length;
    if (linkCount) parts.push(`链接 ${linkCount} 个`);
    if (sources.basket().length) parts.push(`已选素材 ${sources.basket().length} 条`);
    const notes = [];
    if (sources.droppedLinks()) notes.push(`只读取前 ${globalThis.XReplySourceInput.LINK_LIMIT} 个链接`);
    if (sources.missing().length) notes.push(`${sources.missing().length} 条已选素材已被清理`);
    for (const entry of sources.links()) if (entry.status === LinkStatus.ERROR) notes.push(entry.error);
    if (list.length > 1) notes.push(`将融合 ${list.length} 条来源`);
    if (list.length && rewriteModel.needsLocalization(sourceTexts())) notes.push("原文主要不是中文，将本地化为地道中文");
    $("source-summary").textContent = parts.length ? `${parts.join(" · ")}${notes.length ? `。${notes.join("；")}。` : ""}` :
      "还没有内容：粘贴正文或链接，或去「选题雷达」选入素材。";
  }

  // ---------- 渲染：角度 ----------

  function potentialText(angle) {
    if (!angle.potential) {
      return angle.coverage === AngleCoverage.COVERED.id ? "潜力：同角度参考帖没有浏览数据，无依据" : "潜力：没有同角度的参考帖，无依据";
    }
    const parts = [];
    if (angle.potential.views !== null) parts.push(`最高浏览 ${format.count(angle.potential.views)}`);
    if (angle.potential.velocity !== null) parts.push(`流速 ${format.velocity(angle.potential.velocity)}`);
    return `潜力参考：${angle.potential.basis} 条同角度帖子 ${parts.join(" · ")}`;
  }

  function renderAngle(angle, index) {
    const node = $("angle-template").content.firstElementChild.cloneNode(true);
    node.classList.toggle("active", index === state.angleIndex);
    const coverage = AngleCoverage.from(angle.coverage);
    node.querySelector(".angle-badges").append(element("span", AngleType.from(angle.type).label, "badge type"),
      element("span", coverage.label, `badge ${coverage.id}`));
    node.querySelector(".angle-hook").textContent = angle.hook;
    node.querySelector(".angle-outline").replaceChildren(...angle.outline.map(item => element("li", item)));
    const meta = node.querySelector(".angle-meta");
    meta.textContent = angle.evidence.length ? `依据 ${angle.evidence.map(item => `M${item + 1}`).join("、")}` : "未标注依据";
    for (const post of angle.coveringPosts) {
      meta.append(" · ", link(`@${post.author || "?"}${post.views !== undefined ? ` ${format.count(post.views)} 浏览` : ""}`, post.url));
    }
    node.querySelector(".angle-risk").textContent = angle.risk ? `风险：${angle.risk}` : "";
    node.querySelector(".angle-risk").hidden = !angle.risk;
    node.querySelector(".angle-potential").textContent = potentialText(angle);
    const use = node.querySelector(".use");
    use.textContent = index === state.angleIndex ? "已选这个角度" : "用这个角度";
    use.disabled = Boolean(ai.pending);
    use.addEventListener("click", () => { state.angleIndex = index; render(); later("session", saveSession); $("write").focus(); });
    return node;
  }

  function renderAngles() {
    $("angles").replaceChildren(...state.angles.map(renderAngle));
    const stale = state.angles.length > 0 && !anglesCurrent();
    $("angles-hint").textContent = stale ? "内容已经变化，下面是之前的角度，建议重新找角度。" :
      state.angles.length ? "挑一个角度后点下面的「生成」。" : "模型返回 3～5 个角度，并对照素材库里同话题的 X 帖子标出“已有人写”；潜力只看真实数据。";
    $("find-angles").disabled = Boolean(ai.pending);
    $("find-angles").textContent = ai.pending?.task === "angles" ? "正在找角度…" : state.angles.length ? "重新找角度" : "🔍 找角度";
    $("references").hidden = !state.references.length;
    $("references-summary").textContent = `同话题 X 帖 ${state.references.length} 条（用来判断角度是否已有人写）`;
    $("reference-list").replaceChildren(...state.references.map((post, index) => {
      const item = element("li");
      item.append(element("strong", `R${index + 1} `), `@${post.author?.handle || "?"} · 浏览 ${format.count(post.metrics.views)} · `,
        link(post.text.slice(0, 60), post.url));
      return item;
    }));
  }

  // ---------- 渲染：生成与编辑 ----------

  function renderControls() {
    const rewriting = state.composeMode === ComposeMode.REWRITE;
    $("rewrite-style").value = state.rewriteStyle;
    $("rewrite-length").value = state.rewriteLength;
    $("format").value = state.formatId;
    $("benchmark").replaceChildren(new Option("不套用", ""), ...state.templates.map(template => new Option(template.name, template.id)));
    $("benchmark").value = currentBenchmark()?.id || "";
    if (document.activeElement !== $("instructions")) $("instructions").value = state.instructions;
    const angle = !rewriting && state.angles[state.angleIndex];
    $("angle-chip").hidden = !angle;
    if (angle) $("angle-chip").firstElementChild.textContent = `角度：${AngleType.from(angle.type).label} · ${angle.hook}`;
    $("compose-hint").textContent = rewriting ? "" : angle ? "" : "可以先找角度再写，也可以直接按内容生成观点帖。";
    const busy = ai.pending && ["drafts", "rewrite"].includes(ai.pending.task);
    $("write").disabled = Boolean(ai.pending);
    $("write").textContent = busy ? "正在生成…" : `✏️ ${rewriting ? "改写" : "生成"}${state.candidates.length ? "（重新出 3 个候选）" : ""}`;
    $("cancel").hidden = !ai.pending;
    $("candidates").replaceChildren(...state.candidates.map((candidate, index) => {
      const close = candidateOriginality(candidate)?.level === OriginalityLevel.from("close");
      const label = candidate.approach?.mode === ComposeMode.MANUAL ? "手写" : `候选 ${index + 1}${candidate.hookStyle ? ` · ${candidate.hookStyle}` : ""}`;
      const tab = element("button", `${label}${candidate.text !== candidate.original ? " · 已改" : ""}${close ? " · ⚠ 太像原文" : ""}`);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(index === state.candidateIndex));
      tab.addEventListener("click", () => { state.candidateIndex = index; render(); later("session", saveSession); });
      return tab;
    }));
  }

  /** 发布时的完整正文：引用转发在末尾附上原帖链接（X 会把末尾的帖子链接显示为引用）。 */
  function publishText(text) {
    const target = PostFormat.quoteTarget(currentFormat(), promptSources());
    return target ? `${text.trimEnd()}\n${target}` : text;
  }

  function renderFold(measure) {
    $("fold-summary").textContent = measure.folded ? `首屏预览 · 超过 ${xText.FOLD_LIMIT} 加权字符会折叠，钩子要放在标线前` : "首屏预览 · 全文都在首屏内";
    if (!measure.folded) {
      $("fold-preview").replaceChildren(element("span", measure.text));
      return;
    }
    $("fold-preview").replaceChildren(element("span", measure.text.slice(0, measure.fold)),
      element("span", "首屏到此 · 之后折叠为“显示更多”", "fold-line"), element("span", measure.text.slice(measure.fold), "folded"));
  }

  function renderEditor() {
    const candidate = currentCandidate();
    const text = candidate?.text || "";
    if ($("editor").value !== text && document.activeElement !== $("editor")) $("editor").value = text;
    const measure = xText.measure(publishText(text));
    const parts = [];
    const original = sourceChars();
    if (state.composeMode === ComposeMode.REWRITE && original) parts.push(`原文 ${original} 字 → 当前 ${text.replace(/\s/g, "").length} 字`);
    parts.push(`加权字数 ${measure.length} / ${xText.PREMIUM_LIMIT.toLocaleString("zh-CN")}（Premium）`);
    if (text) parts.push(measure.folded ? `超过首屏 ${xText.FOLD_LIMIT}` : "首屏内");
    $("meter").textContent = parts.join(" · ");
    $("meter").dataset.error = String(measure.overPremium);
    const originality = candidate ? candidateOriginality(candidate) : null;
    $("originality").hidden = !originality;
    if (originality) {
      $("originality").textContent = `与原文重合 ${Math.round(originality.overlap * 100)}% · ${originality.level.label}`;
      $("originality").dataset.level = originality.level.id;
    }
    const target = PostFormat.quoteTarget(currentFormat(), promptSources());
    $("quote-target").hidden = !target;
    $("quote-target").textContent = target ? `发布时末尾附上原帖链接（计 23 字）：${target}` : "";
    $("fold-details").hidden = !text;
    renderFold(measure);
    for (const id of ["publish", "save-draft", "copy"]) $(id).disabled = !text.trim();
    $("copy").textContent = target ? "复制（附原帖链接）" : "复制";
    $("save-draft").textContent = candidate?.draftId ? "更新草稿" : "保存草稿";
    $("revert").hidden = !candidate || candidate.approach?.mode === ComposeMode.MANUAL;
    $("revert").disabled = !candidate || candidate.text === candidate.original;
  }

  function renderImage() {
    $("image-style").value = state.imageStyle;
    $("image-ratio").value = state.imageRatio;
    if (document.activeElement !== $("image-prompt")) $("image-prompt").value = state.imagePrompt;
    const writing = ai.pending?.task === "image_prompt";
    $("image-generate").disabled = Boolean(state.imagePending) || Boolean(ai.pending);
    $("image-generate").textContent = writing ? "正在写提示词…" : state.imagePending ? "正在出图，约 30 秒～2 分钟…" : state.image ? "🎨 重新生图" : "🎨 生图";
    $("image-cancel").hidden = !state.imagePending;
    $("image-prompt-button").disabled = Boolean(ai.pending);
    $("image-result").hidden = !state.image;
    if (state.image) {
      if ($("image-preview").src !== state.image.dataUrl) $("image-preview").src = state.image.dataUrl;
      $("image-meta").textContent = [state.image.size, state.image.model].filter(Boolean).join(" · ");
    }
  }

  function render() {
    renderModes();
    renderSources();
    ai.render();
    renderAngles();
    renderControls();
    renderEditor();
    renderImage();
  }

  // ---------- 找角度与生成 ----------

  /** 读取链接并取出本次来源；没有内容时报错。必须在点击里最先调用（可能需要授权读取网页）。 */
  async function readySources() {
    await sources.resolve();
    const list = sources.sources();
    if (!list.length) throw new Error("先在「基于内容」粘贴正文或链接，或在雷达、X 上选入素材。");
    return list;
  }

  /** 参考帖用的素材形态：来自素材库的用原素材，粘贴和链接的临时补齐聚合需要的字段。 */
  function clusterMaterials(list) {
    const now = Date.now();
    return list.map(source => source.library || { id: source.key, kind: source.prompt.kind === "note" ? "article" : source.prompt.kind,
      title: source.prompt.title, text: source.prompt.text, publishedAt: source.prompt.publishedAt, firstSeenAt: now, channelIds: [] });
  }

  async function findAngles() {
    if (ai.pending) return;
    const list = await readySources();
    const now = Date.now();
    state.references = await store.referencePosts(clusterMaterials(list));
    const references = prompt.checkReferences(state.references.map(post => prompt.toPromptReference(post, model.velocity(post, now))));
    setStatus(`正在找角度 · ${list.length} 条来源、${references.length} 条参考帖 · 最长等待 90 秒`);
    const text = await ai.request("angles", { materials: list.map(source => source.prompt), references, persona: settings.persona() });
    if (text === null) return;
    const { angles, dropped } = angleModel.parse(text, { materials: list.length, references: references.length });
    state.angles = angleModel.assess(angles, references);
    state.angleSignature = sources.signature();
    state.angleIndex = null;
    await saveSession();
    render();
    const covered = state.angles.filter(angle => angle.coverage === AngleCoverage.COVERED.id).length;
    setStatus(`得到 ${state.angles.length} 个角度（${covered} 个已有人写）${dropped ? `，${dropped} 个格式不完整已丢弃` : ""}。挑一个点「用这个角度」，再点「生成」。`);
  }

  /** 本次生成的任务、输入与写法（写法记在候选上，保存草稿时用于复盘分组）。 */
  function generation(list) {
    const benchmark = currentBenchmark();
    const shared = { materials: list.map(source => source.prompt), format: state.formatId, persona: settings.persona(),
      samples: settings.samples().map(sample => sample.text), instructions: state.instructions,
      benchmark: benchmark ? styleModel.forPrompt(benchmark) : undefined };
    if (state.composeMode === ComposeMode.REWRITE) {
      const style = RewriteStyle.from(state.rewriteStyle);
      return { task: "rewrite", input: { ...shared, style: style.id, length: state.rewriteLength },
        approach: { mode: ComposeMode.REWRITE, style: style.id }, label: `改写 · ${style.label}` };
    }
    const angle = state.angles[state.angleIndex];
    return { task: "drafts", input: { ...shared, angle: angle ? { type: angle.type, hook: angle.hook, outline: angle.outline } : undefined },
      approach: { mode: ComposeMode.ANGLE, angle: angle ? { type: angle.type, hook: angle.hook } : null },
      label: angle ? `${AngleType.from(angle.type).label}角度` : "不选角度" };
  }

  async function generate() {
    if (ai.pending) return;
    const list = await readySources();
    const edited = state.candidates.some(candidate => candidate.text !== candidate.original);
    if (edited && !confirm("重新生成会替换当前候选（包括你改过的内容），继续吗？")) return;
    const { task, input, approach, label } = generation(list);
    const benchmark = currentBenchmark();
    setStatus(`正在生成 3 个候选 · ${list.length} 条来源 · ${currentFormat().label} · ${label}${benchmark ? ` · 风格「${benchmark.name}」` : ""} · 最长等待 90 秒`);
    const text = await ai.request(task, input);
    if (text === null) return;
    state.candidates = draftModel.parse(text).map(draft => ({ ...draft, original: draft.text, approach }));
    state.candidateIndex = 0;
    await saveSession();
    render();
    setStatus(`得到 ${state.candidates.length} 个候选，可切换、直接编辑，再发布或生图。`);
  }

  /** 编辑区输入：没有候选时把手写内容作为一个候选，同样可以保存、发布和配图。 */
  function editText(text) {
    let candidate = currentCandidate();
    if (!candidate) {
      candidate = { hookStyle: "", text: "", original: "", approach: { mode: ComposeMode.MANUAL } };
      state.candidates = [candidate];
      state.candidateIndex = 0;
    }
    candidate.text = text;
    renderControls();
    renderEditor();
    later("session", saveSession);
  }

  // ---------- 草稿与发布 ----------

  /** 当前候选的发布正文；为空或超出 Premium 上限时报错。 */
  function readyText() {
    const candidate = currentCandidate();
    if (!candidate?.text.trim()) throw new Error("正文是空的。");
    const text = publishText(candidate.text);
    if (xText.measure(text).overPremium) throw new Error(`超过 Premium 上限 ${xText.PREMIUM_LIMIT} 加权字数，请删减。`);
    return text;
  }

  /** 当前候选对应的草稿：已存过且未发布的在原草稿上改正文，否则新建（不写入存储）。 */
  async function draftFromCandidate() {
    readyText();
    const candidate = currentCandidate();
    const existing = candidate.draftId ? await drafts.get(candidate.draftId) : null;
    if (existing && record.DraftStatus.from(existing.status).isEditable()) return record.withText(existing, candidate.text);
    const approach = candidate.approach || {};
    const list = sources.sources();
    return record.create({
      text: candidate.text, format: state.formatId,
      angle: approach.mode === ComposeMode.ANGLE ? approach.angle : null,
      rewrite: approach.mode === ComposeMode.REWRITE ? { style: approach.style } : null,
      materials: list.map(source => ({ id: source.library?.id || "", title: source.prompt.title || source.prompt.text.slice(0, 80), url: source.prompt.url })),
      quoteUrl: PostFormat.quoteTarget(currentFormat(), list.map(source => source.prompt))
    });
  }

  async function persistDraft(draft) {
    await drafts.save(draft);
    currentCandidate().draftId = draft.id;
    await saveSession();
    renderEditor();
  }

  async function saveDraft() {
    await persistDraft(await draftFromCandidate());
    setStatus("已保存到「草稿与复盘」。");
  }

  /** 去 X 发布：保存为“待确认”草稿，复制正文，在新标签页打开预填好的发帖页。发布仍由你在 X 上点。 */
  async function publish() {
    const text = readyText();
    await persistDraft(record.markPending(await draftFromCandidate()));
    const result = await publishLink.openCompose(text);
    await store.markUsed(libraryIds());
    setStatus(`${result.message}发出后，bot feed 带回这条帖子时会自动标为已发，也可以在「草稿与复盘」粘贴链接。`, !result.prefilled && !result.copied);
  }

  async function copyText() {
    await navigator.clipboard.writeText(readyText());
    await store.markUsed(libraryIds());
    setStatus("已复制。");
  }

  // ---------- 配图 ----------

  /** 写出图提示词：优先按当前正文，正文为空时按上方内容。 */
  async function writeImagePrompt() {
    const text = currentCandidate()?.text.trim() || sourceTexts().join("\n").trim();
    if (!text) throw new Error("先写好正文，或在「基于内容」里粘贴内容。");
    setStatus("正在写出图提示词…");
    const result = await ai.request("image_prompt", { text, style: state.imageStyle, ratio: state.imageRatio });
    if (result === null) return false;
    state.imagePrompt = result;
    await saveSession();
    render();
    return true;
  }

  /** 生图：没有提示词时先自动写，再用「配图」的 API 和出图模型生成。 */
  async function generateImage() {
    if (state.imagePending || ai.pending) return;
    if (!state.imagePrompt.trim() && !await writeImagePrompt()) return;
    const id = crypto.randomUUID();
    state.imagePending = id;
    render();
    setStatus("正在出图，通常 30 秒～2 分钟…");
    try {
      const result = await chrome.runtime.sendMessage({ type: "AI_IMAGE_GENERATE", id,
        input: { prompt: state.imagePrompt, style: state.imageStyle, ratio: state.imageRatio } });
      if (state.imagePending !== id || result?.cancelled) return;
      if (!result?.ok) throw new Error(result?.error || "出图服务暂不可用。");
      state.image = { ...result.image, model: result.model };
      setStatus("图片已生成，可下载或复制后在 X 发帖时上传。想换画面可以展开「出图提示词」修改后重新生图。");
    } finally {
      if (state.imagePending === id) state.imagePending = null;
      render();
    }
  }

  function cancelImage() {
    const id = state.imagePending;
    if (!id) return;
    state.imagePending = null;
    void chrome.runtime.sendMessage({ type: "AI_IMAGE_CANCEL", ids: [id] }).catch(() => {});
    render();
    setStatus("已取消出图。");
  }

  function downloadImage() {
    const extension = state.image.mime.split("/")[1].replace("jpeg", "jpg");
    Object.assign(document.createElement("a"), { href: state.image.dataUrl, download: `xreply-image-${Date.now()}.${extension}` }).click();
  }

  /** 剪贴板只稳定支持 PNG。 */
  async function copyImage() {
    if (state.image.mime !== "image/png") throw new Error("这张图不是 PNG，浏览器不能复制，请下载后上传。");
    const blob = await (await fetch(state.image.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus("图片已复制，可在 X 发帖框里粘贴。");
  }

  // ---------- 外部变化 ----------

  /** 从 X 帖子点「改写」过来：切到改写模式，聚焦「改写」按钮。 */
  async function applyIntent() {
    const intent = await store.takeIntent();
    if (intent?.mode !== ComposeMode.REWRITE) return;
    state.composeMode = ComposeMode.REWRITE;
    await saveSession();
    render();
    $("write").focus();
    setStatus("已带入 X 帖子。选好改写风格和字数，点「改写」。");
  }

  async function reloadBasket() {
    await sources.loadBasket();
    render();
  }

  // ---------- 事件 ----------

  const run = work => () => void work().catch(error => setStatus(error.message, true));
  const choose = (id, key) => $(id).addEventListener("change", () => { state[key] = $(id).value; render(); later("session", saveSession); });

  for (const tab of $("compose-modes").children) {
    tab.addEventListener("click", () => { state.composeMode = tab.dataset.mode; render(); later("session", saveSession); });
  }
  $("source-text").addEventListener("input", () => {
    state.sourceText = $("source-text").value;
    sources.setText(state.sourceText);
    renderSources();
    renderEditor();
    later("session", saveSession);
  });
  $("rewrite-style").replaceChildren(...RewriteStyle.values().map(style => new Option(style.label, style.id)));
  $("rewrite-length").replaceChildren(...RewriteLength.values().map(length => new Option(length.id === "same" ? "基于原文" : length.label, length.id)));
  $("format").replaceChildren(...PostFormat.values().map(item => new Option(`${item.label}（${item.min}～${item.max} 字）`, item.id)));
  $("image-style").replaceChildren(...ImageStyle.values().map(style => new Option(style.label, style.id)));
  $("image-ratio").replaceChildren(...ImageRatio.values().map(ratio => new Option(ratio.label, ratio.id)));
  for (const [id, key] of [["rewrite-style", "rewriteStyle"], ["rewrite-length", "rewriteLength"], ["format", "formatId"],
    ["benchmark", "benchmarkId"], ["image-style", "imageStyle"], ["image-ratio", "imageRatio"]]) choose(id, key);
  $("instructions").addEventListener("input", () => { state.instructions = $("instructions").value; later("session", saveSession); });
  $("find-angles").addEventListener("click", run(findAngles));
  $("angle-clear").addEventListener("click", () => { state.angleIndex = null; render(); later("session", saveSession); });
  $("write").addEventListener("click", run(generate));
  $("cancel").addEventListener("click", () => { if (ai.cancel()) setStatus("已取消。"); });
  $("editor").addEventListener("input", () => editText($("editor").value));
  $("revert").addEventListener("click", () => {
    const candidate = currentCandidate();
    if (!candidate) return;
    candidate.text = candidate.original;
    $("editor").value = candidate.text;
    render();
    later("session", saveSession);
  });
  $("publish").addEventListener("click", run(publish));
  $("save-draft").addEventListener("click", run(saveDraft));
  $("copy").addEventListener("click", run(copyText));
  $("image-generate").addEventListener("click", run(generateImage));
  $("image-cancel").addEventListener("click", cancelImage);
  $("image-prompt").addEventListener("input", () => { state.imagePrompt = $("image-prompt").value; later("session", saveSession); });
  $("image-prompt-button").addEventListener("click", run(async () => { if (await writeImagePrompt()) setStatus("出图提示词已重写，可以修改后点「生图」。"); }));
  $("image-download").addEventListener("click", downloadImage);
  $("image-copy").addEventListener("click", run(copyImage));
  store.onBasketChanged(run(reloadBasket));
  store.onIntent(run(applyIntent));
  styleTemplates.onChanged(() => void loadTemplates().then(render));
  settings.bind();

  async function init() {
    await Promise.all([loadChannelNames().catch(() => {}), restoreSession(), loadTemplates(), settings.load(),
      ai.load().catch(error => setStatus(error.message, true))]);
    sources.setText(state.sourceText);
    await sources.loadBasket();
    settings.render();
    render();
    await applyIntent();
  }

  setStatus("");
  void init().catch(error => setStatus(`读取失败：${error.message}`, true));
})();
