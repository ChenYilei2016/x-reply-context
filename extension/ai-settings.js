// AI 设置页：① API 连接（地址、Key、默认模型）② X 自动回复（连接、模型、润色、Prompt）③ 创作台（每个步骤的连接与模型、出图质量）。
(() => {
  const config = globalThis.XReplyAIConfig;
  const connectionFields = ["baseUrl", "apiKey", "model", "serviceTier", "reasoningEffort"];
  const numericFields = ["typingDelayMin", "typingDelayMax", "maxReplyLength"];
  const promptFields = ["generatePrompt", "rewritePrompt", "polishPrompt"];
  const creationFeatures = config.features.filter(feature => feature.group === "creation");
  const get = id => document.getElementById(id);
  const status = get("status");
  let value, editingId, revision, dirty = false, saving = false, loading = false;

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "扩展连接失败，请重新打开设置。");
    return response;
  }

  /** 每个功能的连接选择框（生成回复、润色在页面里写好，创作台各步骤按配置生成）。 */
  const profileSelect = feature => feature === "reply" ? get("replyProfile") : feature === "polish" ? get("polishProfile") : get(`creationProfile-${feature}`);
  const modelInput = feature => get(`model-${feature}`);

  function buildCreationRows() {
    get("creationFeatures").replaceChildren(...creationFeatures.map(feature => {
      const row = document.createElement("div");
      row.className = "feature";
      const name = Object.assign(document.createElement("span"), { textContent: feature.label });
      const select = Object.assign(document.createElement("select"), { id: `creationProfile-${feature.id}` });
      select.setAttribute("aria-label", `${feature.label}使用的连接`);
      const model = Object.assign(document.createElement("input"), { id: `model-${feature.id}`, autocomplete: "off", spellcheck: false });
      model.setAttribute("aria-label", `${feature.label}的模型`);
      row.append(name, select, model);
      return row;
    }));
  }

  /** 正在编辑的连接：把输入框写回内存中的列表（保存时一起校验）。 */
  function rememberConnection() {
    const profile = value.profiles.find(item => item.id === editingId);
    if (!profile) return;
    profile.name = get("profileName").value;
    for (const field of connectionFields) profile[field] = get(field).value;
  }

  function renderProcessing() {
    const supported = config.isOpenAI(get("baseUrl").value);
    get("openaiMode").hidden = !supported;
  }

  function renderEndpoint() {
    const base = get("baseUrl").value.trim(), preview = get("endpointPreview"), warning = get("baseUrlWarning");
    let address = "", hint = "";
    if (base) {
      try {
        const url = new URL(base);
        address = config.endpoint(url).href;
        if (!url.pathname.replace(/\/+$/, "")) hint = "只填了域名。使用 New API 时，请在域名后加 /v1。";
      } catch {
        hint = "请输入有效的模型接口地址。";
      }
    }
    preview.querySelector("code").textContent = address;
    preview.hidden = !address;
    warning.textContent = hint;
    warning.hidden = !hint;
  }

  const connectionName = id => value.profiles.find(profile => profile.id === id)?.name || "未命名连接";

  /** 连接列表变化后刷新所有选择框，保留仍然存在的选择。 */
  function renderConnections() {
    const options = () => value.profiles.map(profile => new Option(profile.name || "未命名连接", profile.id));
    get("profile").replaceChildren(...options());
    get("profile").value = editingId;
    for (const select of [get("replyProfile"), get("polishProfile")]) {
      const current = select.value;
      select.replaceChildren(...options());
      select.value = value.profiles.some(profile => profile.id === current) ? current : value.profiles[0].id;
    }
    const replyId = get("replyProfile").value;
    for (const feature of creationFeatures) {
      const select = profileSelect(feature.id), current = select.value;
      select.replaceChildren(new Option(`跟随回复的连接（${connectionName(replyId)}）`, ""), ...options());
      select.value = value.profiles.some(profile => profile.id === current) ? current : "";
    }
    const profile = value.profiles.find(item => item.id === editingId);
    get("profileName").value = profile.name;
    for (const field of connectionFields) get(field).value = profile[field] ?? (["serviceTier", "reasoningEffort"].includes(field) ? "auto" : "");
    renderPlaceholders();
    renderProcessing();
    renderEndpoint();
    get("removeProfile").disabled = value.profiles.length <= 1 || saving;
    get("addProfile").disabled = value.profiles.length >= 10 || saving;
  }

  /** 模型输入框的占位提示：所选连接的默认模型（配图为默认出图模型）。 */
  function renderPlaceholders() {
    const defaultModel = id => value.profiles.find(profile => profile.id === id)?.model || "连接未填默认模型";
    const replyId = get("replyProfile").value;
    modelInput("reply").placeholder = `默认：${defaultModel(replyId)}`;
    modelInput("polish").placeholder = `默认：${defaultModel(get("polishProfile").value)}`;
    for (const feature of creationFeatures) {
      modelInput(feature.id).placeholder = feature.id === "images" ? `默认：${config.imageDefaults.imageModel}` :
        `默认：${defaultModel(profileSelect(feature.id).value || replyId)}`;
    }
  }

  function changed(text = "修改尚未保存，点击保存后应用。") { dirty = true; status.textContent = text; }

  function applied(saved) {
    const reply = config.activeConfig(saved);
    const polish = config.polishProfile(saved);
    get("activeProfile").textContent = `已保存：回复 ${reply.name} · ${reply.model}（AI 回复${saved.enabled ? "已开启" : "已关闭"}）` +
      `${polish ? ` · 润色 ${polish.name} · ${polish.model}` : ""} · 成稿 ${config.creationProfile(saved, "drafts").model} · 配图 ${config.imageModel(saved)}`;
  }

  function fill(saved) {
    value = structuredClone(saved);
    editingId = saved.activeProfileId;
    for (const field of promptFields) get(field).value = saved[field];
    for (const field of numericFields) get(field).value = saved[field];
    get("enabled").checked = saved.enabled;
    get("polishEnabled").checked = saved.polishEnabled;
    get("imageQuality").value = saved.imageQuality;
    get("replyProfile").replaceChildren(new Option("", saved.activeProfileId));
    get("replyProfile").value = saved.activeProfileId;
    get("polishProfile").replaceChildren(new Option("", saved.polishProfileId || saved.activeProfileId));
    for (const feature of creationFeatures) {
      profileSelect(feature.id).replaceChildren(new Option("", saved.creationProfileIds[feature.id]));
      profileSelect(feature.id).value = saved.creationProfileIds[feature.id];
    }
    for (const feature of config.features) modelInput(feature.id).value = saved.models[feature.id];
    renderConnections();
    applied(saved);
  }

  function collect() {
    rememberConnection();
    return config.normalizeProfiles({
      ...value, enabled: get("enabled").checked, activeProfileId: get("replyProfile").value,
      polishEnabled: get("polishEnabled").checked, polishProfileId: get("polishProfile").value,
      creationProfileIds: Object.fromEntries(creationFeatures.map(feature => [feature.id, profileSelect(feature.id).value])),
      models: Object.fromEntries(config.features.map(feature => [feature.id, modelInput(feature.id).value])),
      imageQuality: get("imageQuality").value,
      ...Object.fromEntries(promptFields.map(field => [field, get(field).value])),
      ...Object.fromEntries(numericFields.map(field => [field, get(field).valueAsNumber]))
    });
  }

  // ---------- 事件 ----------

  buildCreationRows();
  async function loadSettings() {
    if (saving || loading) return;
    loading = true;
    const controls = [...get("settings").querySelectorAll("input,textarea,select,button")];
    controls.forEach(control => { control.disabled = true; });
    try {
      const { config: saved, revision: savedRevision } = await send({ type: "AI_CONFIG_GET" });
      fill(saved);
      revision = savedRevision;
      dirty = false;
      status.textContent = "";
    } finally {
      loading = false;
      controls.forEach(control => { control.disabled = false; });
      if (value) renderConnections();
      else for (const id of ["save", "profile", "addProfile", "openaiProfile", "removeProfile"]) get(id).disabled = true;
    }
  }
  void loadSettings().catch(error => { status.textContent = error.message; });
  get("reloadConfig").addEventListener("click", () => {
    if (saving || dirty && !confirm("读取最新配置会放弃本页未保存的修改，请先保留需要的内容。继续吗？")) return;
    void loadSettings().catch(error => { status.textContent = error.message; });
  });

  get("settings").addEventListener("input", event => {
    if (!value) return;
    changed();
    if (event.target === get("baseUrl")) { renderProcessing(); renderEndpoint(); }
    if (connectionFields.some(field => event.target === get(field)) || event.target === get("profileName")) rememberConnection();
    if (event.target === get("model") || event.target === get("profileName")) renderPlaceholders();
  });
  get("settings").addEventListener("change", event => {
    if (!value || event.target.tagName !== "SELECT" || event.target === get("profile")) return;
    changed();
    rememberConnection();
    if (event.target === get("replyProfile")) renderConnections();
    renderPlaceholders();
  });
  get("profile").addEventListener("change", () => {
    rememberConnection();
    editingId = get("profile").value;
    renderConnections();
  });
  get("addProfile").addEventListener("click", () => {
    if (!value || saving || value.profiles.length >= 10) return;
    rememberConnection();
    editingId = crypto.randomUUID();
    value.profiles.push({ id: editingId, name: "新连接", baseUrl: "", apiKey: "", model: "", serviceTier: "auto", reasoningEffort: "auto" });
    renderConnections();
    changed();
    get("profileName").focus();
  });
  get("openaiProfile").addEventListener("click", () => {
    if (!value || saving) return;
    rememberConnection();
    let profile = value.profiles.find(item => item.id === "openai");
    if (!profile) {
      if (value.profiles.length >= 10) { status.textContent = "最多保存 10 个连接，请先删除不需要的连接。"; return; }
      profile = { ...config.openAIPreset };
      value.profiles.push(profile);
    }
    editingId = profile.id;
    renderConnections();
    changed("已选择 OpenAI 连接；已有 Key 和自定义值不会被覆盖。填写完成后保存生效。");
  });
  get("removeProfile").addEventListener("click", () => {
    if (!value || saving || value.profiles.length <= 1) return;
    value.profiles = value.profiles.filter(item => item.id !== editingId);
    editingId = value.profiles[0].id;
    renderConnections();
    changed("已从本页移除此连接；用到它的功能改用第一个连接或跟随回复。保存后才删除。");
  });
  get("defaults").addEventListener("click", () => {
    for (const field of promptFields) get(field).value = config.defaults[field];
    changed("已填入默认 Prompt，点击保存后应用。");
  });
  get("settings").addEventListener("submit", async event => {
    event.preventDefault();
    if (!value || saving) return;
    saving = true;
    const controls = [...get("settings").querySelectorAll("input,textarea,select,button")];
    controls.forEach(control => { control.disabled = true; });
    try {
      const next = collect();
      const origins = config.requiredOrigins(next);
      if (origins.length && !await chrome.permissions.request({ origins })) throw new Error("域名未授权，设置未保存；原配置仍然生效。");
      const result = await send({ type: "AI_CONFIG_SAVE", config: next, revision });
      revision = result.revision;
      value = structuredClone(next);
      dirty = false;
      applied(next);
      status.textContent = "已保存，旧配置的生成任务已取消。";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      saving = false;
      controls.forEach(control => { control.disabled = false; });
      renderConnections();
    }
  });
  window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
})();
