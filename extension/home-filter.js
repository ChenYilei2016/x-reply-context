(() => {
  "use strict";

  function column() {
    if (!/^\/home\/?$/.test(location.pathname)) return null;
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    const firstTab = primary?.querySelector('[role="tab"]');
    return firstTab?.getAttribute("aria-selected") === "true" &&
      !firstTab.getAttribute("href")?.startsWith("/notifications") ? primary : null;
  }

  function create(options) {
    return globalThis.XReplyCardFilter.create({ ...options,column,attribute:"data-xrc-home-hidden",
      matches:row => {
        // A conversation's other liked reply is not proof that this original was liked.
        const completed = row?.status === "not-reply" && row.origin === "others" &&
          row.evidenceId && row.likeEvidenceId === row.id;
        const mine = row?.status === "self" || (row?.status === "not-reply" && row.origin === "mine");
        return mine || completed;
      }
    });
  }
  globalThis.XReplyHomeFilter = { column,create };
})();
