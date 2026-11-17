// 草稿库的页面侧服务：保存与删除草稿；把 bot feed 中自己的帖子关联回草稿并刷新复盘数据。
(() => {
  "use strict";

  const DAY = 24 * 60 * 60 * 1000;
  /** 自己的帖子在素材库保留 90 天；关联和刷新只看这段时间、最多 1000 条。 */
  const OWN_WINDOW = 90 * DAY;
  const OWN_SCAN_LIMIT = 1000;

  function create({ db }) {
    const record = globalThis.XReplyDraftRecord;
    const publish = globalThis.XReplyPublishLink;
    const review = globalThis.XReplyReviewModel;

    const list = () => db.drafts();
    const get = id => db.getDraft(id);
    const save = draft => db.putDraft(draft);
    const remove = id => db.deleteDraft(id);

    function ownPosts(now) {
      return db.recent({ kind: "x_post", since: now - OWN_WINDOW, limit: OWN_SCAN_LIMIT, where: material => material.own === true });
    }

    /**
     * 自动关联与刷新：未发草稿按正文匹配自己的新帖子并标为已发；已发草稿用帖子的最新数据刷新缓存。只写回有变化的草稿。
     * @returns {{ drafts, linked: number, refreshed: number }}
     */
    async function sync(now = Date.now()) {
      const [drafts, own] = await Promise.all([db.drafts(), ownPosts(now)]);
      const original = new Map(drafts.map(draft => [draft.id, draft]));
      const byId = new Map(original);
      const matches = publish.findMatches(drafts, own, record.DraftStatus.from);
      for (const match of matches) byId.set(match.draftId, record.linkPost(byId.get(match.draftId), match.post, "feed", now));

      const postsById = new Map(own.map(material => [material.id, material]));
      let refreshed = 0;
      for (const [id, draft] of byId) {
        if (!draft.post) continue;
        const next = review.refresh(draft, postsById.get(`x:${draft.post.id}`));
        if (next !== draft) { byId.set(id, next); refreshed++; }
      }
      const changed = [...byId.values()].filter(draft => draft !== original.get(draft.id));
      if (changed.length) await db.putDrafts(changed);
      return { drafts: [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt), linked: matches.length, refreshed };
    }

    return { list, get, save, remove, sync, ownPosts };
  }

  globalThis.XReplyDraftsStore = Object.freeze({ create });
})();
