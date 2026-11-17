// 风格模板的本机存储（chrome.storage.local 单个键，最多 20 个）。对标风格页读写，写作台只读。
(() => {
  "use strict";

  const KEY = "creationStyleTemplates";
  const LIMIT = 20;

  function create() {
    const storage = chrome.storage.local;

    /** 全部模板，最近修改的在前。 */
    async function list() {
      const saved = (await storage.get(KEY))[KEY];
      return (Array.isArray(saved) ? saved : []).filter(item => typeof item?.id === "string").sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function save(template) {
      const all = await list();
      const exists = all.some(item => item.id === template.id);
      if (!exists && all.length >= LIMIT) throw new Error(`最多保存 ${LIMIT} 个风格模板，请先删除不用的。`);
      await storage.set({ [KEY]: [template, ...all.filter(item => item.id !== template.id)] });
    }

    async function remove(id) {
      await storage.set({ [KEY]: (await list()).filter(item => item.id !== id) });
    }

    const onChanged = listener => chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[KEY]) listener();
    });

    return { list, save, remove, onChanged, LIMIT };
  }

  globalThis.XReplyStyleStore = Object.freeze({ create });
})();
