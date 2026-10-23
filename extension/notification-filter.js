(() => {
  "use strict";
  function create(options) {
    const { columnSelector,enabled,ready,holdLayout,save,schedule,accountHandle,
      autoEnabled,autoReady,saveAuto } = options;
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
    let automaticPassAvailable = true;
    let lastActivity = Date.now();
    let lastAttempt = 0;
    let activityRevision = 0;
    const column = () => /^\/notifications(?:\/|$)/.test(location.pathname) ?
      document.querySelector(columnSelector) : null;
    const filter = globalThis.XReplyCardFilter.create({ ...options,column,
      enabled:() => ready() && enabled() && Boolean(button?.isConnected),
      attribute:"data-xrc-notification-hidden",
      stableReading:true,
      matches:row => Boolean(row?.evidenceId && row.likeEvidenceId &&
        (row.status === "replied" ||
         (row.status === "not-reply" && row.origin === "others" && row.likeEvidenceId === row.id)))
    });

    const commentsAutomatic = () => ready() && autoReady() && enabled() && autoEnabled();
    const automaticPending = () => automaticPassAvailable && commentsAutomatic() && filter.pendingCount();
    const canOrganize = () => enabled() && filter.pendingCount();
    function automaticAllowed() {
      return commentsAutomatic() && !saving &&
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
      if (automaticAccount !== account) { stopAutomatic(); automaticAccount = account; automaticPassAvailable = true; }
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
        // Do not poll protected rows: a later activity or data refresh can arm another idle check.
        if (!commentsAutomatic() || !filter.hasPendingBelow()) return;
        const revision = activityRevision;
        const scrollPosition = window.scrollY;
        automaticPassAvailable = false;
        lastAttempt = Date.now();
        filter.requestApplyBelow(() => automaticAllowed() && commentsAutomatic() && accountHandle() === account &&
          activityRevision === revision && window.scrollY === scrollPosition && Date.now()-lastActivity >= IDLE_MS);
        renderButton(); schedule();
      },remaining);
    }

    function activity(event) {
      lastActivity = Date.now(); activityRevision++;
      // New data and layout-induced scrolling cannot keep collapsing rows and loading more pages.
      if (event?.isTrusted && ["wheel","touchmove","pointerdown","keydown","input"].includes(event.type)) automaticPassAvailable = true;
      const cancelled = filter.cancelApplyBelow();
      // Scroll/input is a constant-time hot path while an idle check is already armed.
      if (commentsAutomatic() && automaticPending() && (automaticTimer === undefined || cancelled)) planAutomatic();
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
            if (next) { automaticPassAvailable = false; filter.requestApply(); schedule(); }
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
          if (saving || holdLayout() || filter.applying() || !canOrganize()) return;
          automaticPassAvailable = false;
          if (enabled()) filter.requestApply();
          renderButton(); schedule();
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
          finally { saving = false; if (autoEnabled()) automaticPassAvailable = true; activity(); renderButton(); schedule(); }
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
      button.title = error || `${enabled() ? "已开启，点击恢复已隐藏的完成评论" : "点击开启，并隐藏当前已确认完成的评论通知"}。评论按同一原帖、同一个人的文字及红心标签判断。自动隐藏点赞、关注、转发通知可在扩展弹窗分别开关。`;
      button.setAttribute("aria-label",error ? "隐藏已回且已点，设置保存失败，点击重试" : label);
      controls.setAttribute("aria-busy",String(saving || filter.applying()));
      const hasOrganizable = canOrganize();
      applyButton.disabled = !ready() || saving || holdLayout() || filter.applying() || !hasOrganizable;
      applyButton.title = "仅一次应用已加载评论的完成状态；点赞、关注、转发按各自开关在接收时过滤，不再追加隐藏占位。回复框关闭后可操作。";
      const applyText = "整理列表";
      if (applyButton.textContent !== applyText) applyButton.textContent = applyText;
      autoButton.setAttribute("aria-pressed",String(autoEnabled()));
      autoButton.setAttribute("aria-label",autoError || "自动整理：空闲10秒后处理阅读区下方，保护当前及上方卡片");
      autoButton.disabled = !ready() || !autoReady() || saving || holdLayout() || filter.applying();
      autoButton.title = autoError || `${autoEnabled() ? "已开启，点击关闭" : "默认关闭，点击开启"}。主动操作后空闲10秒，仅整理下方600px以外的卡片，每次只执行一轮；补位、新数据和页面自行滚动不会继续触发。回复框、后台及隐藏开关关闭时暂停，当前及上方保留。`;
    }

    for (const name of ["scroll","wheel","touchmove","pointerdown","keydown","input"]) {
      document.addEventListener(name,activity,{ capture:true,passive:true });
    }
    document.addEventListener("visibilitychange",() => { stopAutomatic(); activity(); renderButton(); });
    window.addEventListener("pagehide",stopAutomatic);
    window.addEventListener("pageshow",activity);
    return {
      ...filter,
      reset() { stopAutomatic(); filter.reset(); },
      syncKnown() {
        filter.syncKnown();
      },
      async refresh() {
        renderButton();
        if (!automaticAllowed()) filter.cancelApplyBelow();
        try { await filter.refresh(); } finally { planAutomatic(); renderButton(); }
      }
    };
  }
  globalThis.XReplyNotificationFilter = { create };
})();
