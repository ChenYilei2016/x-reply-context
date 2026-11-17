// 草稿记录：状态枚举、创建与状态流转、0.26.0 旧草稿转换、X 帖子链接解析、手动录入数据的校验。
// 纯函数，不读写存储；每次变更返回新对象。
(() => {
  "use strict";

  const TEXT_LIMIT = 25000;
  const MATERIAL_LIMIT = 3;
  const TITLE_LIMIT = 300;
  const DEFAULT_FORMAT = "short_opinion";
  const METRIC_FIELDS = Object.freeze(["views", "likes", "reposts", "replies"]);

  function defineStatus(id, label, { editable, linkable }) {
    return Object.freeze({
      id, label,
      /** 正文还能不能改：已发的草稿正文以 X 上为准，不再修改。 */
      isEditable: () => editable,
      /** 能否被自动关联到新发的帖子。 */
      awaitsLink: () => linkable
    });
  }

  const DRAFT = defineStatus("draft", "草稿", { editable: true, linkable: true });
  const PENDING = defineStatus("pending", "待确认", { editable: true, linkable: true });
  const PUBLISHED = defineStatus("published", "已发", { editable: false, linkable: false });
  const STATUSES = Object.freeze([DRAFT, PENDING, PUBLISHED]);
  const DraftStatus = Object.freeze({ DRAFT, PENDING, PUBLISHED, values: () => STATUSES, from: id => STATUSES.find(status => status.id === id) });

  const clip = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";

  function checkText(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("草稿正文不能为空。");
    if (text.length > TEXT_LIMIT) throw new Error(`草稿正文最多 ${TEXT_LIMIT} 字。`);
    return text;
  }

  function materialRefs(materials) {
    return (Array.isArray(materials) ? materials : []).slice(0, MATERIAL_LIMIT)
      .map(item => ({ id: clip(item?.id, 2048), title: clip(item?.title, TITLE_LIMIT), url: clip(item?.url, 2048) }))
      .filter(item => item.title || item.url);
  }

  /**
   * 新建草稿。
   * @param fields { text, format, angle?: {type, hook}, rewrite?: {style}, materials?: [{id, title, url}], quoteUrl? }
   */
  function create(fields, now = Date.now(), id = `d:${crypto.randomUUID()}`) {
    return {
      id, text: checkText(fields.text), format: clip(fields.format, 40) || DEFAULT_FORMAT,
      angle: fields.angle?.type ? { type: clip(fields.angle.type, 40), hook: clip(fields.angle.hook, 120) } : null,
      rewrite: fields.rewrite?.style ? { style: clip(fields.rewrite.style, 40) } : null,
      materials: materialRefs(fields.materials), quoteUrl: clip(fields.quoteUrl, 2048) || null,
      status: DRAFT.id, origin: "studio", createdAt: now, updatedAt: now,
      publishOpenedAt: null, post: null, metrics: null, views24h: null, manualMetrics: null
    };
  }

  function requireEditable(draft) {
    if (!DraftStatus.from(draft.status).isEditable()) throw new Error("已发的草稿不能再改正文。");
  }

  function withText(draft, text, now = Date.now()) {
    requireEditable(draft);
    return { ...draft, text: checkText(text), updatedAt: now };
  }

  /** 已打开 X 发帖页，等待确认是否发出。 */
  function markPending(draft, now = Date.now()) {
    requireEditable(draft);
    return { ...draft, status: PENDING.id, publishOpenedAt: now, updatedAt: now };
  }

  /**
   * 关联已发的帖子。
   * @param post { id, url, publishedAt? }
   * @param linkedBy "feed"（bot feed 中自己的帖子自动匹配）或 "manual"（手动粘贴链接）
   */
  function linkPost(draft, post, linkedBy, now = Date.now()) {
    if (!/^\d{1,25}$/.test(post?.id || "")) throw new Error("帖子编号无效。");
    return {
      ...draft, status: PUBLISHED.id, updatedAt: now,
      post: { id: post.id, url: post.url, publishedAt: Number.isFinite(post.publishedAt) ? post.publishedAt : now, linkedBy }
    };
  }

  /** 关联错了时撤销，回到草稿；缓存的数据一并清除。 */
  function unlinkPost(draft, now = Date.now()) {
    return { ...draft, status: DRAFT.id, post: null, metrics: null, views24h: null, manualMetrics: null, updatedAt: now };
  }

  /** 解析 X 帖子链接（x.com / twitter.com / mobile），返回规范链接与编号。 */
  function parsePostUrl(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { return null; }
    if (!["https:", "http:"].includes(url.protocol) || !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/|$)/);
    return match ? { id: match[2], url: `https://x.com/${match[1]}/status/${match[2]}` } : null;
  }

  /** 手动录入的数据：只接受非负整数，至少填一项。 */
  function withManualMetrics(draft, raw, now = Date.now()) {
    if (draft.status !== PUBLISHED.id) throw new Error("发布后才能录入数据。");
    const metrics = {};
    for (const field of METRIC_FIELDS) {
      const value = raw?.[field];
      if (value === undefined || value === null || value === "") continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("数据请填写非负整数。");
      metrics[field] = value;
    }
    if (!Object.keys(metrics).length) return { ...draft, manualMetrics: null, updatedAt: now };
    return { ...draft, manualMetrics: { ...metrics, recordedAt: now }, updatedAt: now };
  }

  /** 0.26.0 工作台草稿 → 新草稿（正文为空的丢弃）。保留原保存时间，便于在列表中按时间找到。 */
  function fromLegacy(old, now = Date.now()) {
    if (!old || typeof old.id !== "string" || typeof old.text !== "string" || !old.text.trim()) return null;
    const at = Number.isFinite(old.updatedAt) ? old.updatedAt : now;
    const draft = create({
      text: old.text.slice(0, TEXT_LIMIT),
      materials: (Array.isArray(old.materials) ? old.materials : []).map(item => ({ title: item?.title, url: item?.url }))
    }, at, `legacy:${old.id.slice(0, 80)}`);
    return { ...draft, origin: "legacy" };
  }

  globalThis.XReplyDraftRecord = Object.freeze({
    DraftStatus, METRIC_FIELDS, TEXT_LIMIT,
    create, withText, markPending, linkPost, unlinkPost, parsePostUrl, withManualMetrics, fromLegacy
  });
})();
