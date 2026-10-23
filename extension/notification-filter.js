(() => {
  "use strict";
  function create(options) {
    const { columnSelector,enabled,ready,holdLayout,save,schedule,accountHandle,
      autoEnabled,autoReady,saveAuto,likesEnabled = () => false } = options;
    let button;
    let applyButton;
    let controls;
    let autoButton;
    let saving = false;
    let error = "";
    let autoError = "";
    const IDLE_MS = 10000;
    let automaticTimer;
    let automaticActive = false;
    let automaticAccount = "";
    let lastActivity = Date.now();
    let lastAttempt = 0;
    let activityRevision = 0;
    const column = () => /^\/notifications(?:\/|$)/.test(location.pathname) ?
      document.querySelector(columnSelector) : null;
    const likes = globalThis.XReplyLikeNotifications.create({ column,accountHandle,holdLayout,autoEnabled:likesEnabled });
    const filter = globalThis.XReplyCardFilter.create({ ...options,column,
      enabled:() => ready() && enabled() && Boolean(button?.isConnected),
      attribute:"data-xrc-notification-hidden",
      stableReading:true,
      matches:row => Boolean(row?.status === "replied" && row.evidenceId && row.likeEvidenceId)
    });

    const commentsAutomatic = () => ready() && autoReady() && enabled() && autoEnabled();
    const automaticPending = () => (commentsAutomatic() && filter.pendingCount()) || likes.pendingAutomatic();
    function automaticAllowed() {
      return (commentsAutomatic() || likesEnabled()) && !saving &&
        !document.hidden && !holdLayout() && Boolean(column() && controls?.isConnected && accountHandle());
    }

    function stopAutomatic() {
      clearTimeout(automaticTimer);
      automaticTimer = undefined;
      automaticActive = false;
      filter.cancelApplyBelow();
    }

    function planAutomatic() {
      const account = accountHandle();
      if (automaticAccount !== account) { stopAutomatic(); automaticAccount = account; }
      if (!automaticAllowed()) { stopAutomatic(); return; }
      if (!automaticActive) { automaticActive = true; lastActivity = Date.now(); }
      if (!automaticPending() || filter.applying()) {
        clearTimeout(automaticTimer); automaticTimer = undefined; return;
      }
      if (automaticTimer !== undefined) return;
      const remaining = Math.max(0,lastActivity+IDLE_MS-Date.now(),lastAttempt+IDLE_MS-Date.now());
      automaticTimer = setTimeout(() => {
        automaticTimer = undefined;
        if (!automaticAllowed()) { stopAutomatic(); return; }
        if (Date.now()-lastActivity < IDLE_MS || Date.now()-lastAttempt < IDLE_MS) { planAutomatic(); return; }
        if (filter.applying() || !automaticPending()) return;
        if (likes.pendingAutomatic()) {
          likes.clearAutomaticBelow(); renderButton(); schedule();
        }
        // Do not poll protected rows: a later activity or data refresh can arm another idle check.
        if (!commentsAutomatic() || !filter.hasPendingBelow()) return;
        const revision = activityRevision;
        const scrollPosition = window.scrollY;
        lastAttempt = Date.now();
        filter.requestApplyBelow(() => automaticAllowed() && commentsAutomatic() && accountHandle() === account &&
          activityRevision === revision && window.scrollY === scrollPosition && Date.now()-lastActivity >= IDLE_MS);
        renderButton(); schedule();
      },remaining);
    }

    function activity(event) {
      lastActivity = Date.now(); activityRevision++;
      // Layout-induced scroll and synthetic events must not start a new like-cleanup batch.
      if (event?.isTrusted && ["wheel","touchmove","pointerdown","keydown"].includes(event.type)) likes.armAutomatic();
      const cancelled = filter.cancelApplyBelow();
      // Scroll/input is a constant-time hot path while an idle check is already armed.
      if ((commentsAutomatic() || likesEnabled()) && automaticPending() && (automaticTimer === undefined || cancelled)) planAutomatic();
      if (cancelled) renderButton();
    }

    function renderButton() {
      const primary = column();
      // Use the existing title bar, not an extra row above X's virtual list.
      const anchor = primary?.querySelector('a[href="/settings/notifications"]')?.parentElement;
      if (!anchor) {
        if (!holdLayout()) controls?.remove();
        else {
          if (button) button.disabled = true;
          if (applyButton) applyButton.disabled = true;
          if (autoButton) autoButton.disabled = true;
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
          if (!enabled() || saving || holdLayout() || filter.applying() ||
              (!filter.pendingCount() && !likes.available().length)) return;
          likes.clearLoaded();
          filter.requestApply(); renderButton(); schedule();
        });
      }
      if (!autoButton) {
        autoButton = document.createElement("button");
        autoButton.type = "button";
        autoButton.className = "xrc-filter-auto";
        autoButton.textContent = "自动整理";
        autoButton.addEventListener("click",async event => {
          event.stopPropagation();
          if (saving || !ready() || !autoReady() || holdLayout() || filter.applying()) return;
          saving = true; autoError = ""; stopAutomatic(); renderButton();
          try { await saveAuto(!autoEnabled()); }
          catch { autoError = "自动整理设置未保存，请点击重试。"; }
          finally { saving = false; activity(); renderButton(); schedule(); }
        });
      }
      if (!controls) {
        controls = document.createElement("div");
        controls.className = "xrc-notification-controls";
        controls.setAttribute("role","group");
        controls.setAttribute("aria-label","通知完成项筛选");
        controls.append(button,applyButton,autoButton);
      }
      if (anchor.previousElementSibling !== controls) anchor.before(controls);
      const label = error ? "保存失败，重试" : "隐藏已回且已点";
      if (button.textContent !== label) button.textContent = label;
      button.setAttribute("aria-pressed",String(enabled()));
      button.disabled = saving || !ready() || holdLayout() || filter.applying();
      button.title = error || `${enabled() ? "已开启，点击恢复评论及手动整理隐藏的点赞通知" : "点击开启，并隐藏当前已确认完成的评论通知"}。评论按同一原帖、同一个人的文字及红心标签判断。手动“整理列表”只额外隐藏点击瞬间已加载的点赞通知，关注等保留。自动隐藏点赞通知可在扩展弹窗独立开关。`;
      button.setAttribute("aria-label",error ? "隐藏已回且已点，设置保存失败，点击重试" : label);
      controls.setAttribute("aria-busy",String(saving || filter.applying()));
      const canOrganize = filter.pendingCount() || likes.available().length;
      applyButton.disabled = !ready() || !enabled() || saving || holdLayout() || filter.applying() || !canOrganize;
      applyButton.title = !enabled() ? "请先开启左侧隐藏开关。" : holdLayout() ? "回复框关闭后可整理列表，编辑时保持背景列表不动。" :
        filter.applying() ? "正在整理，请稍候。" : !canOrganize ? "当前已加载通知没有待整理内容。" :
        "一次性整理当前已加载内容：应用评论筛选，并额外隐藏点击瞬间已加载的点赞通知（单次最多100条）。新出现的点赞通知保留，不循环清理、不刷新网页或主动请求更多通知；关闭隐藏开关可恢复。";
      const applyText = "整理列表";
      if (applyButton.textContent !== applyText) applyButton.textContent = applyText;
      autoButton.setAttribute("aria-pressed",String(autoEnabled()));
      autoButton.setAttribute("aria-label",autoError || "自动整理：空闲10秒后处理阅读区下方，保护当前及上方卡片");
      autoButton.disabled = !ready() || !autoReady() || saving || holdLayout() || filter.applying();
      autoButton.title = autoError || `${autoEnabled() ? "已开启，点击关闭" : "默认关闭，点击开启"}。有变化且空闲10秒后，仅整理当前画面下方600px之外的卡片；滚动、点击、输入会重新计时。回复框、后台页面及隐藏开关关闭时暂停。当前阅读区及上方保留，手动“整理列表”可整理全部已加载内容。`;
    }

    for (const name of ["scroll","wheel","touchmove","pointerdown","keydown","input"]) {
      document.addEventListener(name,activity,{ capture:true,passive:true });
    }
    document.addEventListener("visibilitychange",() => { stopAutomatic(); activity(); renderButton(); });
    window.addEventListener("pagehide",stopAutomatic);
    window.addEventListener("pageshow",activity);
    return {
      ...filter,
      reset() { stopAutomatic(); filter.reset(); likes.restore(); },
      syncKnown() {
        filter.syncKnown();
        if (!enabled()) likes.restoreManual();
        if (likes.sync()) lastActivity = Date.now();
      },
      async refresh() {
        renderButton();
        if (!enabled()) likes.restoreManual();
        if (likes.sync()) lastActivity = Date.now();
        if (!automaticAllowed()) filter.cancelApplyBelow();
        try { await filter.refresh(); } finally { planAutomatic(); renderButton(); }
      }
    };
  }
  globalThis.XReplyNotificationFilter = { create };
})();
