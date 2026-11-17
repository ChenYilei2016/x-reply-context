// 草稿与复盘页：草稿列表与状态流转（草稿 → 待确认 → 已发）、自动关联已发帖子、手动录入数据、按角度与形态复盘。
(() => {
  "use strict";

  const format = globalThis.XReplyFormat;
  const { AngleType } = globalThis.XReplyAngleModel;
  const { PostFormat } = globalThis.XReplyDraftModel;
  const xText = globalThis.XReplyXText;
  const record = globalThis.XReplyDraftRecord;
  const { DraftStatus } = record;
  const publishLink = globalThis.XReplyPublishLink;
  const review = globalThis.XReplyReviewModel;
  const store = globalThis.XReplyDraftsStore.create({ db: globalThis.XReplyMaterialDB.create() });

  const PAGE_SIZE = 30;
  const SAVE_DELAY = 500;
  const METRIC_LABELS = Object.freeze({ views: "浏览", likes: "点赞", reposts: "转发", replies: "评论" });

  const $ = id => document.getElementById(id);
  /** listStale：输入期间跳过了列表渲染，离开输入框后补渲染。 */
  const state = { drafts: [], filter: "all", page: 1, busy: false, listStale: false };
  const saveTimers = new Map();

  // ---------- 工具 ----------

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, onClick, className) {
    const node = element("button", text, className);
    node.type = "button";
    node.disabled = state.busy;
    node.addEventListener("click", onClick);
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

  const publishText = draft => draft.quoteUrl ? `${draft.text.trimEnd()}\n${draft.quoteUrl}` : draft.text;
  const angleLabel = type => type === review.NO_ANGLE ? "未选角度" : AngleType.from(type)?.label || type;
  const formatLabel = id => PostFormat.from(id)?.label || id;

  /** 先落盘该草稿未保存的输入，再取最新版本（渲染时的闭包可能已过期）。 */
  async function latest(id) {
    await flushSave(id);
    const draft = state.drafts.find(item => item.id === id);
    if (!draft) throw new Error("草稿已不存在。");
    return draft;
  }

  function replace(draft) {
    state.drafts = state.drafts.map(item => item.id === draft.id ? draft : item);
  }

  /** 串行执行改动，失败显示在状态行。 */
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

  // ---------- 渲染：复盘 ----------

  function renderReview() {
    const summary = review.summarize(state.drafts);
    const tile = (value, label) => {
      const node = element("div", undefined, "tile");
      node.append(element("strong", value), element("span", label));
      return node;
    };
    $("tiles").replaceChildren(tile(String(summary.published), "已发"), tile(String(summary.measured), "有数据"),
      tile(summary.avgViews === null ? "—" : format.count(summary.avgViews), "平均浏览"));
    const fill = (table, rows, labelOf) => {
      const body = table.querySelector("tbody");
      if (!rows.length) {
        const empty = element("td", "还没有已发的帖子", "empty");
        empty.colSpan = 5;
        const row = element("tr");
        row.append(empty);
        body.replaceChildren(row);
        return;
      }
      body.replaceChildren(...rows.map(group => {
        const row = element("tr");
        for (const value of [labelOf(group.key), String(group.count), format.count(group.avgViews), format.count(group.avgLikes), format.count(group.bestViews)]) {
          row.append(element("td", value));
        }
        return row;
      }));
    };
    fill($("by-angle"), summary.byAngle, angleLabel);
    fill($("by-format"), summary.byFormat, formatLabel);
  }

  // ---------- 渲染：列表 ----------

  function renderTabs() {
    const counts = Object.fromEntries(DraftStatus.values().map(status => [status.id, state.drafts.filter(draft => draft.status === status.id).length]));
    const tabs = [["all", "全部", state.drafts.length], ...DraftStatus.values().map(status => [status.id, status.label, counts[status.id]])];
    $("status-tabs").replaceChildren(...tabs.map(([id, label, count]) => {
      const tab = element("button");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(state.filter === id));
      tab.append(label, element("small", String(count)));
      tab.addEventListener("click", () => { state.filter = id; state.page = 1; render(); });
      return tab;
    }));
  }

  function meterText(draft) {
    const measure = xText.measure(publishText(draft));
    return `加权字数 ${measure.length}${measure.folded ? ` · 超过首屏 ${xText.FOLD_LIMIT}` : ""}${measure.overPremium ? " · 超出 Premium 上限" : ""}`;
  }

  function renderHead(node, draft) {
    const status = DraftStatus.from(draft.status);
    const parts = [element("span", status.label, `badge status-${status.id}`), element("span", formatLabel(draft.format), "badge")];
    if (draft.angle) parts.push(element("span", `${angleLabel(draft.angle.type)} · ${draft.angle.hook}`, "badge"));
    if (draft.origin === "legacy") parts.push(element("span", "旧版迁移", "badge"));
    parts.push(element("span", `更新于 ${format.time(draft.updatedAt)}`));
    node.querySelector(".draft-head").replaceChildren(...parts);
  }

  function metricsLine(draft) {
    const metrics = review.effectiveMetrics(draft);
    if (!metrics) return element("p", "还没有数据：等 bot feed 带回这条帖子的数字，或在下面手动录入。", "muted");
    const line = element("p");
    Object.entries(METRIC_LABELS).filter(([field]) => Number.isFinite(metrics[field])).forEach(([field, label], index) => {
      if (index) line.append(" · ");
      line.append(`${label} `, element("strong", format.count(metrics[field])));
    });
    const origin = metrics.origin === review.MetricsOrigin.FEED.id ? review.MetricsOrigin.FEED : review.MetricsOrigin.MANUAL;
    line.append(element("span", `（${origin.label}${metrics.observedAt ? ` · ${format.time(metrics.observedAt)}` : ""}）`, "muted"));
    return line;
  }

  function manualMetricsForm(draft) {
    const details = element("details");
    details.append(element("summary", draft.manualMetrics ? "修改手动数据" : "手动录入数据"));
    const form = element("div", undefined, "manual-metrics");
    const inputs = Object.entries(METRIC_LABELS).map(([field, label]) => {
      const input = element("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.placeholder = label;
      input.setAttribute("aria-label", label);
      input.value = draft.manualMetrics?.[field] ?? "";
      input.dataset.field = field;
      return input;
    });
    form.append(...inputs, button("保存", () => act(async () => {
      const values = Object.fromEntries(inputs.map(input => [input.dataset.field, input.value === "" ? undefined : input.valueAsNumber]));
      const next = record.withManualMetrics(draft, values);
      await store.save(next);
      replace(next);
      setStatus(next.manualMetrics ? "已保存手动数据。" : "已清除手动数据。");
    })));
    details.append(form);
    return details;
  }

  function renderPost(container, draft) {
    if (!draft.post) { container.replaceChildren(); return; }
    const head = element("p");
    head.append(link("在 X 查看 ↗", draft.post.url), ` · 发布于 ${format.time(draft.post.publishedAt)} · `,
      draft.post.linkedBy === "feed" ? "由 bot feed 自动关联" : "手动关联");
    const parts = [head, metricsLine(draft)];
    if (draft.views24h) parts.push(element("p", `发布后 24 小时内浏览 ${format.count(draft.views24h.views)}（发布后约 ${draft.views24h.hours} 小时的读数）`, "muted"));
    parts.push(manualMetricsForm(draft));
    container.replaceChildren(...parts);
  }

  function linkForm(draft, actions) {
    const input = element("input");
    input.type = "url";
    input.placeholder = "粘贴已发帖子的链接，例如 https://x.com/你/status/123";
    input.className = "link-input";
    const confirmLink = button("确定", () => act(async () => {
      const post = record.parsePostUrl(input.value);
      if (!post) throw new Error("请粘贴 X 帖子链接（x.com/用户名/status/编号）。");
      if (state.drafts.some(item => item.post?.id === post.id)) throw new Error("这条帖子已经关联到其他草稿。");
      const next = record.linkPost(await latest(draft.id), { ...post, publishedAt: Date.now() }, "manual");
      await store.save(next);
      replace(next);
      setStatus("已标为已发。bot feed 带回这条帖子后会自动更新数据。");
    }));
    actions.replaceChildren(input, confirmLink, button("取消", () => render()));
    input.focus();
  }

  function editableActions(draft, actions) {
    actions.replaceChildren(
      button("去 X 发布", () => act(async () => {
        const current = await latest(draft.id);
        const text = publishText(current);
        if (xText.measure(text).overPremium) throw new Error("超过 Premium 上限，请删减后再发布。");
        const next = record.markPending(current);
        await store.save(next);
        replace(next);
        const result = await publishLink.openCompose(text);
        setStatus(result.message, !result.prefilled && !result.copied);
      }), "primary"),
      button("复制", () => act(async () => {
        await navigator.clipboard.writeText(publishText(await latest(draft.id)));
        setStatus("已复制。");
      })),
      button("标记已发", () => linkForm(draft, actions)),
      button("删除", () => act(async () => {
        if (!confirm("删除这份草稿？")) return;
        await store.remove(draft.id);
        state.drafts = state.drafts.filter(item => item.id !== draft.id);
        setStatus("已删除。");
      })));
  }

  function renderDraft(draft) {
    const node = $("draft-template").content.firstElementChild.cloneNode(true);
    const editable = DraftStatus.from(draft.status).isEditable();
    renderHead(node, draft);
    const text = node.querySelector(".draft-text");
    text.hidden = !editable;
    node.querySelector(".draft-body").hidden = editable;
    node.querySelector(".draft-body").textContent = publishText(draft);
    const meter = node.querySelector(".draft-meter");
    meter.textContent = meterText(draft);
    if (editable) {
      text.value = draft.text;
      text.addEventListener("input", () => {
        const next = { ...draft, text: text.value };
        meter.textContent = meterText(next);
        queueSave(draft.id, text.value);
      });
    }
    const materials = node.querySelector(".draft-materials");
    materials.replaceChildren(...draft.materials.flatMap((item, index) => [index ? " · " : "素材：", item.url ? link(item.title || item.url, item.url) : item.title]));
    materials.hidden = !draft.materials.length;
    renderPost(node.querySelector(".draft-post"), draft);
    const actions = node.querySelector(".draft-actions");
    if (editable) editableActions(draft, actions);
    else actions.replaceChildren(button("撤销关联", () => act(async () => {
      if (!confirm("撤销后这份草稿回到未发状态，已缓存的数据会清除。继续吗？")) return;
      const next = record.unlinkPost(draft);
      await store.save(next);
      replace(next);
    })));
    return node;
  }

  const typingInDraft = () => Boolean(document.activeElement?.matches?.(".draft textarea, .draft input"));

  function renderList() {
    const visible = state.drafts.filter(draft => state.filter === "all" || draft.status === state.filter);
    const shown = visible.slice(0, state.page * PAGE_SIZE);
    if (!visible.length) {
      const empty = element("li", state.drafts.length ? "这个状态下没有草稿。" : "还没有草稿。在写作台点「保存草稿」或「去 X 发布」后会出现在这里。", "empty");
      $("drafts").replaceChildren(empty);
    } else {
      // 正在草稿里输入时不重新渲染，避免光标跳动和输入丢失。
      if (typingInDraft()) { state.listStale = true; return; }
      $("drafts").replaceChildren(...shown.map(renderDraft));
    }
    state.listStale = false;
    $("more").hidden = shown.length >= visible.length;
  }

  function render() {
    $("sync").disabled = state.busy;
    const pending = state.drafts.filter(draft => draft.status === DraftStatus.PENDING.id).length;
    $("summary").textContent = `${state.drafts.length} 份草稿${pending ? ` · ${pending} 份待确认是否已发` : ""} · 最多保留 ${globalThis.XReplyMaterialDB.DRAFT_LIMIT} 份（已发的不清理）`;
    renderReview();
    renderTabs();
    renderList();
  }

  // ---------- 保存与同步 ----------

  function queueSave(id, text) {
    clearTimeout(saveTimers.get(id)?.timer);
    const timer = setTimeout(() => void flushSave(id).catch(error => setStatus(error.message, true)), SAVE_DELAY);
    saveTimers.set(id, { timer, text });
  }

  async function flushSave(id) {
    const pending = saveTimers.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    saveTimers.delete(id);
    const draft = state.drafts.find(item => item.id === id);
    if (!draft || draft.text === pending.text) return;
    const next = record.withText(draft, pending.text);
    await store.save(next);
    replace(next);
    setStatus("已保存。");
  }

  async function sync() {
    await Promise.all([...saveTimers.keys()].map(flushSave));
    const result = await store.sync();
    state.drafts = result.drafts;
    const notes = [];
    if (result.linked) notes.push(`自动关联 ${result.linked} 条已发帖子`);
    if (result.refreshed) notes.push(`更新 ${result.refreshed} 条数据`);
    setStatus(notes.length ? `${notes.join("，")}。` : "没有新关联的帖子。已发帖子来自 bot feed 中标记 own 的条目，也可以手动粘贴链接。");
  }

  $("sync").addEventListener("click", () => act(sync));
  $("more").addEventListener("click", () => { state.page++; render(); });
  document.addEventListener("focusout", () => setTimeout(() => { if (state.listStale && !typingInDraft()) renderList(); }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void act(sync); });

  void act(sync);
})();
