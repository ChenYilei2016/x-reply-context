(() => {
  "use strict";
  const CHANNEL = "x-reply-context-v1";
  const NOTIFICATION_COLUMN = '[data-testid="primaryColumn"]:has(a[role="tab"][href^="/notifications"])';
  let timer;
  let running = false;
  let again = false;
  let urgentRefresh = false;
  let lastAccount = "";
  let lastSignature = "";
  let annotationRevision = 0;
  const pending = [];
  let continuous;
  let hideCompletedHome = false;
  let homeSettingLoaded = false;
  let hideCompletedNotifications = false;
  let notificationSettingLoaded = false;
  let autoOrganizeNotifications = false;
  let automaticSettingLoaded = false;
  let autoHideLikeNotifications = true;
  let likeSettingLoaded = false;
  let autoHideFollowNotifications = true;
  let followSettingLoaded = false;
  let networkStatus;
  let networkNotice;
  let disconnected = false;
  const homeFilter = globalThis.XReplyHomeFilter.create({
    accountHandle,tweetId,message,holdLayout,enabled:() => hideCompletedHome
  });

  function disconnectRuntime() {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(timer); timer = undefined; pending.length = 0; again = false;
    observer.disconnect();
    continuous?.stop();
    if (networkNotice) networkNotice.hidden = true;
    // Pause without resetting filters: restoring hidden rows here would move the reading position.
    void notificationFilter.refresh();
    document.querySelectorAll(".xrc-notification-controls button").forEach(button => { button.disabled = true; });
    const notice = document.createElement("aside");
    notice.className = "xrc-runtime-notice";
    notice.setAttribute("role","status");
    const text = document.createElement("span");
    text.textContent = "扩展连接已失效，标签暂不可用，请刷新此页。若刚发送过，请先在 X 核对，勿重复发送。";
    const reload = document.createElement("button");
    reload.type = "button"; reload.textContent = "刷新此页";
    reload.addEventListener("click",() => {
      if (document.querySelector('[role="dialog"] [contenteditable="true"],[role="dialog"] [data-testid="attachments"]')) {
        text.textContent = "请先手动保存草稿并关闭回复框，再刷新；不会自动重发。";
        return;
      }
      location.reload();
    });
    notice.append(text,reload); (document.body || document.documentElement).append(notice);
  }

  function connected() {
    if (!disconnected && !chrome.runtime?.id) disconnectRuntime();
    return !disconnected;
  }
  const notificationFilter = globalThis.XReplyNotificationFilter.create({
    accountHandle,tweetId,message,holdLayout,schedule,columnSelector:NOTIFICATION_COLUMN,
    enabled:() => hideCompletedNotifications,ready:() => notificationSettingLoaded,
    autoEnabled:() => autoOrganizeNotifications,autoReady:() => automaticSettingLoaded,
    saveAuto:async value => {
      await chrome.storage.local.set({ autoOrganizeNotifications:value });
      autoOrganizeNotifications = value;
    },
    save:async value => {
      await chrome.storage.local.set({ hideCompletedNotifications:value });
      hideCompletedNotifications = value;
      notificationFilter.invalidate(); lastSignature = ""; schedule();
    }
  });

  function publishNetworkSettings() {
    if (!likeSettingLoaded || !followSettingLoaded) return;
    window.postMessage({ channel:CHANNEL,type:"NOTIFICATION_FILTER_SETTINGS",
      likes:autoHideLikeNotifications,follows:autoHideFollowNotifications },location.origin);
  }

  function renderNetworkNotice() {
    const timeline = location.pathname.includes("mentions") ? "mentions" :
      location.pathname.includes("verified") ? "verified" : "all";
    const show = /^\/notifications(?:\/|$)/.test(location.pathname) && !holdLayout() &&
      networkStatus?.paused && networkStatus.account === accountHandle() &&
      networkStatus.key?.toLowerCase() === `${accountHandle()}:${timeline}`;
    if (!show) { if (networkNotice) networkNotice.hidden = true; return; }
    if (!networkNotice) {
      networkNotice = document.createElement("div");
      networkNotice.className = "xrc-network-notice";
      networkNotice.setAttribute("role","status");
      const text = document.createElement("span");
      const next = document.createElement("button"); next.type = "button"; next.className = "xrc-network-continue";
      next.addEventListener("click",() => {
        if (holdLayout() || networkStatus?.account !== accountHandle()) return;
        window.postMessage({ channel:CHANNEL,type:"NOTIFICATION_FILTER_CONTINUE",key:networkStatus.key },location.origin);
        networkNotice.hidden = true;
        window.dispatchEvent(new Event("scroll"));
      });
      networkNotice.append(text,next); document.body.append(networkNotice);
    }
    networkNotice.querySelector("span").textContent = networkStatus.empty ?
      "本批没有可显示通知，已暂停翻页" : "本批已加载，继续翻页需手动确认";
    const next = networkNotice.querySelector("button");
    next.disabled = networkStatus.loading === true;
    next.textContent = next.disabled ? "加载中" : "继续加载";
    networkNotice.hidden = false;
  }

  function accountHandle() {
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return profile?.getAttribute("href")?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase() || "";
  }

  function tweetId(article) {
    const time = article.querySelector("time");
    return time?.closest("a")?.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1] || "";
  }

  function holdLayout() {
    return disconnected || /^\/compose(?:\/|$)/.test(location.pathname) ||
      Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).some(dialog => {
        const box = dialog.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(dialog).visibility !== "hidden";
      });
  }

  function labelAnchor(article) {
    const outsideQuote = node => !node.closest('[role="link"]');
    return Array.from(article.querySelectorAll('[data-testid="tweetText"]')).find(outsideQuote) ||
      Array.from(article.querySelectorAll('[role="group"]')).find(outsideQuote);
  }

  function schedule(delay = 250) {
    if (!connected()) return;
    if (delay === 0) urgentRefresh = true;
    if (timer && delay !== 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void refresh(); },delay);
  }

  function invalidateAnnotations() {
    lastSignature = ""; annotationRevision++; continuous?.invalidateContext();
  }

  async function message(payload) {
    if (!connected()) throw new Error("扩展连接已失效，请刷新页面");
    try {
      const reply = await chrome.runtime.sendMessage(payload);
      if (!connected()) throw new Error("扩展连接已失效，请刷新页面");
      if (!reply?.ok) throw new Error(reply?.error || "扩展连接已断开，请刷新页面");
      return reply;
    } catch (error) {
      if (/Extension context invalidated/i.test(error.message) || !chrome.runtime?.id) disconnectRuntime();
      throw error;
    }
  }

  function persistInteraction(batch,account) {
    const saved = message({ type:"INGEST",account,batch });
    void saved.then(() => {
      invalidateAnnotations(); homeFilter.invalidate(); notificationFilter.invalidate(); schedule(0);
    },error => console.warn("回过了：",error.message));
    return saved;
  }

  function link(label, id, title) {
    const anchor = document.createElement("a");
    anchor.textContent = label;
    anchor.href = `https://x.com/i/status/${id}`;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    if (title) anchor.title = title;
    return anchor;
  }

  function render(article, result) {
    article.dataset.xrcId = result.id;
    article.dataset.xrcStatus = result.status;
    article.dataset.xrcOrigin = result.origin;
    let bar = article.querySelector(".xrc-labels");
    if (result.status === "self" || (result.status === "not-reply" && result.origin === "mine")) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "xrc-labels";
      bar.setAttribute("aria-label","回过了 · 对话提示");
      bar.addEventListener("click",event => event.stopPropagation());
      const anchor = labelAnchor(article);
      if (!anchor) return;
      anchor.before(bar);
    }
    renderLabels(bar,result);
  }

  function renderLabels(bar,result) {
    const signature = JSON.stringify(result);
    if (bar.dataset.signature === signature) return;
    bar.dataset.signature = signature;
    bar.dataset.origin = result.origin;
    const origin = document.createElement("span");
    origin.className = "xrc-origin";
    origin.textContent = { mine:"我原帖", others:"别人原帖", unknown:"原帖待确认" }[result.origin];
    origin.title = result.rootHandle ?
      `原帖作者 @${result.rootHandle}；按整段对话最初的帖子判断，楼中楼沿用原帖归属。` :
      "尚未读取到原帖作者，暂不判断归属。";
    const labels = [origin];
    const status = result.evidenceId ? link("文字-已回",result.evidenceId,result.evidenceText) :
      document.createElement("span");
    status.className = "xrc-status";
    status.dataset.confirmed = String(Boolean(result.evidenceId));
    if (!result.evidenceId) status.textContent = "文字-待确认";
    status.title = result.evidenceId ?
      `${result.status === "not-reply" ? "你已在这篇原帖下评论过（含楼中楼）" : "你在同一原帖里已经回复过这个人"}。点击查看：${result.evidenceText || "我的回复"}` :
      "当前本地记录还没有确认你回过此人，不代表你从未回复。";
    const heart = result.likeEvidenceId ? link("红心-已点",result.likeEvidenceId) : document.createElement("span");
    heart.className = "xrc-heart";
    heart.dataset.confirmed = String(Boolean(result.likeEvidenceId));
    if (!result.likeEvidenceId) heart.textContent = "红心-待确认";
    heart.title = result.likeEvidenceId ?
      (result.likeEvidenceId === result.id ?
        "已给这条帖子点过红心。点击查看；若是旧记录，状态以 X 当前显示为准。" :
        "已给这个人在同一原帖中的另一条帖子点过红心。点击查看依据；若是旧记录，状态以 X 当前显示为准。") :
      "当前记录没有确认你给这个人在同一原帖中点过红心，不代表从未点赞。";
    labels.push(status,heart);
    if (result.personStats) {
      for (const [label,count,description] of [
        ["我评他",result.personStats.myCommentedPosts,"你评论过他的几篇原帖"],
        ["他评我",result.personStats.theirCommentedPosts,"他评论过你的几篇原帖"]
      ]) {
        const badge = document.createElement("span");
        badge.className = "xrc-person";
        badge.textContent = `${label} ${count}`;
        badge.title = `${description}。同一篇下多次评论（含楼中楼）只算 1 篇；在自己或第三方原帖下回话、点赞均不计。只统计本地保留且已确认原帖作者的记录。`;
        labels.push(badge);
      }
    }
    labels.push(result.rootId ? link("原帖",result.rootId) : link("查看上下文",result.id));
    const main = document.createElement("div");
    main.className = "xrc-main-labels";
    main.replaceChildren(...labels);
    bar.replaceChildren(main);
    if (result.newPerson) {
      const badge = document.createElement("strong");
      badge.className = "xrc-new-person";
      badge.textContent = "NEW";
      badge.title = "这条是本地记录中他第一次评论你的原帖，且“我评他”为 0。仅第一条评论通知标新，后续不重复；点赞、你在自己原帖下回他不影响 NEW。只依据本地已读取记录，不保证覆盖完整历史。";
      bar.append(badge);
    }
  }

  async function refresh() {
    if (!connected()) return;
    continuous?.refresh();
    renderNetworkNotice();
    window.postMessage({ channel:CHANNEL,type:"NOTIFICATION_FILTER_CONTEXT" },location.origin);
    if (running) { again = true; return; }
    running = true;
    urgentRefresh = false;
    try {
      const account = accountHandle();
      if (!account) { homeFilter.reset(); notificationFilter.reset(); return; }
      if (account !== lastAccount) {
        document.querySelectorAll(".xrc-labels").forEach(node => node.remove());
        lastAccount = account;
        invalidateAnnotations();
        homeFilter.reset();
        notificationFilter.reset();
      }
      if (pending.length) {
        const batches = pending.splice(0);
        for (const batch of batches) await message({ type:"INGEST",batch,account });
        invalidateAnnotations();
      }
      await homeFilter.refresh();
      await notificationFilter.refresh();
      // Fixed label slots let counts refresh behind a composer without moving rows.
      if (!/^\/notifications(?:\/|$)/.test(location.pathname) && !holdLayout()) {
        document.querySelectorAll(".xrc-labels").forEach(node => node.remove());
        lastSignature = "";
        return;
      }
      const column = document.querySelector(NOTIFICATION_COLUMN);
      if (!column) return;
      const articles = Array.from(column?.querySelectorAll('article[data-testid="tweet"]') || [])
        .filter(article => !article.closest('[role="dialog"],[aria-modal="true"]'));
      const ids = articles.map(tweetId);
      const signature = account + ":" + ids.join(",");
      const annotationsPresent = articles.every((article,index) => !ids[index] ||
        (article.dataset.xrcId === ids[index] &&
         (article.dataset.xrcStatus === "self" ||
          (article.dataset.xrcStatus === "not-reply" && article.dataset.xrcOrigin === "mine") || article.querySelector(".xrc-labels"))));
      if (signature === lastSignature && annotationsPresent) return;
      const observedRevision = annotationRevision;
      const byId = new Map();
      for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await message({ type:"CLASSIFY",account,ids:ids.slice(offset,offset+100).filter(Boolean) });
        if (observedRevision !== annotationRevision) { again = true; return; }
        if (accountHandle() !== account || document.querySelector(NOTIFICATION_COLUMN) !== column ||
            (!/^\/notifications(?:\/|$)/.test(location.pathname) && !holdLayout())) return;
        for (const row of result.rows) byId.set(row.id,row);
      }
      for (const article of articles) {
        const row = byId.get(tweetId(article));
        if (article.isConnected && row) render(article,row);
      }
      lastSignature = signature;
    } catch (error) {
      console.warn("回过了：",error.message);
    } finally {
      running = false;
      if (again) { again = false; schedule(urgentRefresh ? 0 : 250); }
    }
  }

  continuous = globalThis.XReplyContinuous?.create({ accountHandle,tweetId,columnSelector:NOTIFICATION_COLUMN,message,renderLabels,connected });

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.channel !== CHANNEL) return;
    if (!connected()) return;
    if (event.data.type === "OBSERVER_READY") {
      window.postMessage({ channel:CHANNEL,type:"READY" },location.origin);
      publishNetworkSettings();
      return;
    }
    if (event.data.type === "NOTIFICATION_FILTER_STATUS") {
      networkStatus = event.data; schedule(); return;
    }
    if (["REPLY_STARTED","REPLY_RESULT"].includes(event.data.type)) {
      const data = event.data;
      const saved = data.type === "REPLY_RESULT" && data.status === "sent" &&
        data.account === accountHandle() && data.batch ?
        persistInteraction(data.batch,data.account) : null;
      void continuous?.receiveReply(data,saved);
      return;
    }
    if (event.data.type !== "OBSERVED") return;
    if (event.data.interaction === true) {
      if (event.data.account === accountHandle() && event.data.batch) persistInteraction(event.data.batch,event.data.account);
      return;
    }
    if (pending.length < 10) pending.push(event.data.batch);
    schedule();
  });
  chrome.runtime.onMessage.addListener((request,_sender,respond) => {
    if (request?.type === "GET_ACCOUNT") respond({ account:accountHandle() });
  });
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area !== "local" || !connected()) return;
    if (changes.replyContext || changes.replyContextRevision) {
      invalidateAnnotations(); homeFilter.invalidate(); notificationFilter.invalidate(); schedule();
    }
    if (changes.hideCompletedHome) {
      hideCompletedHome = changes.hideCompletedHome.newValue === true;
      homeSettingLoaded = true;
      homeFilter.invalidate(); schedule();
    }
    if (changes.hideCompletedNotifications) {
      hideCompletedNotifications = changes.hideCompletedNotifications.newValue === true;
      notificationSettingLoaded = true;
      notificationFilter.invalidate(); schedule();
    }
    if (changes.autoOrganizeNotifications) {
      autoOrganizeNotifications = changes.autoOrganizeNotifications.newValue === true;
      automaticSettingLoaded = true;
      schedule();
    }
    if (changes.autoHideLikeNotifications) {
      autoHideLikeNotifications = changes.autoHideLikeNotifications.newValue !== false;
      likeSettingLoaded = true;
      publishNetworkSettings();
      schedule();
    }
    if (changes.autoHideFollowNotifications) {
      autoHideFollowNotifications = changes.autoHideFollowNotifications.newValue !== false;
      followSettingLoaded = true;
      publishNetworkSettings();
      schedule();
    }
  });
  void chrome.storage.local.get(["hideCompletedHome","hideCompletedNotifications","autoOrganizeNotifications","autoHideLikeNotifications","autoHideFollowNotifications"]).then(saved => {
    if (!connected()) return;
    if (!homeSettingLoaded) hideCompletedHome = saved.hideCompletedHome === true;
    homeSettingLoaded = true;
    if (!notificationSettingLoaded) hideCompletedNotifications = saved.hideCompletedNotifications === true;
    notificationSettingLoaded = true;
    if (!automaticSettingLoaded) autoOrganizeNotifications = saved.autoOrganizeNotifications === true;
    automaticSettingLoaded = true;
    if (!likeSettingLoaded) autoHideLikeNotifications = saved.autoHideLikeNotifications !== false;
    likeSettingLoaded = true;
    if (!followSettingLoaded) autoHideFollowNotifications = saved.autoHideFollowNotifications !== false;
    followSettingLoaded = true;
    publishNetworkSettings();
    homeFilter.invalidate(); notificationFilter.invalidate(); schedule();
  },error => console.warn("回过了：",error.message));
  const observer = new MutationObserver(records => {
    if (!connected()) return;
    if (records.some(record => !record.target.closest?.(".xrc-labels,.xrc-continuous,.xrc-flow-notice,.xrc-notification-controls,.xrc-network-notice"))) {
      homeFilter.syncKnown(); notificationFilter.syncKnown(); schedule();
    }
  });
  observer.observe(document,{ childList:true,subtree:true,attributes:true,
    attributeFilter:["aria-selected","data-testid","aria-disabled","disabled","href","datetime"] });
  window.addEventListener("popstate",schedule);
  document.addEventListener("visibilitychange",() => { if (!document.hidden) schedule(); });
  window.postMessage({ channel:CHANNEL,type:"READY" },location.origin);
  schedule();
})();
