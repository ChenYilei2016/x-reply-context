// 写作台页：已选素材 → 结构化角度 → 3 个候选 → 编辑（加权字数、首屏标线）→ 复制。
(() => {
  "use strict";

  const model = globalThis.XReplyMaterialModel;
  const format = globalThis.XReplyFormat;
  const prompt = globalThis.XReplyComposePrompt;
  const { AngleType, AngleCoverage, ...angleModel } = globalThis.XReplyAngleModel;
  const { PostFormat, ...draftModel } = globalThis.XReplyDraftModel;
  const xText = globalThis.XReplyXText;
  const store = globalThis.XReplyStudioStore.create({
    db: globalThis.XReplyMaterialDB.create(), cluster: globalThis.XReplyTopicCluster.cluster, draftModel, prompt
  });

  const SAVE_DELAY = 400;
  const ANGLES_HINT = "模型按 JSON 返回 3～5 个角度，并对照同话题的 X 帖子标出“已有人写”。潜力只看同角度参考帖的真实数据。";
  const STALE_ANGLES_HINT = "素材已经变化，下面是上一组素材的角度，建议重新找角度。";
  const SAMPLE_SEPARATOR = /^\s*---\s*$/m;

  const $ = id => document.getElementById(id);
  const state = {
    materialIds: [], materials: [], missing: [], references: [], channelNames: {},
    profile: null, ownPosts: [], steps: {},
    angles: [], angleIndex: null, angleMaterialKey: "",
    formatId: PostFormat.DEFAULT.id, instructions: "", candidates: [], candidateIndex: 0,
    pending: null
  };
  const timers = {};

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
  }

  /** 延迟保存，连续输入只写一次。 */
  function later(key, work) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => void work().catch(error => setStatus(error.message, true)), SAVE_DELAY);
  }

  const materialKey = ids => ids.join("|");
  const channelName = id => state.channelNames[id] || id;
  const sourceName = material => material.channelIds.map(channelName).join("、");
  const currentFormat = () => PostFormat.from(state.formatId) || PostFormat.DEFAULT;
  const currentCandidate = () => state.candidates[state.candidateIndex];
  const anglesCurrent = () => state.angleMaterialKey === materialKey(state.materialIds);

  // ---------- 数据 ----------

  async function loadChannelNames() {
    const status = await chrome.runtime.sendMessage({ type: "CREATION_CHANNELS_STATUS" });
    if (status?.ok) for (const channel of status.channels) state.channelNames[channel.id] = channel.name;
  }

  async function loadModels() {
    const status = await chrome.runtime.sendMessage({ type: "AI_STUDIO_STATUS" });
    if (!status?.ok) throw new Error(status?.error || "读取创作模型状态失败");
    state.steps = Object.fromEntries(status.steps.map(step => [step.id, step]));
  }

  async function loadMaterials() {
    state.materialIds = await store.basketIds();
    const { materials, missing } = await store.basketMaterials(state.materialIds);
    state.materials = materials;
    state.missing = missing;
    state.references = await store.referencePosts(materials);
  }

  async function loadProfile() {
    [state.profile, state.ownPosts] = await Promise.all([store.profile(), store.ownPosts()]);
  }

  async function restoreSession() {
    const saved = await store.session();
    if (!saved) return;
    if (Array.isArray(saved.angles)) state.angles = saved.angles.filter(angle => AngleType.from(angle?.type));
    state.angleMaterialKey = typeof saved.angleMaterialKey === "string" ? saved.angleMaterialKey : "";
    state.angleIndex = Number.isInteger(saved.angleIndex) && state.angles[saved.angleIndex] ? saved.angleIndex : null;
    if (PostFormat.from(saved.formatId)) state.formatId = saved.formatId;
    if (typeof saved.instructions === "string") state.instructions = saved.instructions;
    if (Array.isArray(saved.candidates)) {
      state.candidates = saved.candidates.filter(item => typeof item?.text === "string" && typeof item.original === "string");
    }
    state.candidateIndex = Number.isInteger(saved.candidateIndex) && state.candidates[saved.candidateIndex] ? saved.candidateIndex : 0;
  }

  const saveSession = () => store.saveSession({
    angles: state.angles, angleMaterialKey: state.angleMaterialKey, angleIndex: state.angleIndex,
    formatId: state.formatId, instructions: state.instructions, candidates: state.candidates, candidateIndex: state.candidateIndex
  });

  const samples = () => draftModel.selectSamples({
    manual: state.profile.manualSamples.map((text, index) => ({ id: `manual-${index}`, text })),
    own: state.ownPosts, excluded: state.profile.excludedSampleIds
  });

  // ---------- 渲染：素材 ----------

  function materialMetrics(material) {
    const metrics = material.metrics || {};
    const parts = [];
    if (metrics.views !== undefined) parts.push(`浏览 ${format.count(metrics.views)}`);
    const velocity = model.velocity(material, Date.now());
    if (velocity !== null) parts.push(`流速 ${format.velocity(velocity)}`);
    if (metrics.rank !== undefined) parts.push(`榜单第 ${metrics.rank} 名`);
    return parts.join(" · ");
  }

  function renderMaterial(material, index) {
    const node = element("li", undefined, "material");
    const head = element("p", [`M${index + 1}`, sourceName(material), model.MaterialKind.from(material.kind)?.label,
      model.Coverage.from(material.coverage)?.label, format.ago(material.publishedAt || material.firstSeenAt)].filter(Boolean).join(" · "), "muted");
    const text = [material.title, material.text].filter(Boolean).join("\n");
    const body = element("p", text.length > 220 ? `${text.slice(0, 220)}…` : text, "material-text");
    const actions = element("div", undefined, "row");
    const remove = element("button", "移出");
    remove.type = "button";
    remove.disabled = Boolean(state.pending);
    remove.addEventListener("click", () => void removeMaterial(material.id).catch(error => setStatus(error.message, true)));
    actions.append(link("打开原文 ↗", material.url), remove);
    const metrics = materialMetrics(material);
    node.append(head, body, ...(metrics ? [element("p", metrics, "material-metrics")] : []), actions);
    return node;
  }

  function renderMaterials() {
    if (!state.materials.length) {
      const empty = element("li", "还没有选素材。", "empty");
      empty.append(" ", link("去「选题雷达」选入 1～3 条 ↗", "radar.html"));
      $("materials").replaceChildren(empty);
    } else {
      $("materials").replaceChildren(...state.materials.map(renderMaterial));
    }
    const warnings = state.materials.length ?
      prompt.materialWarnings(state.materials.map(material => prompt.toPromptMaterial(material, "")), Date.now()) : [];
    if (state.missing.length) warnings.push(`${state.missing.length} 条已选素材已被清理，已忽略。`);
    $("warnings").replaceChildren(...warnings.map(text => element("li", text)));

    $("references").hidden = !state.references.length;
    $("references-summary").textContent = `同话题 X 帖 ${state.references.length} 条（用来判断角度是否已有人写）`;
    $("reference-list").replaceChildren(...state.references.map((post, index) => {
      const item = element("li");
      item.append(element("strong", `R${index + 1} `), `@${post.author?.handle || "?"} · 浏览 ${format.count(post.metrics.views)} · `,
        link(post.text.slice(0, 60), post.url));
      return item;
    }));
  }

  // ---------- 渲染：人设与样本 ----------

  function renderProfile() {
    if (document.activeElement !== $("persona")) $("persona").value = state.profile.persona;
    if (document.activeElement !== $("manual-samples")) $("manual-samples").value = state.profile.manualSamples.join("\n---\n");
    const selected = samples();
    $("samples").replaceChildren(...(selected.length ? selected.map(sample => {
      const item = element("li");
      item.append(element("span", sample.origin === "manual" ? "手动" : `我的帖子 · 浏览 ${format.count(sample.views)}`, "badge"),
        " ", sample.text.length > 90 ? `${sample.text.slice(0, 90)}…` : sample.text);
      if (sample.origin === "own") {
        const exclude = element("button", "排除", "small");
        exclude.type = "button";
        exclude.addEventListener("click", () => void updateProfile({ excludedSampleIds: [...state.profile.excludedSampleIds, sample.id] }));
        item.append(" ", exclude);
      }
      return item;
    }) : [element("li", "暂无样本：在下方粘贴手动样本，或让 bot 在 feed 里给自己的帖子标记 own。", "muted")]));
    const excluded = state.profile.excludedSampleIds.length;
    $("samples-restore").hidden = !excluded;
    $("samples-restore").textContent = `恢复已排除的 ${excluded} 条`;
  }

  // ---------- 渲染：模型状态 ----------

  function renderModels() {
    for (const container of document.querySelectorAll(".model[data-step]")) {
      const step = state.steps[container.dataset.step];
      container.replaceChildren();
      if (!step) continue;
      if (!step.configured) {
        container.append("模型未配置 · ", link("去 AI 设置", "../ai-settings.html"));
        continue;
      }
      container.append(`${step.name} · ${step.model}`);
      if (!step.permitted) {
        const authorize = element("button", "授权模型域名", "small");
        authorize.type = "button";
        authorize.addEventListener("click", () => void authorize(step).catch(error => setStatus(error.message, true)));
        container.append(" ", authorize);
      }
    }
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
    node.querySelector(".angle-badges").append(
      element("span", AngleType.from(angle.type).label, "badge type"),
      element("span", coverage.label, `badge ${coverage.id}`));
    node.querySelector(".angle-hook").textContent = angle.hook;
    node.querySelector(".angle-outline").replaceChildren(...angle.outline.map(item => element("li", item)));
    const meta = node.querySelector(".angle-meta");
    meta.textContent = angle.evidence.length ? `依据 ${angle.evidence.map(index => `M${index + 1}`).join("、")}` : "未标注依据素材";
    for (const post of angle.coveringPosts) {
      meta.append(" · ", link(`@${post.author || "?"}${post.views !== undefined ? ` ${format.count(post.views)} 浏览` : ""}`, post.url));
    }
    node.querySelector(".angle-risk").textContent = angle.risk ? `风险：${angle.risk}` : "";
    node.querySelector(".angle-risk").hidden = !angle.risk;
    node.querySelector(".angle-potential").textContent = potentialText(angle);
    const use = node.querySelector(".use");
    use.disabled = Boolean(state.pending);
    use.addEventListener("click", () => void writeDrafts(index));
    return node;
  }

  function renderAngles() {
    $("angles").replaceChildren(...state.angles.map(renderAngle));
    const stale = state.angles.length > 0 && !anglesCurrent();
    $("angles-hint").hidden = state.angles.length > 0 && !stale;
    $("angles-hint").textContent = stale ? STALE_ANGLES_HINT : ANGLES_HINT;
    $("find-angles").disabled = Boolean(state.pending) || !state.materials.length;
    $("find-angles").textContent = state.pending?.step === "angles" ? "正在找角度…" : state.angles.length ? "重新找角度" : "找角度";
  }

  // ---------- 渲染：成稿与编辑 ----------

  function renderDraftControls() {
    const angle = state.angles[state.angleIndex];
    $("angle-chip").hidden = !angle;
    if (angle) $("angle-chip").firstElementChild.textContent = `角度：${AngleType.from(angle.type).label} · ${angle.hook}`;
    $("format").value = state.formatId;
    if (document.activeElement !== $("instructions")) $("instructions").value = state.instructions;
    $("write").disabled = Boolean(state.pending) || !state.materials.length;
    $("write").textContent = state.pending?.step === "drafts" ? "正在生成…" : state.candidates.length ? "重新生成 3 个候选" : "生成 3 个候选";
    $("cancel").hidden = !state.pending;
    $("candidates").replaceChildren(...state.candidates.map((candidate, index) => {
      const tab = element("button", `候选 ${index + 1}${candidate.hookStyle ? ` · ${candidate.hookStyle}` : ""}${candidate.text !== candidate.original ? " · 已改" : ""}`);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(index === state.candidateIndex));
      tab.addEventListener("click", () => selectCandidate(index));
      return tab;
    }));
  }

  /** 发布时的完整正文：引用转发在末尾附上原帖链接（X 会把末尾的帖子链接显示为引用）。 */
  function publishText(text) {
    const target = PostFormat.quoteTarget(currentFormat(), state.materials);
    return target ? `${text.trimEnd()}\n${target}` : text;
  }

  function renderFoldPreview(measure) {
    const preview = $("fold-preview");
    if (!measure.folded) {
      preview.replaceChildren(element("p", "全文都在时间线首屏内，不会折叠。", "muted"));
      return;
    }
    preview.replaceChildren(
      element("span", measure.text.slice(0, measure.fold)),
      element("span", "首屏到此 · 之后折叠为“显示更多”", "fold-line"),
      element("span", measure.text.slice(measure.fold), "folded"));
  }

  function renderMeter() {
    const candidate = currentCandidate();
    $("editor-area").hidden = !candidate;
    if (!candidate) return;
    const measure = xText.measure(publishText(candidate.text));
    const parts = [`加权字数 ${measure.length} / ${xText.PREMIUM_LIMIT.toLocaleString("zh-CN")}（Premium）`];
    parts.push(measure.folded ? `超过首屏 ${xText.FOLD_LIMIT}，钩子要放在标线之前` : `首屏内（≤ ${xText.FOLD_LIMIT}）`);
    $("meter").textContent = parts.join(" · ");
    $("meter").dataset.error = String(measure.overPremium);
    const target = PostFormat.quoteTarget(currentFormat(), state.materials);
    $("quote-target").hidden = !target;
    $("quote-target").textContent = target ? `复制时末尾附上原帖链接（计 23 字）：${target}` : "";
    $("copy").textContent = target ? "复制正文（附原帖链接）" : "复制正文";
    $("revert").disabled = candidate.text === candidate.original;
    renderFoldPreview(measure);
  }

  function renderEditor() {
    const candidate = currentCandidate();
    if (candidate && $("editor").value !== candidate.text) $("editor").value = candidate.text;
    renderMeter();
  }

  function render() {
    renderMaterials();
    renderModels();
    renderAngles();
    renderDraftControls();
    renderEditor();
  }

  // ---------- 模型请求 ----------

  async function authorize(step) {
    if (!await chrome.permissions.request({ origins: [step.origin] })) throw new Error("未授权模型域名。");
    await loadModels();
    render();
    setStatus("已授权。");
  }

  /** 发起一次创作请求，返回模型文本；被取消时返回 null。 */
  async function requestModel(stepId, input) {
    await loadModels();
    const step = state.steps[stepId];
    if (!step?.configured) throw new Error(`请先在 AI 设置中为「${step?.label || stepId}」配置模型。`);
    if (!step.permitted) throw new Error("模型域名尚未授权，点模型名旁的「授权模型域名」后重试。");
    const id = crypto.randomUUID();
    state.pending = { id, step: stepId };
    render();
    try {
      const result = await chrome.runtime.sendMessage({ type: "AI_REQUEST", kind: "studio", step: stepId, id, input });
      if (state.pending?.id !== id || result?.cancelled) return null;
      if (!result?.ok) throw new Error(result?.error || "创作服务暂不可用。");
      return result.text;
    } finally {
      if (state.pending?.id === id) state.pending = null;
      render();
    }
  }

  function cancelRequest() {
    const pending = state.pending;
    if (!pending) return;
    state.pending = null;
    void chrome.runtime.sendMessage({ type: "AI_CANCEL", ids: [pending.id] }).catch(() => {});
    render();
    setStatus("已取消。");
  }

  const promptMaterials = () => state.materials.map(material => prompt.toPromptMaterial(material, sourceName(material)));

  async function findAngles() {
    const now = Date.now();
    const references = prompt.checkReferences(state.references.map(post => prompt.toPromptReference(post, model.velocity(post, now))));
    setStatus(`正在找角度 · ${state.materials.length} 条素材、${references.length} 条参考帖 · 最长等待 90 秒`);
    const text = await requestModel("angles", { materials: promptMaterials(), references, persona: state.profile.persona });
    if (text === null) return;
    const { angles, dropped } = angleModel.parse(text, { materials: state.materials.length, references: references.length });
    state.angles = angleModel.assess(angles, references);
    state.angleMaterialKey = materialKey(state.materialIds);
    state.angleIndex = null;
    await saveSession();
    render();
    const covered = state.angles.filter(angle => angle.coverage === AngleCoverage.COVERED.id).length;
    setStatus(`得到 ${state.angles.length} 个角度（${covered} 个已有人写）${dropped ? `，${dropped} 个格式不完整已丢弃` : ""}。挑一个点「用这个写」。`);
  }

  async function writeDrafts(angleIndex = state.angleIndex) {
    if (state.pending) return;
    try {
      const edited = state.candidates.some(candidate => candidate.text !== candidate.original);
      if (edited && !confirm("重新生成会替换当前候选（包括你改过的内容），继续吗？")) return;
      state.angleIndex = angleIndex;
      const angle = state.angles[angleIndex];
      const selectedSamples = samples();
      setStatus(`正在生成 3 个候选 · ${currentFormat().label}${angle ? ` · ${AngleType.from(angle.type).label}角度` : ""} · 样本 ${selectedSamples.length} 条 · 最长等待 90 秒`);
      const text = await requestModel("drafts", {
        materials: promptMaterials(), format: state.formatId, persona: state.profile.persona,
        angle: angle ? { type: angle.type, hook: angle.hook, outline: angle.outline } : undefined,
        samples: selectedSamples.map(sample => sample.text), instructions: state.instructions
      });
      if (text === null) return;
      state.candidates = draftModel.parse(text).map(draft => ({ ...draft, original: draft.text }));
      state.candidateIndex = 0;
      await saveSession();
      render();
      setStatus(`得到 ${state.candidates.length} 个候选，可切换、编辑后复制。`);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  // ---------- 编辑与其他操作 ----------

  function selectCandidate(index) {
    state.candidateIndex = index;
    render();
    later("session", saveSession);
  }

  async function copyText() {
    const candidate = currentCandidate();
    if (!candidate?.text.trim()) throw new Error("正文是空的。");
    const text = publishText(candidate.text);
    if (xText.measure(text).overPremium) throw new Error(`超过 Premium 上限 ${xText.PREMIUM_LIMIT} 加权字数，请删减。`);
    await navigator.clipboard.writeText(text);
    await store.markUsed(state.materials.map(material => material.id));
    setStatus("已复制。去 X 粘贴发布；用过的素材在雷达里会标为“已写过”。");
  }

  async function removeMaterial(id) {
    await store.saveBasket(state.materialIds.filter(item => item !== id));
  }

  async function updateProfile(patch) {
    try {
      state.profile = { ...state.profile, ...patch };
      await store.saveProfile(state.profile);
      renderProfile();
      $("profile-status").textContent = "已保存";
    } catch (error) {
      $("profile-status").textContent = error.message;
    }
  }

  function parseManualSamples(text) {
    return text.split(SAMPLE_SEPARATOR).map(item => item.trim()).filter(Boolean).slice(0, store.MANUAL_SAMPLE_LIMIT);
  }

  async function reloadMaterials() {
    await loadMaterials();
    render();
  }

  // ---------- 事件 ----------

  $("format").replaceChildren(...PostFormat.values().map(item => new Option(`${item.label}（约 ${item.min}～${item.max} 字）`, item.id)));
  $("format").addEventListener("change", () => { state.formatId = $("format").value; render(); later("session", saveSession); });
  $("instructions").addEventListener("input", () => { state.instructions = $("instructions").value; later("session", saveSession); });
  $("find-angles").addEventListener("click", () => void findAngles().catch(error => setStatus(error.message, true)));
  $("write").addEventListener("click", () => void writeDrafts());
  $("cancel").addEventListener("click", cancelRequest);
  $("angle-clear").addEventListener("click", () => { state.angleIndex = null; render(); later("session", saveSession); });
  $("editor").addEventListener("input", () => {
    const candidate = currentCandidate();
    if (!candidate) return;
    candidate.text = $("editor").value;
    renderMeter();
    renderDraftControls();
    later("session", saveSession);
  });
  $("revert").addEventListener("click", () => {
    const candidate = currentCandidate();
    if (!candidate) return;
    candidate.text = candidate.original;
    render();
    later("session", saveSession);
  });
  $("copy").addEventListener("click", () => void copyText().catch(error => setStatus(error.message, true)));
  $("persona").addEventListener("input", () => {
    $("profile-status").textContent = "正在保存…";
    later("profile", () => updateProfile({ persona: $("persona").value.trim() ? $("persona").value : draftModel.DEFAULT_PERSONA }));
  });
  $("persona-default").addEventListener("click", () => {
    $("persona").value = draftModel.DEFAULT_PERSONA;
    void updateProfile({ persona: draftModel.DEFAULT_PERSONA });
  });
  $("manual-samples").addEventListener("change", () => void updateProfile({ manualSamples: parseManualSamples($("manual-samples").value) }));
  $("samples-restore").addEventListener("click", () => void updateProfile({ excludedSampleIds: [] }));
  store.onBasketChanged(() => void reloadMaterials().catch(error => setStatus(error.message, true)));

  async function init() {
    await Promise.all([loadChannelNames().catch(() => {}), loadProfile(), restoreSession(), loadModels().catch(error => setStatus(error.message, true))]);
    await loadMaterials();
    renderProfile();
    render();
  }

  void init().catch(error => setStatus(`读取失败：${error.message}`, true));
})();
