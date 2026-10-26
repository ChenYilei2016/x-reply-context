(() => {
  "use strict";
  function create(options) {
    const { columnSelector,enabled,ready,holdLayout,save,schedule,accountHandle,
      autoEnabled,autoReady,saveAuto,mode } = options;
    let button;
    let repliedButton;
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
      matches:row => Boolean(row?.evidenceId &&
        (row.status === "replied" || row.status === "not-reply" && row.origin === "others") &&
        (mode() === "replied" || row.likeEvidenceId &&
          (row.status === "replied" || row.likeEvidenceId === row.id)))
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

    async function toggleMode(value,event) {
      event.stopPropagation();
      if (saving || !ready() || holdLayout() || filter.applying()) return;
      saving = true; error = ""; stopAutomatic(); renderButton();
      const next = mode() === value ? "off" : value;
      try {
        await save(next);
        filter.invalidate();
        if (next !== "off") { automaticPassAvailable = false; filter.requestApply(); }
        schedule();
      } catch { error = "设置未保存，请重试"; }
      finally { saving = false; renderButton(); }
    }

    function renderButton() {
      const primary = column();
      // Use the existing title bar, not an extra row above X's virtual list.
      const anchor = primary?.querySelector('a[href="/settings/notifications"]')?.parentElement;
      if (!anchor) {
        if (!holdLayout()) controls?.remove();
        else {
          for (const control of [button,repliedButton,applyButton,autoButton]) {
            if (control && !control.disabled) control.disabled = true;
          }
        }
        return;
      }
      // Read layout before changing controls, and reuse it within this synchronous render.
      const applying = filter.applying();
      const unavailable = saving || !ready() || holdLayout() || applying;
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "xrc-notification-filter";
        button.addEventListener("click",event => toggleMode("completed",event));
      }
      if (!repliedButton) {
        repliedButton = document.createElement("button");
        repliedButton.type = "button";
        repliedButton.className = "xrc-notification-replied";
        repliedButton.addEventListener("click",event => toggleMode("replied",event));
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
        controls.append(button,repliedButton,applyButton,autoButton);
      }
      if (anchor.previousElementSibling !== controls) anchor.before(controls);
      for (const [control,value,label,rule] of [
        [button,"completed","已回且已点","需要文字回复和红心均有依据；他人原帖及引用帖需要点赞本帖。"],
        [repliedButton,"replied","仅已回","只要求已有文字回复依据，不要求红心；已经点赞的也包含在内。"]
      ]) {
        if (control.textContent !== label) control.textContent = label;
        const selected = mode() === value;
        const pressed = String(selected);
        if (control.getAttribute("aria-pressed") !== pressed) control.setAttribute("aria-pressed",pressed);
        if (control.disabled !== unavailable) control.disabled = unavailable;
        const title = error || `${selected ? "已开启，再点关闭隐藏" : "点击选择此隐藏条件，与另一项互斥"}。${rule}按同一原帖、同一个人的回复证据判断。仅处理已加载通知，不主动翻页。`;
        if (control.title !== title) control.title = title;
        const accessibleLabel = `隐藏${label}${error ? "，设置保存失败，点击重试" : ""}`;
        if (control.getAttribute("aria-label") !== accessibleLabel) control.setAttribute("aria-label",accessibleLabel);
      }
      const busy = String(saving || applying);
      if (controls.getAttribute("aria-busy") !== busy) controls.setAttribute("aria-busy",busy);
      const hasOrganizable = canOrganize();
      const applyDisabled = unavailable || !hasOrganizable;
      if (applyButton.disabled !== applyDisabled) applyButton.disabled = applyDisabled;
      const applyTitle = "仅一次应用已加载评论的完成状态；点赞、关注、转发按各自开关在接收时过滤，不再追加隐藏占位。回复框关闭后可操作。";
      if (applyButton.title !== applyTitle) applyButton.title = applyTitle;
      const applyText = "整理列表";
      if (applyButton.textContent !== applyText) applyButton.textContent = applyText;
      const automatic = autoEnabled(), automaticPressed = String(automatic);
      if (autoButton.getAttribute("aria-pressed") !== automaticPressed) autoButton.setAttribute("aria-pressed",automaticPressed);
      const autoLabel = autoError || "自动整理：空闲10秒后处理阅读区下方，保护当前及上方卡片";
      if (autoButton.getAttribute("aria-label") !== autoLabel) autoButton.setAttribute("aria-label",autoLabel);
      const autoDisabled = unavailable || !autoReady();
      if (autoButton.disabled !== autoDisabled) autoButton.disabled = autoDisabled;
      const autoTitle = autoError || `${automatic ? "已开启，点击关闭" : "默认关闭，点击开启"}。主动操作后空闲10秒，仅整理下方600px以外的卡片，每次只执行一轮；补位、新数据和页面自行滚动不会继续触发。回复框、后台及隐藏开关关闭时暂停，当前及上方保留。`;
      if (autoButton.title !== autoTitle) autoButton.title = autoTitle;
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
      restoreHidden() {
        if (saving || holdLayout() || !column()) return false;
        stopAutomatic(); automaticPassAvailable = false;
        const restored = filter.restoreHidden();
        if (restored) schedule(0);
        return restored;
      },
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
