(() => {
  "use strict";
  const KEY = "replySkipAuthors";
  const EMPTY = new Set();
  const handle = value => typeof value === "string" && /^[a-zA-Z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : "";

  function read(value) {
    const byAccount = new Map();
    if (!value || typeof value !== "object" || Array.isArray(value)) return byAccount;
    for (const [key,items] of Object.entries(value)) {
      const account = handle(key);
      if (!account || !Array.isArray(items)) continue;
      const authors = new Set(items.map(handle).filter(author => author && author !== account));
      if (authors.size) byAccount.set(account,authors);
    }
    return byAccount;
  }

  function createClient(storage,onChange = () => {}) {
    let byAccount = new Map(), revision = 0;
    function apply(value) {
      byAccount = read(value);
      revision++;
      onChange();
    }
    storage.onChanged.addListener((changes,area) => {
      if (area === "local" && changes[KEY]) apply(changes[KEY].newValue);
    });
    const initial = storage.local.get(KEY).then(saved => {
      if (!revision) apply(saved[KEY]);
    },() => {});
    return {
      ready:async () => { if (!revision) await initial; return revision > 0; },
      revision:() => revision,
      authors:account => byAccount.get(handle(account)) || EMPTY
    };
  }

  function createWriter(storage) {
    let pending = Promise.resolve();
    return async message => {
      const account = handle(message.account), author = handle(message.author);
      const { skipped } = message;
      if (!account || !author || account === author || typeof skipped !== "boolean") {
        return { ok:false,error:"未确认有效的作者。" };
      }
      // Serialize writes from different X tabs and the popup.
      const update = pending.then(async () => {
        const saved = await storage.local.get(KEY);
        const byAccount = read(saved[KEY]);
        const authors = byAccount.get(account) || new Set();
        if (authors.has(author) === skipped) return { ok:true };
        if (skipped) authors.add(author);
        else authors.delete(author);
        if (authors.size) byAccount.set(account,authors);
        else byAccount.delete(account);
        await storage.local.set({ [KEY]:Object.fromEntries([...byAccount].map(([key,list]) => [key,[...list]])) });
        return { ok:true };
      });
      pending = update.catch(() => {});
      return update;
    };
  }

  globalThis.XReplySkipAuthors = { createClient,createWriter };
})();
