(() => {
  "use strict";
  function create(options) {
    const { columnSelector,enabled,ready,holdLayout,save } = options;
    let button;
    let saving = false;
    let error = "";
    const column = () => /^\/notifications(?:\/|$)/.test(location.pathname) ?
      document.querySelector(columnSelector) : null;
    const filter = globalThis.XReplyCardFilter.create({ ...options,column,
      enabled:() => ready() && enabled() && Boolean(button?.isConnected),
      attribute:"data-xrc-notification-hidden",
      matches:row => Boolean(row?.status === "replied" && row.evidenceId && row.likeEvidenceId)
    });

    function renderButton() {
      const primary = column();
      if (!primary) {
        if (!holdLayout()) button?.remove();
        return;
      }
      // Use the existing title bar, not an extra row above X's virtual list.
      const anchor = primary.querySelector('a[href="/settings/notifications"]')?.parentElement;
      if (!anchor) { button?.remove(); return; }
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "xrc-notification-filter";
        button.addEventListener("click",async event => {
          event.stopPropagation();
          if (saving || !ready()) return;
          saving = true; error = ""; renderButton();
          try { await save(!enabled()); }
          catch { error = "设置未保存，请重试"; }
          finally { saving = false; renderButton(); }
        });
      }
      if (anchor.previousElementSibling !== button) anchor.before(button);
      const label = saving ? "保存中…" : error ? "保存失败，重试" : "隐藏已回且已点";
      if (button.textContent !== label) button.textContent = label;
      button.setAttribute("aria-pressed",String(enabled()));
      button.disabled = saving || !ready();
      button.title = error || `${enabled() ? "已开启，点击恢复全部评论通知" : "点击隐藏已完成评论通知"}。按同一原帖、同一个人的文字及红心标签判断；点赞、关注等通知保留。回复框关闭后应用。`;
    }

    return {
      ...filter,
      async refresh() { renderButton(); await filter.refresh(); }
    };
  }
  globalThis.XReplyNotificationFilter = { create };
})();
