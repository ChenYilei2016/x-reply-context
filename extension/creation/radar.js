// 选题雷达页：读取本机素材库 → 聚合话题 → 筛选排序 → 详情与选材。
(() => {
  "use strict";

  const model = globalThis.XReplyMaterialModel;
  const format = globalThis.XReplyFormat;
  const { cluster } = globalThis.XReplyTopicCluster;
  const { RadarSort, rank } = globalThis.XReplyRadarRanking;
  const { RadarView, matchesTopic, countByCategory } = globalThis.XReplyRadarFilters;
  const db = globalThis.XReplyMaterialDB.create();

  const HOUR = 60 * 60 * 1000;
  const PAGE_SIZE = 30;
  /** 一次最多读入的素材数，避免全量加载。 */
  const MATERIAL_LIMIT = 3000;
  const BASKET_LIMIT = 3;
  const BASKET_KEY = "creationBasket";
  const PREFERENCES_KEY = "creationRadarPreferences";
  /** 页面重新可见时，数据超过这个时间就重新读取。 */
  const STALE_AFTER = 2 * 60 * 1000;

  const $ = id => document.getElementById(id);
  const state = {
    view: RadarView.ALL, category: "all", kind: "all", windowHours: 48, sort: RadarSort.COMPOSITE, query: "", page: 1,
    topics: [], materials: new Map(), channelNames: {}, basket: [], activeTopicId: null, loadedAt: 0, busy: false
  };

  // ---------- 数据 ----------

  async function loadChannelNames() {
    const status = await chrome.runtime.sendMessage({ type: "CREATION_CHANNELS_STATUS" });
    if (!status?.ok) return;
    for (const channel of status.channels) state.channelNames[channel.id] = channel.name;
  }

  async function loadTopics() {
    const now = Date.now();
    const materials = await db.recent({ since: now - state.windowHours * HOUR, limit: MATERIAL_LIMIT });
    const visible = materials.filter(material => state.view.includesMaterial(material));
    state.materials = new Map(materials.map(material => [material.id, material]));
    state.topics = rank(visible, { now, sort: state.sort, model, cluster });
    state.loadedAt = now;
    state.page = 1;
    return { materialCount: visible.length, truncated: materials.length >= MATERIAL_LIMIT };
  }

  async function loadBasket() {
    const saved = (await chrome.storage.local.get(BASKET_KEY))[BASKET_KEY];
    state.basket = Array.isArray(saved) ? saved.filter(id => typeof id === "string").slice(0, BASKET_LIMIT) : [];
  }

  const saveBasket = () => chrome.storage.local.set({ [BASKET_KEY]: state.basket });

  async function loadPreferences() {
    const saved = (await chrome.storage.local.get(PREFERENCES_KEY))[PREFERENCES_KEY] || {};
    if (model.MaterialCategory.from(saved.category)) state.category = saved.category;
    if (["all", ...model.MaterialKind.values().map(kind => kind.id)].includes(saved.kind)) state.kind = saved.kind;
    if ([24, 48, 72].includes(saved.windowHours)) state.windowHours = saved.windowHours;
    state.sort = RadarSort.from(saved.sort);
  }

  function savePreferences() {
    void chrome.storage.local.set({ [PREFERENCES_KEY]: { category: state.category, kind: state.kind, windowHours: state.windowHours, sort: state.sort.id } });
  }

  const visibleTopics = () => state.topics.filter(topic => matchesTopic(topic, state));
  const channelName = id => state.channelNames[id] || id;
  const kindLabel = id => model.MaterialKind.from(id)?.label || id;
  const categoryLabel = id => model.MaterialCategory.from(id)?.label || id;

  // ---------- 渲染：通用 ----------

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function setStatus(text, error = false) {
    $("status").textContent = text;
    $("status").dataset.error = String(error);
  }

  function metricParts(entries) {
    return entries.filter(([, value]) => value !== null && value !== undefined && value !== "");
  }

  function appendMetrics(container, parts) {
    container.replaceChildren();
    parts.forEach(([label, value, strong], index) => {
      if (index) container.append(" · ");
      container.append(`${label} `);
      container.append(strong ? element("strong", value) : value);
    });
  }

  // ---------- 渲染：列表 ----------

  function renderTabs() {
    const counts = countByCategory(state.topics.filter(topic => matchesTopic(topic, { ...state, category: "all" })));
    const tabs = [["all", "全部"], ...model.MaterialCategory.values().map(category => [category.id, category.label])];
    $("category-tabs").replaceChildren(...tabs.filter(([id]) => id === "all" || counts[id]).map(([id, label]) => {
      const tab = element("button");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(state.category === id));
      tab.append(label, element("small", String(counts[id] || 0)));
      tab.addEventListener("click", () => { state.category = id; state.page = 1; savePreferences(); render(); });
      return tab;
    }));
  }

  function topicMetrics(topic) {
    const now = Date.now();
    return metricParts([
      ["最高浏览", topic.maxViews !== null ? format.count(topic.maxViews) : null, true],
      ["流速", topic.maxVelocity !== null ? format.velocity(topic.maxVelocity) : null, true],
      ["爆文", topic.maxBreakout !== null ? format.ratio(topic.maxBreakout) : null, false],
      ["加速", topic.maxAcceleration > 0 ? `+${format.velocity(topic.maxAcceleration)}` : null, false],
      ["榜单第", topic.bestRank ? `${topic.bestRank} 名` : null, false],
      ["", format.ago(topic.latestAt, now), false]
    ]);
  }

  function renderTopic(topic, index) {
    const node = $("topic-template").content.firstElementChild.cloneNode(true);
    node.classList.toggle("active", topic.id === state.activeTopicId);
    node.querySelector(".rank").textContent = String(index + 1);
    const title = node.querySelector(".topic-title");
    title.textContent = topic.title;
    title.addEventListener("click", () => openDrawer(topic.id));

    const badges = node.querySelector(".topic-badges");
    badges.append(element("span", categoryLabel(topic.category), "badge category"));
    if (topic.sourceCount > 1) badges.append(element("span", `${topic.sourceCount} 个来源`, "badge sources"));
    if (topic.xPostCount) badges.append(element("span", `X 帖 ${topic.xPostCount}`, "badge"));
    if (topic.members.some(member => member.marks?.usedAt)) badges.append(element("span", "已写过", "badge used"));
    for (const id of topic.channelIds.slice(0, 3)) badges.append(element("span", channelName(id), "badge"));
    appendMetrics(node.querySelector(".topic-metrics"), topicMetrics(topic));

    const pick = node.querySelector(".pick");
    const picked = state.basket.includes(topic.leader.id);
    pick.textContent = picked ? "已选" : "选入";
    pick.setAttribute("aria-pressed", String(picked));
    pick.addEventListener("click", () => act(() => toggleBasket(topic.leader.id)));
    const save = node.querySelector(".save");
    save.textContent = topic.saved ? "已收藏" : "收藏";
    save.setAttribute("aria-pressed", String(topic.saved));
    save.addEventListener("click", () => act(() => toggleSave(topic)));
    const hide = node.querySelector(".hide");
    hide.textContent = state.view === RadarView.HIDDEN ? "恢复" : "隐藏";
    hide.addEventListener("click", () => act(() => toggleHide(topic)));
    for (const button of [pick, save, hide]) button.disabled = state.busy;
    return node;
  }

  function renderTopics() {
    const topics = visibleTopics();
    const shown = topics.slice(0, state.page * PAGE_SIZE);
    if (!topics.length) {
      const empty = element("li", "", "empty");
      empty.append(state.topics.length ? "没有符合条件的话题，换个分类或关键词试试。" : "素材库还没有内容。");
      if (!state.topics.length && state.view === RadarView.ALL) {
        const link = element("a", "去「素材渠道」授权并拉取 ↗");
        link.href = "channels.html";
        link.target = "_blank";
        empty.append(" ", link);
      }
      $("topics").replaceChildren(empty);
    } else {
      $("topics").replaceChildren(...shown.map(renderTopic));
    }
    $("more").hidden = shown.length >= topics.length;
  }

  function renderSummary(loadInfo) {
    const multiSource = state.topics.filter(topic => topic.sourceCount > 1).length;
    const parts = [`近 ${state.windowHours} 小时 ${state.topics.reduce((sum, topic) => sum + topic.members.length, 0)} 条素材`,
      `合并为 ${state.topics.length} 个话题`, `${multiSource} 个多来源`, `读取于 ${format.time(state.loadedAt)}`];
    if (loadInfo?.truncated) parts.push(`已达单次上限 ${MATERIAL_LIMIT} 条`);
    $("summary").textContent = parts.join(" · ");
  }

  // ---------- 渲染：详情抽屉 ----------

  function memberMetrics(material) {
    const now = Date.now();
    const metrics = material.metrics || {};
    const parts = metricParts([
      ["浏览", metrics.views !== undefined ? format.count(metrics.views) : null, true],
      ["流速", (() => { const value = model.velocity(material, now); return value !== null ? format.velocity(value) : null; })(), true],
      ["爆文", (() => { const value = model.breakoutRatio(material); return value !== null ? format.ratio(value) : null; })(), false],
      ["赞", metrics.likes !== undefined ? format.count(metrics.likes) : null, false],
      ["转", metrics.reposts !== undefined ? format.count(metrics.reposts) : null, false],
      ["评", metrics.replies !== undefined ? format.count(metrics.replies) : null, false],
      ["藏", metrics.bookmarks !== undefined ? format.count(metrics.bookmarks) : null, false],
      ["星标", metrics.stars !== undefined ? format.count(metrics.stars) : null, false],
      ["名次", metrics.rank !== undefined ? `第 ${metrics.rank}` : null, false]
    ]);
    if (parts.length) parts.push(["", `（${model.MetricsSource.from(material.metricsSource)?.label}）`, false]);
    return parts;
  }

  function renderMember(material) {
    const node = $("member-template").content.firstElementChild.cloneNode(true);
    const when = format.ago(material.publishedAt || material.firstSeenAt);
    node.querySelector(".member-head").textContent =
      `${material.channelIds.map(channelName).join("、")} · ${kindLabel(material.kind)} · ${when} · ${model.Coverage.from(material.coverage)?.label}`;
    const author = material.author;
    node.querySelector(".member-author").textContent = author ?
      `${author.name || ""}${author.handle ? ` @${author.handle}` : ""}${author.followers !== undefined ? ` · 粉丝 ${format.count(author.followers)}` : ""}` : "";
    node.querySelector(".member-author").hidden = !author;
    const text = [material.title, material.text].filter(Boolean).join("\n");
    node.querySelector(".member-text").textContent = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    appendMetrics(node.querySelector(".member-metrics"), memberMetrics(material));
    node.querySelector(".member-note").textContent = material.note;
    node.querySelector(".member-note").hidden = !material.note;
    node.querySelector(".open").href = material.url;
    const pick = node.querySelector(".pick");
    const picked = state.basket.includes(material.id);
    pick.textContent = picked ? "移出" : "选入";
    pick.setAttribute("aria-pressed", String(picked));
    pick.disabled = state.busy;
    pick.addEventListener("click", () => act(() => toggleBasket(material.id)));
    return node;
  }

  function renderDrawer() {
    const topic = state.topics.find(item => item.id === state.activeTopicId);
    $("drawer").hidden = !topic;
    if (!topic) return;
    $("drawer-title").textContent = topic.title;
    $("drawer-meta").textContent = [`${categoryLabel(topic.category)}`, `${topic.members.length} 条素材`, `${topic.sourceCount} 个来源`,
      `综合分 ${topic.score.toFixed(1)}`].join(" · ");
    $("drawer-members").replaceChildren(...topic.members.map(renderMember));
  }

  // ---------- 渲染：选材栏 ----------

  function renderBasket() {
    $("basket").hidden = !state.basket.length;
    $("basket-count").textContent = `已选 ${state.basket.length}/${BASKET_LIMIT}`;
    $("basket-items").replaceChildren(...state.basket.map(id => {
      const material = state.materials.get(id);
      return element("li", material ? (material.title || material.text).slice(0, 40) : "（不在当前时间范围）");
    }));
    $("basket-copy").disabled = $("basket-clear").disabled = state.busy;
  }

  function render(loadInfo) {
    for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === state.view.id));
    $("view-title").textContent = state.view === RadarView.ALL ? "选题雷达" : state.view.label;
    $("pull").disabled = state.busy;
    renderTabs();
    renderTopics();
    renderDrawer();
    renderBasket();
    if (loadInfo) renderSummary(loadInfo);
  }

  // ---------- 操作 ----------

  /** 串行执行操作，失败显示在状态行。 */
  async function act(operation) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await operation();
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function reload() {
    const info = await loadTopics();
    render(info);
  }

  function openDrawer(topicId) {
    state.activeTopicId = topicId;
    render();
  }

  async function toggleBasket(materialId) {
    if (state.basket.includes(materialId)) {
      state.basket = state.basket.filter(id => id !== materialId);
    } else {
      if (state.basket.length >= BASKET_LIMIT) throw new Error(`一次最多选 ${BASKET_LIMIT} 条素材，先移出一条。`);
      state.basket = [...state.basket, materialId];
    }
    await saveBasket();
    setStatus("");
  }

  /** 收藏：未收藏时收藏锚点；已收藏时取消该话题全部成员的收藏。 */
  async function toggleSave(topic) {
    if (topic.saved) await Promise.all(topic.members.filter(member => member.marks?.saved).map(member => db.setMark(member.id, "saved", false)));
    else await db.setMark(topic.leader.id, "saved", true);
    await reload();
  }

  /** 隐藏或恢复整个话题（全部成员）。 */
  async function toggleHide(topic) {
    const hidden = state.view !== RadarView.HIDDEN;
    await Promise.all(topic.members.map(member => db.setMark(member.id, "hidden", hidden)));
    if (state.activeTopicId === topic.id) state.activeTopicId = null;
    await reload();
    setStatus(hidden ? "已隐藏该话题，可在「已隐藏」中恢复。" : "已恢复该话题。");
  }

  async function pull() {
    setStatus("正在拉取各渠道，通常需要 10～30 秒…");
    const result = await chrome.runtime.sendMessage({ type: "CREATION_CHANNELS_RUN" });
    if (!result?.ok) throw new Error(result?.error || "后台暂不可用");
    if (result.busy) throw new Error("已有一轮拉取在进行，稍后再试。");
    await reload();
    const inserted = result.results.reduce((sum, row) => sum + (row.inserted || 0), 0);
    const failed = result.results.filter(row => !row.ok).length;
    const unpermitted = result.skipped.filter(row => row.skipped === "permission").length;
    const notes = [`新增 ${inserted} 条素材`];
    if (failed) notes.push(`${failed} 个渠道失败`);
    if (unpermitted) notes.push(`${unpermitted} 个渠道未授权（在「素材渠道」页授权）`);
    setStatus(notes.join("，") + "。", Boolean(failed));
  }

  function materialText(material, index) {
    const metrics = memberMetrics(material).map(([label, value]) => `${label}${label ? " " : ""}${value}`).join(" · ");
    const lines = [
      `【素材 ${index + 1}】${material.title || material.text.split("\n")[0].slice(0, 60)}`,
      `来源：${material.channelIds.map(channelName).join("、")} · ${format.time(material.publishedAt || material.firstSeenAt)} · ${material.url}`
    ];
    if (material.author) lines.push(`作者：${material.author.name || ""} @${material.author.handle || ""}`.trim());
    if (metrics) lines.push(`数据：${metrics}`);
    if (material.text) lines.push(`内容：${material.text.slice(0, 1500)}`);
    return lines.join("\n");
  }

  async function copyBasket() {
    const materials = (await Promise.all(state.basket.map(id => state.materials.get(id) || db.get(id)))).filter(Boolean);
    if (!materials.length) throw new Error("已选素材已被清理，请重新选择。");
    await navigator.clipboard.writeText(materials.map(materialText).join("\n\n"));
    setStatus(`已复制 ${materials.length} 条素材，可粘贴给任意 AI 或写作工具。`);
  }

  // ---------- 事件 ----------

  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => act(async () => {
      state.view = RadarView.from(button.dataset.view);
      state.activeTopicId = null;
      await reload();
    }));
  }
  $("sort").replaceChildren(...RadarSort.values().map(sort => Object.assign(element("option", `按${sort.label}`), { value: sort.id })));
  $("sort").addEventListener("change", () => {
    state.sort = RadarSort.from($("sort").value);
    state.topics.sort((a, b) => state.sort.compare(a, b));
    state.page = 1;
    savePreferences();
    render();
  });
  $("kind").addEventListener("change", () => { state.kind = $("kind").value; state.page = 1; savePreferences(); render(); });
  $("window").addEventListener("change", () => act(async () => {
    state.windowHours = Number($("window").value);
    savePreferences();
    await reload();
  }));
  $("query").addEventListener("input", () => { state.query = $("query").value; state.page = 1; render(); });
  $("more").addEventListener("click", () => { state.page++; render(); });
  $("drawer-close").addEventListener("click", () => { state.activeTopicId = null; render(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && state.activeTopicId) { state.activeTopicId = null; render(); } });
  $("pull").addEventListener("click", () => act(pull));
  $("basket-copy").addEventListener("click", () => act(copyBasket));
  $("basket-clear").addEventListener("click", () => act(async () => { state.basket = []; await saveBasket(); }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.busy && Date.now() - state.loadedAt > STALE_AFTER) void act(reload);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[BASKET_KEY]) { void loadBasket().then(render); }
  });

  async function init() {
    await Promise.all([loadPreferences(), loadBasket(), loadChannelNames().catch(() => {})]);
    $("sort").value = state.sort.id;
    $("kind").value = state.kind;
    $("window").value = String(state.windowHours);
    await reload();
  }

  void init().catch(error => setStatus(`读取失败：${error.message}`, true));
})();
