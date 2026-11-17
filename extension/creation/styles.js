// 对标风格页：从素材库按博主挑帖子（或手动粘贴）→ 模型拆解成风格模板 → 查看与编辑模板。
(() => {
  "use strict";

  const format = globalThis.XReplyFormat;
  const styleModel = globalThis.XReplyStyleModel;
  const { POST_LIMITS } = styleModel;
  const db = globalThis.XReplyMaterialDB.create();
  const templates = globalThis.XReplyStyleStore.create();
  const ai = globalThis.XReplyModelClient.create({ onChange: () => render(), onError: error => setStatus(error.message, true) });

  const DAY = 24 * 60 * 60 * 1000;
  /** 作者列表只看近 90 天、最多 3000 条 X 帖子（收藏的帖子不会被清理）。 */
  const AUTHOR_WINDOW = 90 * DAY;
  const SCAN_LIMIT = 3000;
  const AUTHOR_LIMIT = 50;
  const SAMPLE_SEPARATOR = /^\s*---\s*$/m;

  const $ = id => document.getElementById(id);
  const state = { source: "library", authors: [], authorHandle: "", selected: new Set(), templates: [], openId: null };

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

  // ---------- 数据 ----------

  /** 按作者分组素材库里的 X 帖子（不含自己的），帖子按浏览降序；作者按帖子数、最高浏览排序。 */
  async function loadAuthors() {
    const posts = await db.recent({ kind: "x_post", since: Date.now() - AUTHOR_WINDOW, limit: SCAN_LIMIT,
      where: material => !material.own && Boolean(material.author?.handle) && Boolean(material.text) });
    const groups = new Map();
    for (const post of posts) {
      const handle = post.author.handle;
      if (!groups.has(handle)) groups.set(handle, { handle, name: post.author.name || "", posts: [] });
      groups.get(handle).posts.push(post);
    }
    const views = post => post.metrics?.views ?? -1;
    state.authors = [...groups.values()]
      .map(author => ({ ...author, posts: author.posts.sort((a, b) => views(b) - views(a)) }))
      .sort((a, b) => b.posts.length - a.posts.length || views(b.posts[0]) - views(a.posts[0]))
      .slice(0, AUTHOR_LIMIT);
    if (!state.authors.some(author => author.handle === state.authorHandle)) selectAuthor(state.authors[0]?.handle || "");
  }

  function selectAuthor(handle) {
    state.authorHandle = handle;
    const author = currentAuthor();
    state.selected = new Set(author ? author.posts.slice(0, POST_LIMITS.max).map(post => post.id) : []);
  }

  const currentAuthor = () => state.authors.find(author => author.handle === state.authorHandle);

  async function loadTemplates() {
    state.templates = await templates.list();
  }

  /** 本次要拆解的帖子与作者；数量不符时报错。 */
  function chosenPosts() {
    if (state.source === "manual") {
      const posts = $("manual-posts").value.split(SAMPLE_SEPARATOR).map(text => text.trim()).filter(Boolean).map(text => ({ text }));
      return { posts, author: { handle: "", name: $("manual-name").value.trim() } };
    }
    const author = currentAuthor();
    const posts = (author?.posts || []).filter(post => state.selected.has(post.id)).map(post => ({ text: post.text, views: post.metrics?.views }));
    return { posts, author: { handle: author?.handle || "", name: author?.name || "" } };
  }

  // ---------- 渲染 ----------

  function renderSource() {
    for (const tab of $("source-modes").children) tab.setAttribute("aria-selected", String(tab.dataset.source === state.source));
    for (const node of document.querySelectorAll("[data-source-only]")) node.hidden = node.dataset.sourceOnly !== state.source;
    const select = $("author");
    select.replaceChildren(...(state.authors.length ? state.authors.map(author =>
      new Option(`${author.name ? `${author.name} ` : ""}@${author.handle} · ${author.posts.length} 条`, author.handle)) :
      [new Option("素材库里还没有别人的 X 帖子", "")]));
    select.value = state.authorHandle;
    select.disabled = !state.authors.length;
    const author = currentAuthor();
    $("posts").replaceChildren(...(author ? author.posts : []).map(post => {
      const item = element("li");
      const label = element("label");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected.has(post.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(post.id); else state.selected.delete(post.id);
        renderSelection();
      });
      const text = element("span", post.text.length > 160 ? `${post.text.slice(0, 160)}…` : post.text);
      text.append(element("small", [post.metrics?.views !== undefined ? `浏览 ${format.count(post.metrics.views)}` : "", format.ago(post.publishedAt || post.firstSeenAt)]
        .filter(Boolean).join(" · ")));
      label.append(checkbox, text);
      item.append(label);
      return item;
    }));
    renderSelection();
  }

  function renderSelection() {
    const count = chosenPosts().posts.length;
    const valid = count >= POST_LIMITS.min && count <= POST_LIMITS.max;
    $("selection").textContent = `已选 ${count} 条（需要 ${POST_LIMITS.min}～${POST_LIMITS.max} 条）`;
    $("distill").disabled = Boolean(ai.pending) || !valid;
    $("distill").textContent = ai.pending ? "正在拆解…" : "拆解风格";
    $("cancel").hidden = !ai.pending;
  }

  const lines = items => items.join("\n");

  function renderTemplate(template) {
    const node = $("template-card").content.firstElementChild.cloneNode(true);
    const details = node.querySelector("details");
    details.open = template.id === state.openId;
    details.addEventListener("toggle", () => { if (details.open) state.openId = template.id; });
    node.querySelector(".template-name").textContent = template.name;
    const source = template.source;
    node.querySelector(".template-source").textContent = [source.handle ? `@${source.handle}` : source.name || "手动粘贴",
      source.postCount ? `${source.postCount} 条帖子` : "", `更新于 ${format.time(template.updatedAt)}`].filter(Boolean).join(" · ");
    const field = name => node.querySelector(`.field-${name}`);
    field("name").value = template.name;
    field("positioning").value = template.positioning;
    field("topics").value = lines(template.topics);
    field("hooks").value = lines(template.hooks.map(hook => hook.pattern));
    field("structure").value = template.structure;
    field("tone").value = template.tone;
    field("avoid").value = lines(template.avoid);
    node.querySelector(".examples").replaceChildren(...template.hooks.filter(hook => hook.example)
      .map(hook => element("li", `「${hook.pattern}」原句：${hook.example}`)));
    node.querySelector(".save").addEventListener("click", () => void saveEdits(template, field).catch(error => setStatus(error.message, true)));
    node.querySelector(".remove").addEventListener("click", () => void removeTemplate(template).catch(error => setStatus(error.message, true)));
    return node;
  }

  function renderTemplates() {
    $("template-count").textContent = `${state.templates.length}/${templates.LIMIT}`;
    $("templates").replaceChildren(...(state.templates.length ? state.templates.map(renderTemplate) :
      [element("li", "还没有风格模板。左侧选好帖子后点「拆解风格」。", "empty")]));
  }

  function render() {
    ai.render();
    renderSelection();
  }

  // ---------- 操作 ----------

  async function distill() {
    const { posts, author } = chosenPosts();
    setStatus(`正在拆解 ${posts.length} 条帖子的写法 · 最长等待 90 秒`);
    const text = await ai.request("styles", { author, posts });
    if (text === null) return;
    const { rules, droppedExamples } = styleModel.parse(text, posts);
    const template = styleModel.create(rules, { ...author, postCount: posts.length });
    await templates.save(template);
    state.openId = template.id;
    await loadTemplates();
    renderTemplates();
    setStatus(`已生成「${template.name}」${droppedExamples ? `，${droppedExamples} 条示例原句在帖子里找不到，已去掉` : ""}。可以修改后保存，在写作台「风格模板」里选用。`);
  }

  async function saveEdits(template, field) {
    // 手法按行编辑；原句示例跟随同名手法保留，改了措辞的手法不再带示例。
    const examples = new Map(template.hooks.map(hook => [hook.pattern, hook.example]));
    const hooks = field("hooks").value.split("\n").map(line => line.trim()).filter(Boolean)
      .map(pattern => ({ pattern, example: examples.get(pattern) || "" }));
    const next = styleModel.update(template, {
      name: field("name").value, positioning: field("positioning").value, topics: field("topics").value, hooks,
      structure: field("structure").value, tone: field("tone").value, avoid: field("avoid").value
    });
    await templates.save(next);
    state.openId = next.id;
    await loadTemplates();
    renderTemplates();
    setStatus(`已保存「${next.name}」。`);
  }

  async function removeTemplate(template) {
    if (!confirm(`删除风格模板「${template.name}」？`)) return;
    await templates.remove(template.id);
    await loadTemplates();
    renderTemplates();
    setStatus("已删除。");
  }

  // ---------- 事件 ----------

  for (const tab of $("source-modes").children) {
    tab.addEventListener("click", () => { state.source = tab.dataset.source; renderSource(); });
  }
  $("author").addEventListener("change", () => { selectAuthor($("author").value); renderSource(); });
  $("manual-posts").addEventListener("input", renderSelection);
  $("distill").addEventListener("click", () => void distill().catch(error => setStatus(error.message, true)));
  $("cancel").addEventListener("click", () => { if (ai.cancel()) setStatus("已取消。"); });
  templates.onChanged(() => void loadTemplates().then(renderTemplates));

  async function init() {
    await Promise.all([loadAuthors(), loadTemplates(), ai.load().catch(error => setStatus(error.message, true))]);
    renderSource();
    renderTemplates();
    render();
  }

  void init().catch(error => setStatus(`读取失败：${error.message}`, true));
})();
