(() => {
  "use strict";
  function create(options) {
    const { columnSelector,enabled,ready,holdLayout,save,schedule } = options;
    let button;
    let applyButton;
    let controls;
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
      // Use the existing title bar, not an extra row above X's virtual list.
      const anchor = primary?.querySelector('a[href="/settings/notifications"]')?.parentElement;
      if (!anchor) {
        if (!holdLayout()) controls?.remove();
        else {
          if (button) button.disabled = true;
          if (applyButton) applyButton.disabled = true;
        }
        return;
      }
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "xrc-notification-filter";
        button.addEventListener("click",async event => {
          event.stopPropagation();
          if (saving || !ready() || holdLayout() || filter.applying()) return;
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
        applyButton.addEventListener("click",event => {
          event.stopPropagation();
          if (!enabled() || saving || holdLayout() || filter.applying() || !filter.pendingCount()) return;
          filter.requestApply(); renderButton(); schedule();
        });
      }
      if (!controls) {
        controls = document.createElement("div");
        controls.className = "xrc-notification-controls";
        controls.setAttribute("role","group");
        controls.setAttribute("aria-label","通知完成项筛选");
        controls.append(button,applyButton);
      }
      if (anchor.previousElementSibling !== controls) anchor.before(controls);
      const label = error ? "保存失败，重试" : "隐藏已回且已点";
      if (button.textContent !== label) button.textContent = label;
      button.setAttribute("aria-pressed",String(enabled()));
      button.disabled = saving || !ready() || holdLayout() || filter.applying();
      button.title = error || `${enabled() ? "已开启，点击恢复全部评论通知" : "点击开启，并隐藏当前已确认完成的评论通知"}。按同一原帖、同一个人的文字及红心标签判断；点赞、关注等通知保留。已显示卡片保持位置，后续变化点击右侧“整理列表”后隐藏或恢复。`;
      button.setAttribute("aria-label",error ? "隐藏已回且已点，设置保存失败，点击重试" : label);
      controls.setAttribute("aria-busy",String(saving || filter.applying()));
      applyButton.disabled = !ready() || !enabled() || saving || holdLayout() || filter.applying() || !filter.pendingCount();
      applyButton.title = !enabled() ? "请先开启左侧隐藏开关。" : holdLayout() ? "回复框关闭后可整理列表，编辑时保持背景列表不动。" :
        filter.applying() ? "正在整理，请稍候。" : !filter.pendingCount() ? "当前已加载通知没有待整理的变化。" :
        "按最新的已回、已点赞依据整理当前已加载通知。只在点击后隐藏或恢复卡片；不刷新网页或请求更多通知。滚动和关闭空回复框不自动收起当前卡片。";
      const applyText = "整理列表";
      if (applyButton.textContent !== applyText) applyButton.textContent = applyText;
    }

    return {
      ...filter,
      async refresh() { renderButton(); try { await filter.refresh(); } finally { renderButton(); } }
    };
  }
  globalThis.XReplyNotificationFilter = { create };
})();
