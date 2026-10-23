(() => {
  "use strict";
  const ATTRIBUTE = "data-xrc-like-notification-hidden";
  const AUTO_ATTRIBUTE = "data-xrc-auto-like-hidden";
  const ICON_PATH = "M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z";
  function create({ column,accountHandle,holdLayout,autoEnabled = () => false }) {
    let automaticPending = false;
    let automaticContext = "";
    function identity(article,account) {
      // Only the leading event icon identifies a like; excerpts and usernames are not evidence.
      if (!article.matches('article[data-testid="notification"]') ||
          article.querySelector(':scope > div > div:first-child > svg path')?.getAttribute("d") !== ICON_PATH) return "";
      const time = article.querySelector("time");
      const timestamp = time?.getAttribute("datetime");
      if (!timestamp || !account) return "";
      const summary = time.closest('[dir="ltr"]')?.querySelector(':scope > span[dir="ltr"]')?.textContent || "";
      return JSON.stringify([account,timestamp,summary,
        Array.from(article.querySelectorAll('a[href]')).map(link => link.getAttribute("href")),
        article.querySelector('[data-testid="tweetText"]')?.textContent || ""]);
    }

    function available(eligible = () => true) {
      const primary = column();
      const account = accountHandle();
      const result = [];
      for (const article of primary?.querySelectorAll('article[data-testid="notification"]') || []) {
        if (article.hasAttribute(ATTRIBUTE) || article.hasAttribute(AUTO_ATTRIBUTE) || !eligible(article)) continue;
        const signature = identity(article,account);
        if (signature) result.push({ article,signature });
        if (result.length === 100) break;
      }
      return result;
    }

    function clearLoaded() {
      if (holdLayout()) return;
      automaticPending = false;
      // One click adopts one mounted snapshot. Later arrivals are never adopted by sync().
      const snapshot = available();
      for (const { article,signature } of snapshot) article.setAttribute(ATTRIBUTE,signature);
    }

    function armAutomatic() { if (autoEnabled()) automaticPending = true; }

    function clearAutomaticBelow() {
      if (!autoEnabled() || !automaticPending || holdLayout()) return;
      // Consume one user browsing opportunity, even if no safe row exists. DOM arrivals cannot rearm it.
      automaticPending = false;
      const snapshot = available(article => article.getBoundingClientRect().top > window.innerHeight+600);
      for (const { article,signature } of snapshot) article.setAttribute(AUTO_ATTRIBUTE,signature);
    }

    function sync() {
      const primary = column();
      const account = accountHandle();
      const context = primary ? `${account}:${autoEnabled()}` : holdLayout() ? automaticContext : "";
      const changed = context !== automaticContext;
      if (changed) { automaticContext = context; automaticPending = Boolean(primary && autoEnabled()); }
      for (const article of document.querySelectorAll(`[${ATTRIBUTE}],[${AUTO_ATTRIBUTE}]`)) {
        const signature = identity(article,account);
        for (const attribute of [ATTRIBUTE,AUTO_ATTRIBUTE]) {
          const disabled = attribute === AUTO_ATTRIBUTE && !autoEnabled() && !holdLayout();
          if (disabled || signature !== article.getAttribute(attribute) ||
              (primary ? !primary.contains(article) : !holdLayout())) article.removeAttribute(attribute);
        }
      }
      return changed;
    }

    function restoreManual() {
      if (!holdLayout()) document.querySelectorAll(`[${ATTRIBUTE}]`).forEach(article => article.removeAttribute(ATTRIBUTE));
    }
    function restore() {
      document.querySelectorAll(`[${ATTRIBUTE}],[${AUTO_ATTRIBUTE}]`).forEach(article => {
        article.removeAttribute(ATTRIBUTE); article.removeAttribute(AUTO_ATTRIBUTE);
      });
      automaticPending = false; automaticContext = "";
    }
    return { available,clearLoaded,sync,restore,restoreManual,armAutomatic,clearAutomaticBelow,
      pendingAutomatic:() => autoEnabled() && automaticPending };
  }
  globalThis.XReplyLikeNotifications = { create };
})();
