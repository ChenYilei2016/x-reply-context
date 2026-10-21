(() => {
  "use strict";
  function create(options) {
    const { columnSelector,enabled,ready,holdLayout,save,schedule } = options;
    let button;
    let applyButton;
    let saving = false;
    let error = "";
    const column = () => /^\/notifications(?:\/|$)/.test(location.pathname) ?
      document.querySelector(columnSelector) : null;
    const filter = globalThis.XReplyCardFilter.create({ ...options,column,
      enabled:() => ready() && enabled() && Boolean(button?.isConnected),
      attribute:"data-xrc-notification-hidden",
      stableReading:true,
      matches:row => Boolean(row?.status === "replied" && row.evidenceId && row.likeEvidenceId)
    });

    function renderButton() {
      const primary = column();
      if (!primary) {
        if (!holdLayout()) { button?.remove(); applyButton?.remove(); }
        return;
      }
      // Use the existing title bar, not an extra row above X's virtual list.
      const anchor = primary.querySelector('a[href="/settings/notifications"]')?.parentElement;
      if (!anchor) { button?.remove(); applyButton?.remove(); return; }
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "xrc-notification-filter";
        button.addEventListener("click",async event => {
          event.stopPropagation();
          if (saving || !ready()) return;
          saving = true; error = ""; renderButton();
          const next = !enabled();
          try {
            await save(next);
            if (next) { filter.requestApply(); schedule(); }
          }
          catch { error = "设置未保存，请重试"; }
          finally { saving = false; renderButton(); }
        });
      }
      if (!applyButton) {
        applyButton = document.createElement("button");
        applyButton.type = "button";
        applyButton.className = "xrc-filter-apply";
        applyButton.title = "后台依据有更新。仅在你点击时整理当前已加载通知；浏览或关闭空回复框不会自动收起已显示的卡片。";
        applyButton.addEventListener("click",event => {
          event.stopPropagation();
          if (holdLayout() || filter.applying()) return;
          filter.requestApply(); schedule();
        });
      }
      if (anchor.previousElementSibling !== applyButton) anchor.before(applyButton);
      if (applyButton.previousElementSibling !== button) applyButton.before(button);
      const label = saving ? "保存中…" : error ? "保存失败，重试" : "隐藏已回且已点";
      if (button.textContent !== label) button.textContent = label;
      button.setAttribute("aria-pressed",String(enabled()));
      button.disabled = saving || !ready();
      button.title = error || `${enabled() ? "已开启，点击恢复全部评论通知" : "点击隐藏已完成评论通知"}。按同一原帖、同一个人的文字及红心标签判断；点赞、关注等通知保留。已显示卡片保持位置，后续变化点击“整理更新”后应用。`;
      applyButton.hidden = !enabled() || !filter.pendingCount();
      applyButton.disabled = holdLayout() || filter.applying();
      const applyText = filter.applying() ? "整理中…" : `整理更新 ${Math.min(filter.pendingCount(),99)}${filter.pendingCount()>99 ? "+" : ""}`;
      if (applyButton.textContent !== applyText) applyButton.textContent = applyText;
    }

    return {
      ...filter,
      async refresh() { renderButton(); try { await filter.refresh(); } finally { renderButton(); } }
    };
  }
  globalThis.XReplyNotificationFilter = { create };
})();
