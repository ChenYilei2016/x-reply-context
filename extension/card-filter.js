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
    let applyBelowAllowed;
    let view = { total:0,hidden:0 };
    const invalidate = () => { signature = ""; revision++; };
    function reset() {
      document.querySelectorAll(`[${attribute}]`).forEach(article => article.removeAttribute(attribute));
      view = { total:0,hidden:0 };
      decisions.clear();
      layouts.clear(); pending.clear(); layoutAccount = ""; applyRequested = false; applyBelowAllowed = undefined;
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

    const belowReadingArea = article => article.getBoundingClientRect().top > window.innerHeight+600;
    function requestApply() { applyRequested = true; applyBelowAllowed = undefined; invalidate(); }
    function requestApplyBelow(allowed) { applyRequested = true; applyBelowAllowed = allowed; invalidate(); }
    function cancelApplyBelow() {
      if (!applyBelowAllowed) return false;
      applyRequested = false; applyBelowAllowed = undefined; invalidate();
      return true;
    }
    function hasPendingBelow() {
      const primary = column();
      return Boolean(primary && layoutAccount === accountHandle() && cardsIn(primary).some(({ article,id }) =>
        pending.has(id) && belowReadingArea(article)));
    }

    async function refresh() {
      syncKnown();
      if (applyBelowAllowed && !applyBelowAllowed()) cancelApplyBelow();
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
        applyRequested = false; applyBelowAllowed = undefined;
        if (!stableReading) reset();
        throw error;
      }
      if (applyBelowAllowed && !applyBelowAllowed()) { cancelApplyBelow(); return; }
      pending.clear();
      let total = 0, hiddenCount = 0;
      for (const { article,id } of cards) {
        if (article.isConnected) total++;
        if (!id || !article.isConnected || tweetId(article) !== id) continue;
        const desired = Boolean(matches(rows.get(id)));
        let hidden = desired;
        if (stableReading) {
          if (applyRequested && (!applyBelowAllowed || belowReadingArea(article))) hidden = desired;
          else if (layouts.has(id)) hidden = layouts.get(id);
          else hidden = false;
          // Keep the reading area and everything above it at its already displayed height.
          layouts.delete(id); layouts.set(id,hidden);
          if (desired !== hidden) pending.add(id);
        }
        setHidden(article,id,hidden);
        if (hidden) hiddenCount++;
      }
      view = { primary,account,total,hidden:hiddenCount };
      while (layouts.size > 10000) { const id = layouts.keys().next().value; layouts.delete(id); pending.delete(id); }
      applyRequested = false; applyBelowAllowed = undefined;
      decisions = rows;
      signature = nextSignature;
    }
    function hiddenSummary() {
      return enabled() && view.primary === column() && view.account === accountHandle() ?
        { total:view.total,hidden:view.hidden } : { total:0,hidden:0 };
    }
    function restoreHidden() {
      const primary = column(), account = accountHandle();
      if (holdLayout() || !enabled() || !primary || !account || layoutAccount !== account) return false;
      invalidate(); applyRequested = false; applyBelowAllowed = undefined;
      const cards = cardsIn(primary);
      for (const { article,id } of cards) {
        if (!article.isConnected) continue;
        if (id) layouts.set(id,false);
        pending.delete(id); setHidden(article,id,false);
      }
      view = { primary,account,total:cards.length,hidden:0 };
      return true;
    }
    return { refresh,reset,invalidate,syncKnown,requestApply,requestApplyBelow,cancelApplyBelow,hasPendingBelow,hiddenSummary,restoreHidden,
      pendingCount:() => pending.size,applying:() => applyRequested };
  }
  globalThis.XReplyCardFilter = { create };
})();
