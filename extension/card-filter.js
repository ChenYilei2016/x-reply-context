(() => {
  "use strict";
  function create({ accountHandle,tweetId,message,enabled,holdLayout,column,attribute,matches,stableReading = false }) {
    let signature = "";
    let revision = 0;
    let decisions = new Map();
    const layouts = new Map();
    const pending = new Set();
    let layoutAccount = "";
    let applyRequested = false;
    const invalidate = () => { signature = ""; revision++; };
    function reset() {
      document.querySelectorAll(`[${attribute}]`).forEach(article => article.removeAttribute(attribute));
      decisions.clear();
      layouts.clear(); pending.clear(); layoutAccount = ""; applyRequested = false;
      invalidate();
    }

    function setHidden(article,id,hidden) {
      if (hidden && article.getAttribute(attribute) !== id) article.setAttribute(attribute,id);
      else if (!hidden && article.hasAttribute(attribute)) article.removeAttribute(attribute);
    }

    function cardsIn(primary) {
      return Array.from(primary.querySelectorAll('article[data-testid="tweet"]'))
        .filter(article => !article.closest('[role="dialog"]'))
        .map(article => ({ article,id:tweetId(article) }));
    }

    function syncKnown() {
      // A virtual row can acquire a different tweet before the delayed classification runs.
      document.querySelectorAll(`[${attribute}]`).forEach(article => {
        if (article.getAttribute(attribute) !== tweetId(article)) article.removeAttribute(attribute);
      });
      const primary = column();
      const account = accountHandle();
      if (!stableReading || !primary || !enabled() || !account) return;
      if (layoutAccount && layoutAccount !== account) reset();
      layoutAccount = account;
      for (const { article,id } of cardsIn(primary)) {
        if (layouts.has(id)) setHidden(article,id,layouts.get(id));
      }
    }

    function requestApply() { applyRequested = true; invalidate(); }

    async function refresh() {
      syncKnown();
      // Keep native controls mounted and the background steady while composing.
      if (holdLayout()) return;
      const primary = column();
      const account = accountHandle();
      if (!enabled() || !primary || !account) { reset(); return; }
      const cards = cardsIn(primary);
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
      } catch (error) {
        applyRequested = false;
        if (!stableReading) reset();
        throw error;
      }
      pending.clear();
      for (const { article,id } of cards) {
        if (!id || !article.isConnected || tweetId(article) !== id) continue;
        const desired = Boolean(matches(rows.get(id)));
        let hidden = desired;
        if (stableReading) {
          if (applyRequested) hidden = desired;
          else if (layouts.has(id)) hidden = layouts.get(id);
          else hidden = desired && article.getBoundingClientRect().top > window.innerHeight+600;
          // Keep the reading area and everything above it at its already displayed height.
          layouts.delete(id); layouts.set(id,hidden);
          if (desired !== hidden) pending.add(id);
        }
        setHidden(article,id,hidden);
      }
      while (layouts.size > 10000) { const id = layouts.keys().next().value; layouts.delete(id); pending.delete(id); }
      applyRequested = false;
      decisions = rows;
      signature = nextSignature;
    }
    return { refresh,reset,invalidate,syncKnown,requestApply,
      pendingCount:() => pending.size,applying:() => applyRequested };
  }
  globalThis.XReplyCardFilter = { create };
})();
