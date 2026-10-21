(() => {
  "use strict";
  function create({ accountHandle,tweetId,message,enabled,holdLayout,column,attribute,matches }) {
    let signature = "";
    let revision = 0;
    let decisions = new Map();
    const invalidate = () => { signature = ""; revision++; };
    function reset() {
      document.querySelectorAll(`[${attribute}]`).forEach(article => article.removeAttribute(attribute));
      decisions.clear();
      invalidate();
    }

    async function refresh() {
      // Keep native controls mounted and the background steady while composing.
      if (holdLayout()) return;
      const primary = column();
      const account = accountHandle();
      if (!enabled() || !primary || !account) { reset(); return; }
      const cards = Array.from(primary.querySelectorAll('article[data-testid="tweet"]'))
        .filter(article => !article.closest('[role="dialog"]'))
        .map(article => ({ article,id:tweetId(article) }));
      for (const { article,id } of cards) {
        if (article.hasAttribute(attribute) && article.getAttribute(attribute) !== id) article.removeAttribute(attribute);
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
        const hidden = matches(rows.get(id));
        if (hidden && article.getAttribute(attribute) !== id) article.setAttribute(attribute,id);
        else if (!hidden) article.removeAttribute(attribute);
      }
      decisions = rows;
      signature = nextSignature;
    }
    return { refresh,reset,invalidate };
  }
  globalThis.XReplyCardFilter = { create };
})();
