// 写作台的数据读取与本地保存：已选素材、同话题参考帖、自己的帖子样本、人设、写作进度。
// 素材来自 IndexedDB（有界读取），设置与进度存在 chrome.storage.local（单个键、体积有上限）。
(() => {
  "use strict";

  const BASKET_KEY = "creationBasket";
  const PROFILE_KEY = "creationStudioProfile";
  const SESSION_KEY = "creationStudioSession";

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  /** 找参考帖时读取的时间窗与条数上限（与雷达一致的有界读取）。 */
  const REFERENCE_WINDOW = 72 * HOUR;
  const REFERENCE_SCAN_LIMIT = 3000;
  /** 自己的帖子：只看近 60 天、最多 200 条，样本从中挑选。 */
  const OWN_WINDOW = 60 * DAY;
  const OWN_SCAN_LIMIT = 200;
  const MANUAL_SAMPLE_LIMIT = 5;

  function create({ db, cluster, draftModel, prompt }) {
    const storage = chrome.storage.local;

    // ---------- 素材 ----------

    async function basketIds() {
      const saved = (await storage.get(BASKET_KEY))[BASKET_KEY];
      return Array.isArray(saved) ? saved.filter(id => typeof id === "string").slice(0, prompt.LIMITS.materials) : [];
    }

    const saveBasket = ids => storage.set({ [BASKET_KEY]: ids });

    /** 按选入顺序读取素材；已被清理的返回 missing。 */
    async function basketMaterials(ids) {
      const rows = await Promise.all(ids.map(id => db.get(id)));
      return { materials: rows.filter(Boolean), missing: ids.filter((id, index) => !rows[index]) };
    }

    /**
     * 同话题的 X 帖子（用于对照角度）：在近 72 小时素材里聚合，取包含已选素材的话题中有浏览量的 X 帖子，按浏览降序。
     * @returns 素材数组（含已选的 X 帖子本身——它也代表“已有人写”的角度）
     */
    async function referencePosts(materials, now = Date.now()) {
      if (!materials.length) return [];
      const recent = await db.recent({ since: now - REFERENCE_WINDOW, limit: REFERENCE_SCAN_LIMIT });
      const pool = new Map(recent.map(material => [material.id, material]));
      for (const material of materials) pool.set(material.id, material);
      const selected = new Set(materials.map(material => material.id));
      const topics = cluster([...pool.values()], { heat: material => material.metrics?.views ?? 0 });
      const posts = new Map();
      for (const topic of topics) {
        if (!topic.members.some(member => selected.has(member.id))) continue;
        for (const member of topic.members) {
          if (member.kind === "x_post" && Number.isFinite(member.metrics?.views) && member.text) posts.set(member.id, member);
        }
      }
      return [...posts.values()].sort((a, b) => b.metrics.views - a.metrics.views).slice(0, prompt.LIMITS.references);
    }

    /** 自己的帖子（bot feed 标记 own），供挑选样本。 */
    function ownPosts(now = Date.now()) {
      return db.recent({ kind: "x_post", since: now - OWN_WINDOW, limit: OWN_SCAN_LIMIT, where: material => material.own === true });
    }

    const markUsed = (ids, at = Date.now()) => Promise.all(ids.map(id => db.setMark(id, "usedAt", at)));

    // ---------- 人设与样本 ----------

    /** @returns {{ persona, manualSamples: string[], excludedSampleIds: string[] }} */
    async function profile() {
      const saved = (await storage.get(PROFILE_KEY))[PROFILE_KEY] || {};
      const strings = value => Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
      return {
        persona: typeof saved.persona === "string" && saved.persona.trim() ? saved.persona : draftModel.DEFAULT_PERSONA,
        manualSamples: strings(saved.manualSamples).slice(0, MANUAL_SAMPLE_LIMIT),
        excludedSampleIds: strings(saved.excludedSampleIds).slice(0, OWN_SCAN_LIMIT)
      };
    }

    function saveProfile(value) {
      if (value.persona.length > prompt.LIMITS.persona) throw new Error(`人设最多 ${prompt.LIMITS.persona} 字。`);
      return storage.set({ [PROFILE_KEY]: {
        persona: value.persona,
        manualSamples: value.manualSamples.slice(0, MANUAL_SAMPLE_LIMIT),
        excludedSampleIds: value.excludedSampleIds.slice(0, OWN_SCAN_LIMIT)
      } });
    }

    // ---------- 写作进度 ----------

    /**
     * 进度：本次素材（materialIds）、角度、所选角度、形态、附加要求、候选稿（含编辑后的正文）、当前候选。
     * 关闭页面后可以接着写；素材换了之后角度作废，候选稿保留。
     */
    async function session() {
      const saved = (await storage.get(SESSION_KEY))[SESSION_KEY];
      return saved && typeof saved === "object" ? saved : null;
    }

    const saveSession = value => storage.set({ [SESSION_KEY]: { ...value, updatedAt: Date.now() } });

    const onBasketChanged = listener => chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[BASKET_KEY]) listener();
    });

    return {
      basketIds, saveBasket, basketMaterials, referencePosts, ownPosts, markUsed,
      profile, saveProfile, session, saveSession, onBasketChanged,
      MANUAL_SAMPLE_LIMIT
    };
  }

  globalThis.XReplyStudioStore = Object.freeze({ create });
})();
