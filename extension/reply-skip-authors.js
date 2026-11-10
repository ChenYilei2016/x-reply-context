(() => {
  "use strict";
  const KEY = "replySkipAuthors";
  const WHITELIST_KEY = "replySkipWhitelist";
  const RECOMMENDED_KEY = "recommendedInteractionSkip";
  const EMPTY = new Set();
  const handle = value => typeof value === "string" && /^[a-zA-Z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : "";
  const id = value => typeof value === "string" && /^\d{1,25}$/.test(value) ? value : "";

  function read(value,normalize) {
    const byAccount = new Map();
    if (!value || typeof value !== "object" || Array.isArray(value)) return byAccount;
    for (const [key,items] of Object.entries(value)) {
      const account = normalize(key);
      if (!account || !Array.isArray(items)) continue;
      const authors = new Set(items.map(normalize).filter(author => author && author !== account));
      if (authors.size) byAccount.set(account,authors);
    }
    return byAccount;
  }

  function interactionSkipSetting(value) {
    const gap = value?.gap;
    return { enabled:value?.enabled === true,gap:Number.isSafeInteger(gap) && gap >= 0 && gap <= 40000 ? gap : 5 };
  }

  function activeGap(value) {
    const setting = interactionSkipSetting(value);
    return setting.enabled ? setting.gap : null;
  }

  function createClient(storage,onChange = () => {}) {
    let skippedByAccount, whitelistByAccount, recommendedGap;
    let revision = 0;
    function changed(skippedChanged) {
      revision++;
      onChange(skippedChanged);
    }
    storage.onChanged.addListener((changes,area) => {
      if (area !== "local") return;
      if (changes[KEY]) skippedByAccount = read(changes[KEY].newValue,handle);
      if (changes[WHITELIST_KEY]) whitelistByAccount = read(changes[WHITELIST_KEY].newValue,id);
      if (changes[RECOMMENDED_KEY]) recommendedGap = activeGap(changes[RECOMMENDED_KEY].newValue);
      if (changes[KEY] || changes[WHITELIST_KEY] || changes[RECOMMENDED_KEY]) changed(Boolean(changes[KEY]));
    });
    const initial = storage.local.get([KEY,WHITELIST_KEY,RECOMMENDED_KEY]).then(saved => {
      const skippedChanged = !skippedByAccount;
      skippedByAccount ??= read(saved[KEY],handle);
      whitelistByAccount ??= read(saved[WHITELIST_KEY],id);
      if (recommendedGap === undefined) recommendedGap = activeGap(saved[RECOMMENDED_KEY]);
      changed(skippedChanged);
    },() => {});
    return {
      ready:async () => {
        if (!skippedByAccount || !whitelistByAccount || recommendedGap === undefined) await initial;
        return Boolean(skippedByAccount && (recommendedGap == null || whitelistByAccount));
      },
      revision:() => skippedByAccount ? revision : 0,
      authors:account => skippedByAccount?.get(handle(account)) || EMPTY,
      whitelist:accountId => whitelistByAccount && (whitelistByAccount.get(id(accountId)) || EMPTY),
      recommendedInteractionGap:() => recommendedGap ?? null
    };
  }

  function createWriter(storage,key = KEY) {
    const normalize = key === WHITELIST_KEY ? id : handle;
    let pending = Promise.resolve();
    return async (accountValue,authorValue,included) => {
      const account = normalize(accountValue), author = normalize(authorValue);
      if (!account || !author || account === author || typeof included !== "boolean") {
        return { ok:false,error:"未确认有效的作者。" };
      }
      // Serialize writes from different X tabs and the popup.
      const update = pending.then(async () => {
        const saved = await storage.local.get(key);
        const byAccount = read(saved[key],normalize);
        const authors = byAccount.get(account) || new Set();
        if (authors.has(author) === included) return { ok:true };
        if (included) authors.add(author);
        else authors.delete(author);
        if (authors.size) byAccount.set(account,authors);
        else byAccount.delete(account);
        await storage.local.set({ [key]:Object.fromEntries([...byAccount].map(([account,list]) => [account,[...list]])) });
        return { ok:true };
      });
      pending = update.catch(() => {});
      return update;
    };
  }

  async function readLists(storage,account,accountId) {
    const saved = await storage.local.get([KEY,WHITELIST_KEY]);
    return {
      skipped:read(saved[KEY],handle).get(handle(account)) || EMPTY,
      whitelist:read(saved[WHITELIST_KEY],id).get(id(accountId)) || EMPTY
    };
  }

  globalThis.XReplySkipAuthors = { createClient,createWriter,readLists,interactionSkipSetting,RECOMMENDED_KEY,WHITELIST_KEY };
})();
