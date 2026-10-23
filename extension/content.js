(() => {
  "use strict";
  const CHANNEL = "x-reply-context-v1";
  const NOTIFICATION_COLUMN = '[data-testid="primaryColumn"]:has(a[role="tab"][href^="/notifications"])';
  let timer;
  let running = false;
  let again = false;
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
  const homeFilter = globalThis.XReplyHomeFilter.create({
    accountHandle,tweetId,message,holdLayout,enabled:() => hideCompletedHome
  });
  const notificationFilter = globalThis.XReplyNotificationFilter.create({
    accountHandle,tweetId,message,holdLayout,schedule,columnSelector:NOTIFICATION_COLUMN,
    enabled:() => hideCompletedNotifications,ready:() => notificationSettingLoaded,
    autoEnabled:() => autoOrganizeNotifications,autoReady:() => automaticSettingLoaded,
    likesEnabled:() => likeSettingLoaded && autoHideLikeNotifications,
    followsEnabled:() => followSettingLoaded && autoHideFollowNotifications,
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

  function accountHandle() {
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return profile?.getAttribute("href")?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase() || "";
  }

  function tweetId(article) {
    const time = article.querySelector("time");
    return time?.closest("a")?.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1] || "";
  }

  function holdLayout() {
    return /^\/compose(?:\/|$)/.test(location.pathname) ||
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

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); },250);
  }

  function invalidateAnnotations() {
    lastSignature = ""; annotationRevision++; continuous?.invalidateContext();
  }

  async function message(payload) {
    const reply = await chrome.runtime.sendMessage(payload);
    if (!reply?.ok) throw new Error(reply?.error || "扩展连接已断开，请刷新页面");
    return reply;
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
    let bar = article.querySelector(".xrc-labels");
    if (["self","not-reply"].includes(result.status)) {
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
    status.title = result.status === "replied" ?
      `你在同一原帖里已经回复过这个人。点击查看：${result.evidenceText || "我的回复"}` :
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
    continuous?.refresh();
    if (running) { again = true; return; }
    running = true;
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
         (["self","not-reply"].includes(article.dataset.xrcStatus) || article.querySelector(".xrc-labels"))));
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
      if (again) { again = false; schedule(); }
    }
  }

  continuous = globalThis.XReplyContinuous?.create({ accountHandle,tweetId,columnSelector:NOTIFICATION_COLUMN,message,renderLabels });

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.channel !== CHANNEL) return;
    if (event.data.type === "OBSERVER_READY") {
      window.postMessage({ channel:CHANNEL,type:"READY" },location.origin);
      return;
    }
    if (["REPLY_STARTED","REPLY_RESULT"].includes(event.data.type)) {
      const data = event.data;
      const saved = data.type === "REPLY_RESULT" && data.status === "sent" &&
        data.account === accountHandle() && data.batch ?
        message({ type:"INGEST",account:data.account,batch:data.batch }) : null;
      if (saved) void saved.then(() => {
        invalidateAnnotations(); homeFilter.invalidate(); notificationFilter.invalidate(); schedule();
      },
        error => console.warn("回过了：",error.message));
      void continuous?.receiveReply(data,saved);
      return;
    }
    if (event.data.type !== "OBSERVED") return;
    if (pending.length < 10) pending.push(event.data.batch);
    schedule();
  });
  chrome.runtime.onMessage.addListener((request,_sender,respond) => {
    if (request?.type === "GET_ACCOUNT") respond({ account:accountHandle() });
  });
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area !== "local") return;
    if (changes.replyContext) {
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
      schedule();
    }
    if (changes.autoHideFollowNotifications) {
      autoHideFollowNotifications = changes.autoHideFollowNotifications.newValue !== false;
      followSettingLoaded = true;
      schedule();
    }
  });
  void chrome.storage.local.get(["hideCompletedHome","hideCompletedNotifications","autoOrganizeNotifications","autoHideLikeNotifications","autoHideFollowNotifications"]).then(saved => {
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
    homeFilter.invalidate(); notificationFilter.invalidate(); schedule();
  },error => console.warn("回过了：",error.message));
  const observer = new MutationObserver(records => {
    if (records.some(record => !record.target.closest?.(".xrc-labels,.xrc-continuous,.xrc-flow-notice,.xrc-notification-controls"))) {
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
