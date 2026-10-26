/* Single native X window. No page reads, draft transfer, polling, or X API calls. */
(() => {
  "use strict";
  const KEY = "replyContextCompanion";
  function create(api) {
    let opening;
    async function openOne(handle,sender) {
      const stored = (await api.storage.session.get(KEY))[KEY];
      if (stored && Number.isInteger(stored.windowId)) {
        let window;
        try { window = await api.windows.get(stored.windowId); } catch { /* Closed while worker slept. */ }
        if (window) {
          // Never navigate an existing companion: even a just-checked empty draft can change.
          await api.windows.update(window.id,window.state === "minimized" ?
            { state:"normal",focused:true } : { focused:true });
          return { ok:true,reused:true,handle:stored.handle };
        }
        await api.storage.session.remove(KEY);
      }
      const source = await api.windows.get(sender.tab.windowId);
      const width = 800, height = Math.max(600,Math.min(900,source.height || 860));
      const created = await api.windows.create({
        url:"about:blank",type:"popup",focused:true,width,height,
        left:(source.left || 0)+Math.max(0,(source.width || width)-width),top:source.top || 0
      });
      // Register the blank window before loading X; a storage failure cannot lose a draft.
      const record = { windowId:created.id,handle };
      try {
        await api.storage.session.set({ [KEY]:record });
      } catch (error) {
        await api.windows.remove(created.id);
        throw error;
      }
      const tabId = created.tabs?.[0]?.id;
      if (!Number.isInteger(tabId)) throw new Error("未找到伴随窗口标签页，请关闭空窗口后重试。");
      await api.tabs.update(tabId,{ url:`https://x.com/${handle}` });
      return { ok:true,reused:false,handle };
    }
    function open(message,sender) {
      const handle = typeof message.handle === "string" && /^[a-zA-Z0-9_]{1,15}$/.test(message.handle) ? message.handle.toLowerCase() : "";
      let origin;
      try { origin = new URL(sender.url).origin; } catch { /* Reject non-web senders. */ }
      if (!handle || !["https://x.com","https://twitter.com"].includes(origin) ||
          sender.frameId !== 0 || !Number.isInteger(sender.tab?.windowId) || sender.tab.incognito) {
        return Promise.resolve({ok:false,error:"请从普通 X 页面的回复框打开伴随窗口。"});
      }
      // Coalesce double-clicks and simultaneous requests from different source tabs.
      if (!opening) opening = openOne(handle,sender).catch(() => ({
        ok:false,error:"伴随窗口暂时无法打开，请检查现有窗口；不会另开重试或刷新草稿。"
      })).finally(() => { opening = undefined; });
      return opening;
    }
    async function removed(id) {
      await opening;
      const record = (await api.storage.session.get(KEY))[KEY];
      if (record?.windowId === id) await api.storage.session.remove(KEY);
    }
    return { open,removed };
  }
  globalThis.XReplyCompanion = { create };
})();
