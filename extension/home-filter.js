(() => {
  "use strict";
  const HIDDEN = "data-xrc-home-hidden";

  function column() {
    if (!/^\/home\/?$/.test(location.pathname)) return null;
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    const firstTab = primary?.querySelector('[role="tab"]');
    return firstTab?.getAttribute("aria-selected") === "true" &&
      !firstTab.getAttribute("href")?.startsWith("/notifications") ? primary : null;
  }

  function create({ accountHandle,tweetId,message,enabled,holdLayout }) {
    let signature = "";
    let revision = 0;
    let decisions = new Map();
    const invalidate = () => { signature = ""; revision++; };
    function reset() {
      document.querySelectorAll(`[${HIDDEN}]`).forEach(article => article.removeAttribute(HIDDEN));
      decisions.clear();
      invalidate();
    }

    async function refresh() {
      // Keep native reply/like controls mounted and the background steady while composing.
      if (holdLayout()) return;
      const primary = column();
      const account = accountHandle();
      if (!enabled() || !primary || !account) { reset(); return; }
      const cards = Array.from(primary.querySelectorAll('article[data-testid="tweet"]'))
        .filter(article => !article.closest('[role="dialog"]'))
        .map(article => ({ article,id:tweetId(article) }));
      for (const { article,id } of cards) {
        if (article.hasAttribute(HIDDEN) && article.getAttribute(HIDDEN) !== id) article.removeAttribute(HIDDEN);
      }
      const nextSignature = account+":"+cards.map(card => card.id).join(",");
      const observedRevision = revision;
      const rows = signature === nextSignature ? decisions : new Map();
      try {
        for (let offset = 0; signature !== nextSignature && offset < cards.length; offset += 100) {
          const result = await message({ type:"CLASSIFY",account,
            ids:cards.slice(offset,offset+100).map(card => card.id).filter(Boolean) });
          if (observedRevision !== revision || !enabled() || holdLayout() ||
              accountHandle() !== account || column() !== primary) return;
          for (const row of result.rows) rows.set(row.id,row);
        }
      } catch (error) { reset(); throw error; }
      for (const { article,id } of cards) {
        if (!article.isConnected || tweetId(article) !== id) continue;
        const row = rows.get(id);
        // A conversation's other liked reply is not proof that this original was liked.
        const completed = row?.status === "not-reply" && row.origin === "others" &&
          row.evidenceId && row.likeEvidenceId === id;
        const mine = row?.status === "self" || (row?.status === "not-reply" && row.origin === "mine");
        if ((mine || completed) && article.getAttribute(HIDDEN) !== id) article.setAttribute(HIDDEN,id);
        else if (!mine && !completed) article.removeAttribute(HIDDEN);
      }
      decisions = rows;
      signature = nextSignature;
    }
    return { refresh,reset,invalidate };
  }
  globalThis.XReplyHomeFilter = { column,create };
})();
