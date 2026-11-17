// 发布与关联：生成 X 预填发帖链接；把 bot feed 里自己的帖子按正文匹配回草稿。
// 不读取 X 页面：已发帖子只来自 bot feed（own: true）或手动粘贴的链接。
(() => {
  "use strict";

  const { similarity } = globalThis.XReplyTextSimilarity;

  const INTENT_BASE = "https://x.com/intent/post";
  const COMPOSE_URL = "https://x.com/compose/post";
  /** 预填链接的最大长度；超过时只打开空白发帖页，正文走剪贴板。 */
  const INTENT_URL_LIMIT = 8000;
  /** 正文相似度阈值：X 会把链接换成 t.co、发帖前可能小改几个字。 */
  const MATCH_THRESHOLD = 0.85;
  /** 帖子发布时间最多晚于草稿最后修改 14 天；早于草稿创建 10 分钟以上的不算（时钟误差留余量）。 */
  const MATCH_WINDOW = 14 * 24 * 60 * 60 * 1000;
  const CLOCK_TOLERANCE = 10 * 60 * 1000;

  /** @returns {{ url: string, prefilled: boolean }} prefilled 为 false 时正文太长，需要粘贴 */
  function intentUrl(text) {
    const url = `${INTENT_BASE}?text=${encodeURIComponent(text)}`;
    return url.length <= INTENT_URL_LIMIT ? { url, prefilled: true } : { url: COMPOSE_URL, prefilled: false };
  }

  /**
   * 页面操作：复制正文（尽力而为，页面失焦时可能失败），在新标签页打开发帖页。发布仍由用户在 X 上点。
   * @returns {{ prefilled, copied, message }}
   */
  async function openCompose(text) {
    const copied = await navigator.clipboard.writeText(text).then(() => true, () => false);
    const intent = intentUrl(text);
    await chrome.tabs.create({ url: intent.url });
    const message = intent.prefilled ?
      `已打开 X 发帖页并预填正文${copied ? "（也已复制）" : ""}。` :
      copied ? "正文太长无法预填，已复制正文并打开发帖页，请粘贴。" : "正文太长无法预填，复制也失败了，请回到本页手动复制正文。";
    return { prefilled: intent.prefilled, copied, message };
  }

  /** 素材库里的帖子 id 形如 x:123，取出帖子编号。 */
  const postIdOf = material => material.id.match(/^x:(\d{1,25})$/)?.[1] || null;
  const postTime = material => material.publishedAt || material.firstSeenAt;

  /**
   * 把自己的帖子匹配回草稿：每条帖子、每份草稿最多匹配一次，相似度高的优先。
   * @param drafts 全部草稿（已关联的帖子不会重复匹配）
   * @param ownPosts 素材库中 own 为 true 的 X 帖子
   * @param statusOf (id) => DraftStatus，用于判断哪些草稿在等待关联
   * @returns [{ draftId, post: { id, url, publishedAt }, score }]
   */
  function findMatches(drafts, ownPosts, statusOf) {
    const linked = new Set(drafts.map(draft => draft.post?.id).filter(Boolean));
    const waiting = drafts.filter(draft => statusOf(draft.status)?.awaitsLink());
    const candidates = [];
    for (const material of ownPosts) {
      const id = postIdOf(material);
      if (!material.own || !id || linked.has(id) || !material.text) continue;
      const at = postTime(material);
      for (const draft of waiting) {
        if (at < draft.createdAt - CLOCK_TOLERANCE || at - draft.updatedAt > MATCH_WINDOW) continue;
        const published = draft.quoteUrl ? `${draft.text}\n${draft.quoteUrl}` : draft.text;
        const score = similarity(published, material.text);
        if (score >= MATCH_THRESHOLD) candidates.push({ draftId: draft.id, post: { id, url: material.url, publishedAt: at }, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const usedDrafts = new Set(), usedPosts = new Set();
    return candidates.filter(match => {
      if (usedDrafts.has(match.draftId) || usedPosts.has(match.post.id)) return false;
      usedDrafts.add(match.draftId);
      usedPosts.add(match.post.id);
      return true;
    });
  }

  globalThis.XReplyPublishLink = Object.freeze({ intentUrl, openCompose, findMatches, postIdOf, MATCH_THRESHOLD, INTENT_URL_LIMIT });
})();
