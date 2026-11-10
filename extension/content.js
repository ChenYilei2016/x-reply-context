(() => {
  "use strict";
  const CHANNEL = "x-reply-context-v1";
  const postVideo = globalThis.XReplyPostVideo;
  const aiContext = globalThis.XReplyAIContext?.create();
  let observedPostVideo;
  const NOTIFICATION_COLUMN = '[data-testid="primaryColumn"]:has(a[role="tab"][href^="/notifications"])';
  const PEOPLE_LIST_PATH = /^\/[a-z0-9_]{1,15}\/(?:following|followers|verified_followers)\/?$/i;
  const PROFILE_LINK = /^(?:https:\/\/(?:x|twitter)\.com)?\/([a-z0-9_]{1,15})\/?$/i;
  const PEOPLE_NAMES = '[data-testid="UserCell"] a[href] [dir="ltr"]';
  const TWEET_NAMES = 'article[data-testid="tweet"] [data-testid="User-Name"]:not([role="link"]:not(a) *,[role="dialog"] *) a[href] [dir="ltr"]';
  const userCounts = new Map();
  const userCountHandles = new Map();
  let exactCount, compactCount;
  let inlineNames = "";
  let inlineAuthorTools = new Map();
  const inlinePersonStats = new Map();
  const authorShortcuts = new WeakMap();
  let followMenuRequest = 0;
  let authorActionNotice, authorActionNoticeTimer;
  let timer;
  let running = false;
  let again = false;
  let urgentRefresh = false;
  let lastAccount = "";
  let lastSignature = "";
  let annotationRevision = 0;
  const pending = new Map();
  let flushing;
  let uiFrame;
  let lastRevision = "";
  const classifications = new Map();
  const classificationAccounts = new Map();
  let continuous;
  let aiReplies;
  let refreshCycle;
  let timedReplies;
  let awakeTimer, awakeUntil=0;
  let interactionAlert;
  let randomSkipReplyLike = false;
  let randomSkipLikeSettingLoaded = false;
  let hideCompletedHome = false;
  let homeSettingLoaded = false;
  let notificationHideMode = "off";
  let hasNotificationMode = false;
  let notificationSettingLoaded = false;
  let autoOrganizeNotifications = false;
  let automaticSettingLoaded = false;
  let autoHideLikeNotifications = true;
  let likeSettingLoaded = false;
  let autoHideFollowNotifications = true;
  let followSettingLoaded = false;
  let autoHideRepostNotifications = false;
  let repostSettingLoaded = false;
  let networkStatus;
  let networkNotice;
  let disconnected = false;
  const skipAuthors = globalThis.XReplySkipAuthors?.createClient(chrome.storage,skippedChanged => {
    if (skippedChanged) schedule(0);
    else {
      refreshInlineWhitelist();
      scheduleControls();
    }
  });
  const homeFilter = globalThis.XReplyHomeFilter.create({
    accountHandle,tweetId,message,holdLayout,enabled:() => hideCompletedHome
  });

  function disconnectRuntime() {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(timer); timer = undefined; pending.clear(); again = false;
    observer.disconnect();
    continuous?.stop(); aiReplies?.stop(); refreshCycle?.cancel();timedReplies?.stop("扩展连接已失效");
    clearAuthorActionNotice();
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
    pausedPage:pausedNotificationPage,continuePage:continueNotificationPage,
    enabled:() => notificationHideMode !== "off",mode:() => notificationHideMode,ready:() => notificationSettingLoaded,
    autoEnabled:() => autoOrganizeNotifications,autoReady:() => automaticSettingLoaded,
    saveAuto:async value => {
      await chrome.storage.local.set({ autoOrganizeNotifications:value });
      autoOrganizeNotifications = value;
    },
    save:async value => {
      await chrome.storage.local.set({ notificationHideMode:value });
      notificationHideMode = value; hasNotificationMode = true;
      notificationFilter.invalidate(); schedule();
    }
  });

  function publishNetworkSettings() {
    if (!likeSettingLoaded || !followSettingLoaded || !repostSettingLoaded) return;
    window.postMessage({ channel:CHANNEL,type:"NOTIFICATION_FILTER_SETTINGS",
      likes:autoHideLikeNotifications,follows:autoHideFollowNotifications,reposts:autoHideRepostNotifications },location.origin);
  }

  function pausedNotificationPage() {
    if (!networkStatus?.paused || !/^\/notifications(?:\/|$)/.test(location.pathname)) return null;
    const timeline = location.pathname.includes("mentions") ? "mentions" :
      location.pathname.includes("verified") ? "verified" : "all";
    const account = accountHandle();
    return account && networkStatus.account === account &&
      networkStatus.key?.toLowerCase() === `${account}:${timeline}` ? networkStatus : null;
  }

  function continueNotificationPage() {
    const page = pausedNotificationPage();
    if (!page || page.loading || document.hidden || holdLayout() || !connected()) return;
    window.postMessage({ channel:CHANNEL,type:"NOTIFICATION_FILTER_CONTINUE",key:page.key },location.origin);
    if (networkNotice) networkNotice.hidden = true;
    window.dispatchEvent(new Event("scroll"));
  }

  function renderNetworkNotice() {
    const page = pausedNotificationPage();
    const summary = notificationFilter.hiddenSummary();
    const allHidden = summary.total > 0 && summary.hidden === summary.total;
    const show = /^\/notifications(?:\/|$)/.test(location.pathname) && !holdLayout() && (page || allHidden);
    if (!show) { if (networkNotice) networkNotice.hidden = true; return; }
    if (!networkNotice) {
      networkNotice = document.createElement("div");
      networkNotice.className = "xrc-network-notice";
      networkNotice.setAttribute("role","status");
      const text = document.createElement("span");
      const next = document.createElement("button"); next.type = "button"; next.className = "xrc-network-continue";
      next.addEventListener("click",continueNotificationPage);
      const restore = document.createElement("button"); restore.type = "button"; restore.className = "xrc-empty-restore";
      restore.textContent = "显示本批";
      restore.title = "恢复当前加载且被隐藏的帖子，保留筛选条件；不主动请求，也不自动再次整理。";
      restore.addEventListener("click",() => {
        if (holdLayout()) return;
        notificationFilter.restoreHidden(); renderNetworkNotice();
      });
      networkNotice.append(text,next,restore); document.body.append(networkNotice);
    }
    networkNotice.querySelector("span").textContent = allHidden ?
      `本批 ${summary.hidden} 条帖子均已隐藏${page ? "，可点「整理列表」继续翻页" : "，可显示本批继续查看"}` :
      page?.empty ? "本批没有可显示通知，可点「整理列表」继续" : "本批已加载，可点「整理列表」继续";
    const next = networkNotice.querySelector(".xrc-network-continue");
    next.hidden = !page;
    next.disabled = page?.loading === true;
    next.textContent = next.disabled ? "加载中" : "继续加载";
    const restore = networkNotice.querySelector(".xrc-empty-restore");
    restore.hidden = !allHidden;
    restore.disabled = notificationFilter.applying();
    networkNotice.hidden = false;
  }

  function accountHandle() {
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const account = profile?.getAttribute("href")?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase() || "";
    return account;
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
    lastSignature = ""; annotationRevision++; classifications.clear(); classificationAccounts.clear();
    continuous?.invalidateContext();
  }

  async function sendMessage(payload) {
    if (!connected()) throw new Error("扩展连接已失效，请刷新页面");
    try {
      const reply = await chrome.runtime.sendMessage(payload);
      if (!connected()) throw new Error("扩展连接已失效，请刷新页面");
      if (payload.type === "AI_REQUEST" && (reply?.cancelled || reply?.contextUsed ||
          reply?.code === "EMPTY_AI_OUTPUT" || reply?.code === "AI_OUTPUT_TOO_LONG")) return reply;
      if (!reply?.ok) throw new Error(reply?.error || "扩展连接已断开，请刷新页面");
      return reply;
    } catch (error) {
      if (/Extension context invalidated/i.test(error.message) || !chrome.runtime?.id) disconnectRuntime();
      throw error;
    }
  }

  async function message(payload) {
    if (payload.type !== "CLASSIFY") return sendMessage(payload);
    const revision = annotationRevision;
    const keyFor = id => `${payload.account}:${payload.includeRootText === true}:${payload.authorHint || ""}:${id}`;
    const rowsById = new Map();
    const missing = [];
    for (const id of payload.ids) {
      const cached = classifications.get(keyFor(id));
      if (cached) rowsById.set(id,cached);
      else missing.push(id);
    }
    if (!missing.length) {
      return {ok:true,...classificationAccounts.get(payload.account),rows:payload.ids.map(id => rowsById.get(id))};
    }
    const reply = await sendMessage({ ...payload,ids:missing });
    // A storage update can invalidate the cached half of a mixed batch. Read the whole batch once.
    if (revision !== annotationRevision && missing.length < payload.ids.length) return sendMessage(payload);
    if (revision !== annotationRevision) return reply;
    const {account,accountId,recognized} = reply;
    classificationAccounts.set(payload.account,{account,accountId,recognized});
    for (const row of reply.rows) {
      rowsById.set(row.id,row);
      classifications.set(keyFor(row.id),row);
    }
    // Only mounted/recent cards need a UI cache; this does not remove stored evidence.
    while (classifications.size > 1000) classifications.delete(classifications.keys().next().value);
    return { ...reply,rows:payload.ids.map(id => rowsById.get(id)).filter(Boolean) };
  }

  function applyRevision(revision) {
    if (revision && revision === lastRevision) return;
    lastRevision = revision || "";
    invalidateAnnotations(); homeFilter.invalidate(); notificationFilter.invalidate();
  }

  function keepAwake(until,leaving=false) {
    clearTimeout(awakeTimer);
    if (leaving) {awakeUntil=0;return;}
    const remaining=until-Date.now();
    if (remaining<=0) until=0;
    if (until===0 && awakeUntil===0) return;
    awakeUntil=until;
    void message({type:"TIMED_KEEP_AWAKE",until}).catch(()=>{});
    if (until) awakeTimer=setTimeout(()=>keepAwake(until),Math.min(8000,remaining));
  }

  function enqueueObserved(batch) {
    const account = accountHandle();
    let group = pending.get(account);
    if (!group) pending.set(account,group = { users:new Map(),tweets:new Map(),likes:new Map() });
    for (const name of ["users","tweets","likes"]) {
      for (const record of (Array.isArray(batch?.[name]) ? batch[name] : []).slice(0,500)) {
        if (!record?.id) continue;
        if (name === "tweets" && (!record.aiAccount || record.aiAccount === account)) aiContext?.observe(record.aiAccount || "",record);
        const key = name === "likes" ? `${record.account}:${record.id}` : record.id;
        const previous = group[name].get(key);
        if (name === "likes" && previous && (previous.observedAt > record.observedAt ||
            previous.observedAt === record.observedAt && previous.source === "mutation" && record.source !== "mutation")) continue;
        // Partial timeline records must not erase fields learned by an earlier response.
        const merged = { ...previous };
        for (const [field,value] of Object.entries(record)) if (field !== "aiPhoto" && field !== "aiAccount" && value !== "") merged[field] = value;
        group[name].set(key,merged);
      }
    }
    void flushObserved();
  }

  async function flushObserved() {
    if (flushing || !connected()) return flushing;
    flushing = (async () => {
      while (pending.size && connected()) {
        const [account,group] = pending.entries().next().value;
        const batch = {};
        for (const name of ["users","tweets","likes"]) {
          batch[name] = [];
          for (const record of group[name].values()) { batch[name].push(record); if (batch[name].length === 500) break; }
        }
        try {
          const result = await message({ type:"INGEST",account,batch });
          for (const name of ["users","tweets","likes"]) for (const record of batch[name]) {
            const key = name === "likes" ? `${record.account}:${record.id}` : record.id;
            if (group[name].get(key) === record) group[name].delete(key);
          }
          if (Object.values(group).every(records => !records.size)) pending.delete(account);
          if (result.changed !== false) { applyRevision(result.revision); if (!document.hidden) schedule(0); }
        } catch (error) {
          console.warn("回过了：",error.message);
          break; // Retain the batch for the next observed event; no retry/request loop.
        }
      }
    })();
    try { await flushing; } finally { flushing = undefined; }
  }

  function scheduleControls() {
    if (uiFrame || document.hidden) return;
    uiFrame = requestAnimationFrame(() => {
      uiFrame = undefined;
      if (connected()) {
        homeFilter.syncKnown(); notificationFilter.syncKnown();
        continuous?.refresh(); aiReplies?.refresh();timedReplies?.refresh();
      }
    });
  }

  function persistInteraction(payload) {
    const saved = message({ ...payload,interaction:true });
    void saved.then(result => {
      if (result.changed !== false) { applyRevision(result.revision); if (!document.hidden) schedule(0); }
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

  function receiveUserCounts(users) {
    if (!Array.isArray(users)) return;
    let changed = false;
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    for (const user of users.slice(0,500)) {
      const id = user?.id;
      const handle = user?.handle;
      if (typeof id !== "string" || !/^\d{1,25}$/.test(id) ||
          typeof handle !== "string" || !/^[a-z0-9_]{1,15}$/.test(handle)) continue;
      const previous = userCounts.get(id);
      const following = count(user.following) ?? previous?.following;
      const followers = count(user.followers) ?? previous?.followers;
      if (following === undefined && followers === undefined) continue;
      if (previous?.handle === handle && previous.following === following && previous.followers === followers) continue;
      exactCount ??= new Intl.NumberFormat("zh-CN");
      compactCount ??= new Intl.NumberFormat("zh-CN",{ notation:"compact",maximumFractionDigits:1 });
      const counts = [
        { label:"关注",shortLabel:"关",value:following },
        { label:"粉丝",shortLabel:"粉",value:followers }
      ].filter(({value}) => value !== undefined);
      const title = counts.map(({label,value}) => `${label} ${exactCount.format(value)}`).join(" · ");
      const text = counts.map(({shortLabel,value}) => `${shortLabel} ${(value < 10000 ? exactCount : compactCount).format(value)}`).join(" · ");
      userCounts.delete(id);
      userCounts.set(id,{ handle,following,followers,text,title });
      if (userCounts.size > 1000) userCounts.delete(userCounts.keys().next().value);
      changed = true;
    }
    if (changed) {
      userCountHandles.clear();
      for (const [id,{handle}] of userCounts) {
        userCountHandles.set(handle,userCountHandles.has(handle) ? "" : id);
      }
      lastSignature = "";
      if (!document.hidden) schedule();
    }
  }

  function countsFor(handle,authorId) {
    return userCounts.get(authorId || userCountHandles.get(handle));
  }

  function renderUserCounts(host,handle,authorId) {
    if (!host) return;
    const counts = countsFor(handle,authorId);
    const existing = host.querySelector(":scope > .xrc-user-counts");
    if (!counts) { existing?.remove(); return; }
    if (existing?.title === counts.title) return;
    const badge = existing || document.createElement("span");
    badge.className = "xrc-user-counts";
    badge.textContent = counts.text;
    badge.title = counts.title;
    if (!existing) host.append(badge);
  }

  const profileHandle = anchor => anchor?.getAttribute("href")?.match(PROFILE_LINK)?.[1]?.toLowerCase() || "";

  function nativePostMenu(article) {
    return [...(article?.querySelectorAll('[data-testid="caret"]:is(button,[role="button"])') || [])].find(button => {
      const quote = button.closest('[role="link"]:not(a)');
      return button.closest('article[data-testid="tweet"]') === article && (!quote || !article.contains(quote));
    });
  }

  function renderFollowShortcut(host,target) {
    const {article,author,account,postId} = target;
    const existing = host.querySelector(":scope > .xrc-follow-author");
    if (!article || !account || !author || author === account || !postId) {
      existing?.remove();
      return;
    }
    const button = existing || document.createElement("button");
    if (!existing) {
      button.type = "button";
      button.className = "xrc-follow-author";
      button.textContent = "关注菜单 ▾";
      button.setAttribute("aria-haspopup","menu");
      host.append(button);
    }
    const label = `打开 @${author} 的 X 关注菜单`;
    if (button.title !== label) {
      button.title = label;
      button.setAttribute("aria-label",label);
    }
    authorShortcuts.set(button,target);
  }

  function authorOverlayPosition(anchor,{width,height}) {
    const {clientWidth,clientHeight} = document.documentElement;
    const left = Math.max(8,Math.min(anchor.right-width,clientWidth-width-8));
    const below = anchor.bottom+4;
    const top = below+height <= clientHeight-8 ? below : Math.max(8,anchor.top-height-4);
    return {left,top};
  }

  function positionFollowMenu(popup,button) {
    const style = getComputedStyle(popup);
    if (style.position !== "absolute" || style.translate !== "none") return;
    const menu = popup.getBoundingClientRect();
    const {left,top} = authorOverlayPosition(button.getBoundingClientRect(),menu);
    // X removes this popup on close. Translate only the popup, leaving the list and native caret in place.
    popup.style.translate = `${left-menu.left}px ${top-menu.top}px`;
  }

  function clearAuthorActionNotice() {
    if (!authorActionNotice) return;
    clearTimeout(authorActionNoticeTimer);
    authorActionNotice.remove();
    authorActionNotice = undefined;
    window.removeEventListener("scroll",clearAuthorActionNotice,true);
  }

  function showAuthorActionNotice(button,text) {
    if (!button.isConnected) return;
    clearAuthorActionNotice();
    const notice = document.createElement("div");
    notice.className = "xrc-author-action-notice";
    notice.setAttribute("role","status");
    notice.textContent = text;
    document.body.append(notice);
    const {left,top} = authorOverlayPosition(button.getBoundingClientRect(),notice.getBoundingClientRect());
    notice.style.left = `${left}px`;
    notice.style.top = `${top}px`;
    authorActionNotice = notice;
    authorActionNoticeTimer = setTimeout(clearAuthorActionNotice,4000);
    window.addEventListener("scroll",clearAuthorActionNotice,{capture:true,passive:true});
  }

  function matchesPostShortcut(button,{article,author,postId}) {
    return button.isConnected && button.closest('article[data-testid="tweet"]') === article &&
      globalThis.XReplyContinuous?.authorFromPostLink?.(article,postId) === author;
  }

  function openFollowMenu(button,target) {
    const request = ++followMenuRequest;
    const {article,author,account} = target;
    clearAuthorActionNotice();
    const valid = () => accountHandle() === account && matchesPostShortcut(button,target);
    if (!valid()) {
      schedule(0);
      showAuthorActionNotice(button,"帖子已更新，请重新打开关注菜单。");
      return;
    }
    const caret = nativePostMenu(article);
    if (!caret || caret.disabled || caret.getAttribute("aria-disabled") === "true") {
      showAuthorActionNotice(button,"本帖暂没有可用的 X 菜单。");
      return;
    }
    const current = () => request === followMenuRequest && !disconnected && !document.hidden && valid();
    const reveal = waitForPopup => {
      if (!current()) return;
      const expanded = caret.isConnected && caret.getAttribute("aria-expanded") === "true";
      const items = expanded ? [...document.querySelectorAll('#layers [role="menu"] [role="menuitem"]')].filter(item => {
        const label = item.textContent.trim().replace(/\s+/g," ");
        const match = label.match(/^(?:(?:un)?follow|(?:取消)?(?:关注|關注|追蹤)|取关)\s*@([a-z0-9_]{1,15})$/i);
        return match?.[1].toLowerCase() === author && item.getClientRects().length &&
          getComputedStyle(item).visibility !== "hidden";
      }) : [];
      if (items.length !== 1) {
        if (waitForPopup) setTimeout(() => reveal(false),350);
        else showAuthorActionNotice(button,expanded ? `未在 X 菜单里定位到 @${author} 的关注选项。` :
          "X 菜单未打开，可试试本帖右上角的「更多」。");
        return;
      }
      const [item] = items;
      positionFollowMenu(item.closest('[role="menu"]'),button);
      // Let X finish setting its own default focus first.
      requestAnimationFrame(() => { if (item.isConnected && current()) item.focus({preventScroll:true}); });
    };
    if (caret.getAttribute("aria-expanded") !== "true") caret.click();
    requestAnimationFrame(() => reveal(true));
  }

  function isSkipAuthorLink(anchor,handle) {
    if (PEOPLE_LIST_PATH.test(location.pathname)) return Boolean(anchor?.closest('[data-testid="UserCell"]'));
    const article = anchor?.closest('article[data-testid="tweet"]');
    return Boolean(article && !article.closest('[role="dialog"]') && globalThis.XReplyContinuous?.authorFromPostLink?.(article) === handle);
  }

  function renderSkipAuthor(tools,target,skipped) {
    const {author} = target;
    let button = tools.querySelector(":scope > .xrc-skip-author");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "xrc-skip-author";
      button.textContent = "⊘";
      tools.prepend(button);
    }
    const label = `自动下一条时跳过 @${author}`;
    if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label",label);
    if (button.getAttribute("aria-pressed") !== String(skipped)) button.setAttribute("aria-pressed",String(skipped));
    const title = skipped ? `已跳过 @${author}。点击恢复。` : `${label}。`;
    if (button.title !== title) button.title = title;
    authorShortcuts.set(button,target);
  }

  function paintWhitelistAuthor(button,{accountId,peerId,author}) {
    const whitelist = skipAuthors.whitelist(accountId);
    const ready = Boolean(accountId && peerId && whitelist);
    const included = ready && whitelist.has(peerId);
    const symbol = included ? "★" : "☆";
    if (button.textContent !== symbol) button.textContent = symbol;
    const label = `@${author} 的白名单标记`;
    if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label",label);
    if (button.getAttribute("aria-pressed") !== String(included)) button.setAttribute("aria-pressed",String(included));
    const title = ready ? `${included ? "移出白名单" : "加入白名单"} @${author}` : "等待本机确认当前账号和帖子作者";
    if (button.title !== title) button.title = title;
    const disabled = !ready || button.getAttribute("aria-busy") === "true";
    if (button.disabled !== disabled) button.disabled = disabled;
  }

  function renderWhitelistAuthor(tools,target,visible,cached) {
    let button = tools.querySelector(":scope > .xrc-whitelist-author");
    if (!visible) { button?.remove(); return; }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "xrc-whitelist-author";
      tools.querySelector(":scope > .xrc-skip-author").after(button);
    }
    const action = {...target,accountId:cached?.accountId,peerId:cached?.postAuthorConfirmed ? cached.authorId : ""};
    authorShortcuts.set(button,action);
    paintWhitelistAuthor(button,action);
  }

  function refreshInlineWhitelist() {
    if (document.hidden || !inlineAuthorTools.size) return;
    const column = globalThis.XReplyHomeFilter.column?.();
    if (!column) return;
    const account = accountHandle();
    for (const [tools,{article}] of inlineAuthorTools) {
      if (!tools.isConnected || !column.contains(article)) continue;
      const button = tools.querySelector(":scope > .xrc-whitelist-author");
      const target = authorShortcuts.get(button);
      if (target?.account === account) paintWhitelistAuthor(button,target);
    }
  }

  function renderAuthorTools(target,skipped,body) {
    const {anchor,account,author} = target;
    let tools = body ? body.previousElementSibling : anchor.nextElementSibling;
    if (!tools?.matches(".xrc-inline-author")) {
      tools = document.createElement("span");
      tools.className = "xrc-inline-author";
      if (body) body.before(tools);
      else anchor.after(tools);
    }
    tools.classList.toggle("xrc-inline-author-row",Boolean(body));
    if (tools.dataset.account !== account) tools.dataset.account = account;
    if (tools.dataset.author !== author) tools.dataset.author = author;
    renderSkipAuthor(tools,target,skipped);
    return tools;
  }

  function renderInlinePersonStats(tools,stats) {
    let badge = tools.querySelector(".xrc-inline-person-stats");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "xrc-inline-person-stats";
      tools.append(badge);
    }
    const myCount = displayPersonCount(stats?.myCommentedPosts,"—");
    const theirCount = displayPersonCount(stats?.theirCommentedPosts,"—");
    const text = `我评他 ${myCount} · 他评我 ${theirCount}`;
    if (badge.textContent !== text) badge.textContent = text;
    const hint = stats?.incomplete ? "历史不完整，数字是本地已知下限。" : "";
    const title = `双方各评论过对方的几篇原帖，同帖只计一次。— 表示本机暂无可确认记录。${hint}`;
    if (badge.title !== title) badge.title = title;
  }

  function renderInlinePeople(account) {
    const recommended = globalThis.XReplyHomeFilter.column?.();
    const peopleList = PEOPLE_LIST_PATH.test(location.pathname);
    const countsNames = recommended ? TWEET_NAMES : peopleList ? PEOPLE_NAMES :
      /^\/compose(?:\/|$)/.test(location.pathname) ? inlineNames : "";
    if (inlineNames && inlineNames !== countsNames) {
      document.querySelectorAll(`${inlineNames} > .xrc-user-counts`).forEach(node => node.remove());
    }
    inlineNames = countsNames;
    const showCounts = Boolean(countsNames && userCounts.size);
    const showSkip = Boolean(account && skipAuthors?.revision());
    const visibleTools = new Map(), targets = new Map();
    const column = recommended || document.querySelector('[data-testid="primaryColumn"]');
    if ((showCounts || showSkip) && !column?.matches(NOTIFICATION_COLUMN)) {
      const names = peopleList ? PEOPLE_NAMES : TWEET_NAMES;
      const showStats = !peopleList;
      const skipped = skipAuthors?.authors(account);
      for (const name of column?.querySelectorAll(names) || []) {
        const anchor = name.closest("a");
        const handle = profileHandle(anchor);
        const username = name.firstChild?.textContent?.trim().toLowerCase();
        if (!handle || username !== `@${handle}`) {
          if (showCounts) name.querySelector(":scope > .xrc-user-counts")?.remove();
          continue;
        }
        const withTools = showSkip && handle !== account && isSkipAuthorLink(anchor,handle);
        if (showCounts) renderUserCounts(name,withTools && showStats ? "" : handle);
        if (withTools) {
          const article = showStats ? anchor.closest('article[data-testid="tweet"]') : null;
          const postId = article ? tweetId(article) : "";
          const body = article && article.querySelector('[data-testid="tweetText"]:not([role="link"] *)');
          const target = {anchor,article,account,author:handle,postId};
          const tools = renderAuthorTools(target,skipped.has(handle),body);
          visibleTools.set(tools,target);
          const cached = inlinePersonStats.get(postId);
          renderWhitelistAuthor(tools,target,Boolean(recommended),cached);
          if (showStats) {
            if (postId) targets.set(postId,{postId,authorHandle:handle});
            renderInlinePersonStats(tools,cached?.stats);
          } else tools.querySelector(".xrc-inline-person-stats")?.remove();
          renderUserCounts(tools,showStats ? handle : "",cached?.authorId);
          renderFollowShortcut(tools,target);
        }
      }
    }
    for (const tools of inlineAuthorTools.keys()) if (!visibleTools.has(tools)) tools.remove();
    inlineAuthorTools = visibleTools;
    return targets;
  }

  async function loadInlinePersonStats(account,targets) {
    const revision = annotationRevision;
    const missing = [...targets.values()].filter(({postId}) => inlinePersonStats.get(postId)?.revision !== revision);
    if (!missing.length) return;
    try {
      for (let offset = 0; offset < missing.length; offset += 100) {
        const batch = missing.slice(offset,offset+100);
        const result = await message({ type:"PERSON_STATS",account,authors:batch });
        if (revision !== annotationRevision || accountHandle() !== account) return;
        const rows = new Map(result.rows.map(row => [row.postId,row]));
        for (const {postId} of batch) {
          const row = rows.get(postId);
          inlinePersonStats.set(postId,{revision,accountId:result.accountId,stats:row?.personStats,
            authorId:row?.authorId,postAuthorConfirmed:row?.postAuthorConfirmed});
        }
      }
      const recommended = globalThis.XReplyHomeFilter.column?.();
      for (const [tools,target] of inlineAuthorTools) {
        const {anchor,postId,article} = target;
        if (!targets.has(postId) || !tools.isConnected || !anchor.isConnected || tools.dataset.account !== account ||
            profileHandle(anchor) !== tools.dataset.author) continue;
        if (article && anchor.closest('article[data-testid="tweet"]') === article && tweetId(article) === postId) {
          const cached = inlinePersonStats.get(postId);
          renderInlinePersonStats(tools,cached?.stats);
          renderUserCounts(tools,tools.dataset.author,cached?.authorId);
          renderWhitelistAuthor(tools,target,Boolean(recommended?.contains(article)),cached);
        }
      }
      while (inlinePersonStats.size > 1000) inlinePersonStats.delete(inlinePersonStats.keys().next().value);
    } catch (error) {
      console.warn("回过了：",error.message);
    }
  }

  function renderNotificationAuthorActions(bar,article,account,postId,skipped) {
    const author = globalThis.XReplyContinuous?.authorFromPostLink?.(article,postId);
    let tools = bar.querySelector(":scope > .xrc-notification-author-actions");
    if (!author || author === account) { tools?.remove(); return; }
    if (!tools) {
      tools = document.createElement("span");
      tools.className = "xrc-notification-author-actions";
      bar.append(tools);
    }
    const target = {article,author,account,postId};
    if (skipped) renderSkipAuthor(tools,target,skipped.has(author));
    renderFollowShortcut(tools,target);
  }

  function refreshKnownNotificationActions(articles,ids,account,skipped) {
    for (let index = 0; index < articles.length; index++) {
      const article = articles[index], id = ids[index];
      if (!id) continue;
      const {xrcId,xrcStatus,xrcOrigin} = article.dataset;
      if (xrcId !== id) return false;
      if (xrcStatus === "self" || (xrcStatus === "not-reply" && xrcOrigin === "mine")) continue;
      const bar = article.querySelector(".xrc-labels");
      if (!bar) return false;
      renderNotificationAuthorActions(bar,article,account,id,skipped);
    }
    return true;
  }

  function render(article,result,account,skipped) {
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
    const labels = bar.querySelector(".xrc-main-labels");
    if (userCounts.size) renderUserCounts(labels,result.authorHandle,result.authorId);
    renderNotificationAuthorActions(bar,article,account,result.id,skipped);
  }

  function displayPersonCount(count,fallback) {
    return count > 0 ? count : fallback;
  }

  function personBadges(stats,compact = false) {
    const pendingLabel = compact ? "待定" : "待确认";
    return [
      [compact ? "我评" : "我评他",stats?.myCommentedPosts,"你评论过他的几篇原帖"],
      [compact ? "他评" : "他评我",stats?.theirCommentedPosts,"他评论过你的几篇原帖"]
    ].map(([label,count,description]) => {
      const badge = document.createElement("span");
      badge.className = "xrc-person";
      badge.textContent = `${label} ${displayPersonCount(count,pendingLabel)}`;
      badge.title = `${description}。同一篇下多次评论（含楼中楼）只算 1 篇。统计来自本地记录。${stats?.incomplete ? "历史不完整，显示的数字是本地已知下限。" : ""}`;
      return badge;
    });
  }

  function renderPersonStats(bar,stats,authorHandle,authorId) {
    const counts = countsFor(authorHandle,authorId);
    const signature = JSON.stringify([stats?.myCommentedPosts,stats?.theirCommentedPosts,stats?.incomplete,counts?.title]);
    if (bar.dataset.signature === signature) return;
    bar.dataset.signature = signature;
    bar.replaceChildren(...personBadges(stats));
    if (counts) renderUserCounts(bar,authorHandle,authorId);
  }

  function renderLabels(bar,result,includePersonStats = true) {
    const signature = JSON.stringify(result);
    if (bar.dataset.signature === signature) return;
    bar.dataset.signature = signature;
    bar.dataset.origin = result.origin;
    const origin = document.createElement("span");
    origin.className = "xrc-origin";
    origin.textContent = { mine:"我帖", others:"他帖", unknown:"帖-待定" }[result.origin];
    origin.title = result.rootHandle ?
      `原帖作者 @${result.rootHandle}；按整段对话最初的帖子判断，楼中楼沿用原帖归属。` :
      "尚未读取到原帖作者，暂不判断归属。";
    const labels = [origin];
    const status = result.evidenceId ? link("文-已回",result.evidenceId,result.evidenceText) :
      document.createElement("span");
    status.className = "xrc-status";
    status.dataset.confirmed = String(Boolean(result.evidenceId));
    if (!result.evidenceId) status.textContent = "文-待定";
    status.title = result.evidenceId ?
      `${result.status === "not-reply" ? "你已在这篇原帖下评论过（含楼中楼）" : "你在同一原帖里已经回复过这个人"}。点击查看：${result.evidenceText || "我的回复"}` :
      "当前本地记录还没有确认你回过此人，不代表你从未回复。";
    const heart = result.likeEvidenceId ? link("红-已点",result.likeEvidenceId) : document.createElement("span");
    heart.className = "xrc-heart";
    heart.dataset.confirmed = String(Boolean(result.likeEvidenceId));
    if (!result.likeEvidenceId) heart.textContent = "红-待定";
    heart.title = result.likeEvidenceId ?
      (result.likeEvidenceId === result.id ?
        "已给这条帖子点过红心。点击查看；若是旧记录，状态以 X 当前显示为准。" :
        "已给这个人在同一原帖中的另一条帖子点过红心。点击查看依据；若是旧记录，状态以 X 当前显示为准。") :
      "当前记录没有确认你给这个人在同一原帖中点过红心，不代表从未点赞。";
    labels.push(status,heart);
    if (includePersonStats && result.personStats) labels.push(...personBadges(result.personStats,true));
    labels.push(result.rootId ? link("原帖",result.rootId) : link("上下文",result.id));
    let main = bar.querySelector(":scope > .xrc-main-labels");
    if (!main) {
      main = document.createElement("div");
      main.className = "xrc-main-labels";
      bar.prepend(main);
    }
    // Keep notification actions and their focus across updates to the statistics.
    main.replaceChildren(...labels);
    const newPerson = bar.querySelector(":scope > .xrc-new-person");
    if (!result.newPerson) newPerson?.remove();
    else if (!newPerson) {
      const badge = document.createElement("strong");
      badge.className = "xrc-new-person";
      badge.textContent = "NEW";
      badge.title = "这条是本地记录中他首次评论你的原帖，且你评论过他的原帖数为 0。";
      main.after(badge);
    }
  }

  async function refresh() {
    if (!connected() || document.hidden) return;
    continuous?.refresh(); aiReplies?.refresh();timedReplies?.refresh();
    renderNetworkNotice();
    window.postMessage({ channel:CHANNEL,type:"NOTIFICATION_FILTER_CONTEXT" },location.origin);
    if (running) { again = true; return; }
    running = true;
    urgentRefresh = false;
    try {
      const account = accountHandle();
      if (account && account !== lastAccount) {
        // The composer owns its labels; initial account detection must not erase an already-open footer.
        document.querySelectorAll('article[data-testid="tweet"] .xrc-labels').forEach(node => node.remove());
        lastAccount = account;
        inlinePersonStats.clear();
        invalidateAnnotations();
        // The first composer read may predate account detection; don't wait for another DOM event.
        scheduleControls();
        homeFilter.reset();
        notificationFilter.reset();
      }
      const targets = userCounts.size || inlineNames || skipAuthors?.revision() || inlineAuthorTools.size ? renderInlinePeople(account) : null;
      if (!account) { homeFilter.reset(); notificationFilter.reset(); return; }
      const statsReady = targets?.size ? loadInlinePersonStats(account,targets) : null;
      await homeFilter.refresh();
      await notificationFilter.refresh();
      if (statsReady) await statsReady;
      renderNetworkNotice();
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
      const skipped = skipAuthors?.revision() ? skipAuthors.authors(account) : undefined;
      if (signature === lastSignature && refreshKnownNotificationActions(articles,ids,account,skipped)) return;
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
        if (article.isConnected && row) render(article,row,account,skipped);
      }
      lastSignature = signature;
    } catch (error) {
      console.warn("回过了：",error.message);
    } finally {
      running = false;
      if (again) { again = false; schedule(urgentRefresh ? 0 : 250); }
    }
  }

  interactionAlert = globalThis.XReplyInteractionAlert?.create({accountHandle,
    onPause:()=>{timedReplies?.stop("收到异常提醒，已停止");aiReplies?.pause();continuous?.pauseForAlert();refreshCycle?.cancel();},
    onRelease:()=>continuous?.stop()});
  aiReplies = globalThis.XReplyAIReplies?.create({accountHandle,connected,message,tweetId,requestRefresh:scheduleControls,interactionBlocked:()=>interactionAlert?.blocked()===true,
    readContext:(account,postId,includeImage,readTargetPhoto)=>aiContext?.read(account,postId,includeImage,readTargetPhoto) || { postId },
    replyPostId:editor=>continuous?.replyPostId(editor),
    replyArticle:editor=>continuous?.replyArticle(editor),
    rootOwnership:editor=>continuous?.rootOwnership(editor) || "unknown",
    recommendedReply:editor=>continuous?.recommendedReply(editor),
    canAutoFillUnfocused:editor=>continuous?.canAutoFillUnfocused(editor)===true,
    skipVideo:editor=>continuous?.skipVideo(editor)===true,
    onAutoFillBlocked:(editor,reason,recoverable)=>{
      if (!continuous?.recommendedReply(editor)) return;
      if (recoverable) timedReplies?.pause(`${reason} 可手动填写，或点击「继续本轮」再试。`);
      else timedReplies?.stop(reason);
    }});
  refreshCycle = globalThis.XReplyRefreshCycle?.create({storage:chrome.storage,message,accountHandle,requestRefresh:scheduleControls,getTimed:()=>timedReplies,
    resume:(intent,valid)=>continuous.resumeRecommended(intent,valid),notify:text=>continuous?.notify(text)});
  timedReplies = globalThis.XReplyTimedReplies?.create({storage:chrome.storage,readState:()=>continuous?.timedState(),
    trigger:state=>continuous?.timedSend(state),requestRefresh:scheduleControls,keepAwake,
    onContinue:state=>aiReplies?.resumeAutomatic(state.editor)||"",
    onInterrupt:reason=>{aiReplies?.pause();continuous?.cancelTimedFollowup(reason);},cancelRefresh:id=>refreshCycle?.cancel(id)});
  continuous = globalThis.XReplyContinuous?.create({refreshCycle,timedReplies,skipAuthors,randomSkipLikeEnabled:()=>randomSkipReplyLike,interactionBlocked:()=>interactionAlert?.blocked()===true, accountHandle,tweetId,columnSelector:NOTIFICATION_COLUMN,message,renderLabels:(bar,row) => renderLabels(bar,row,false),renderPersonStats,requestRefresh:scheduleControls,connected,aiBusy:editor => aiReplies?.busy(editor) === true,aiRecommend:editor => aiReplies?.recommend(editor),aiPhase:editor => aiReplies?.phase(editor) || "",
    renderAiOptions:(tools,editor) => aiReplies?.renderOptions(tools,editor),
    aiFillRecommendedEnabled:()=>aiReplies?.fillRecommendedEnabled() === true});

  async function toggleWhitelistAuthor(button,target) {
    const {account,accountId,peerId,postId,article} = target;
    const whitelist = skipAuthors.whitelist(accountId);
    if (!accountId || !peerId || !whitelist || accountHandle() !== account ||
        !globalThis.XReplyHomeFilter.column?.()?.contains(article) || !matchesPostShortcut(button,target)) {
      schedule(0);
      return;
    }
    clearAuthorActionNotice();
    button.setAttribute("aria-busy","true");
    button.disabled = true;
    try {
      await message({type:"SET_REPLY_WHITELIST_AUTHOR",account,accountId,peerId,postId,whitelisted:!whitelist.has(peerId)});
    } catch (error) {
      showAuthorActionNotice(button,error.message);
    } finally {
      button.removeAttribute("aria-busy");
      paintWhitelistAuthor(button,authorShortcuts.get(button));
    }
  }

  document.addEventListener("click",async event => {
    const button = event.target?.closest?.(".xrc-follow-author,.xrc-skip-author,.xrc-whitelist-author");
    const target = authorShortcuts.get(button);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled || !connected()) return;
    if (button.classList.contains("xrc-follow-author")) {
      if (event.isTrusted) openFollowMenu(button,target);
      return;
    }
    if (button.classList.contains("xrc-whitelist-author")) {
      if (event.isTrusted) await toggleWhitelistAuthor(button,target);
      return;
    }
    const {anchor,account,author} = target;
    const valid = anchor ? anchor.isConnected && profileHandle(anchor) === author && isSkipAuthorLink(anchor,author) :
      matchesPostShortcut(button,target);
    if (!valid || accountHandle() !== account) {
      schedule(0);
      return;
    }
    clearAuthorActionNotice();
    button.disabled = true;
    try {
      await message({ type:"SET_REPLY_SKIP_AUTHOR",account,author,skipped:!skipAuthors.authors(account).has(author) });
    } catch (error) {
      showAuthorActionNotice(button,error.message);
    } finally {
      button.disabled = false;
    }
  },true);

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.channel !== CHANNEL) return;
    if (!connected()) return;
    if (event.data.type === "OBSERVER_READY") {
      window.postMessage({ channel:CHANNEL,type:"READY" },location.origin);
      publishNetworkSettings();
      return;
    }
    if (event.data.type === "INTERACTION_ALERT") {interactionAlert?.show(event.data);return;}
    if (event.data.type === "USER_COUNTS") { receiveUserCounts(event.data.users); return; }
    if (event.data.type === "POST_VIDEO_MEDIA") {
      const post = postVideo?.parsePostLink(location.href);
      if (post && post.id === event.data.id) {
        const url = postVideo.mp4Url(event.data.url);
        if (url || event.data.url === "") observedPostVideo = { id:post.id,url };
      }
      return;
    }
    if (event.data.type === "NOTIFICATION_FILTER_STATUS") {
      networkStatus = event.data; schedule(); return;
    }
    if (["REPLY_STARTED","REPLY_RESULT"].includes(event.data.type)) {
      const data = event.data;
      const saved = data.type === "REPLY_RESULT" && data.status === "sent" &&
        data.account === accountHandle() && data.batch ?
        persistInteraction({type:"INGEST",account:data.account,batch:data.batch}) : null;
      if (data.type === "REPLY_RESULT" && data.status === "unknown" && data.account === accountHandle() && data.replyEvidence) {
        void persistInteraction({type:"RECORD_REPLY_EVIDENCE",account:data.account,parentId:data.parentId,reply:data.replyEvidence});
      }
      void continuous?.receiveReply(data,saved);
      return;
    }
    if (event.data.type !== "OBSERVED") return;
    if (event.data.interaction === true) {
      if (event.data.account === accountHandle() && event.data.batch) {
        const saved=persistInteraction({type:"INGEST",account:event.data.account,batch:event.data.batch});
        void continuous?.receiveLike?.(event.data,saved);
      }
      return;
    }
    enqueueObserved(event.data.batch);
    if (!document.hidden) schedule();
  });
  chrome.runtime.onMessage.addListener((request,sender,respond) => {
    if (request?.type === "GET_POST_VIDEO" && sender.id === chrome.runtime.id) {
      const post = postVideo?.parsePostLink(location.href);
      const seen = Boolean(post && post.id === observedPostVideo?.id && (!request.id || post.id === request.id));
      respond({ postUrl:post?.url,seen,url:seen ? observedPostVideo.url : "" });
      return;
    }
    if(request?.type==="REFRESH_CANCELLED"){refreshCycle?.cancelled(request.refreshId);respond({ok:true});return;}
    if (request?.type === "GET_ACCOUNT") respond({ account:accountHandle() });
  });
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area !== "local" || !connected()) return;
    if (changes.replyContext || changes.replyContextRevision) {
      applyRevision(changes.replyContextRevision?.newValue);
      if (!document.hidden) { scheduleControls(); schedule(); }
    }
    if (changes.randomSkipReplyLike) {
      randomSkipReplyLike=changes.randomSkipReplyLike.newValue===true;
      randomSkipLikeSettingLoaded=true;
    }
    if (changes.hideCompletedHome) {
      hideCompletedHome = changes.hideCompletedHome.newValue === true;
      homeSettingLoaded = true;
      homeFilter.invalidate(); schedule();
    }
    if (changes.notificationHideMode) {
      notificationHideMode = ["completed","replied"].includes(changes.notificationHideMode.newValue) ?
        changes.notificationHideMode.newValue : "off";
      hasNotificationMode = true; notificationSettingLoaded = true;
      notificationFilter.invalidate(); schedule();
    } else if (changes.hideCompletedNotifications && !hasNotificationMode) {
      notificationHideMode = changes.hideCompletedNotifications.newValue === true ? "completed" : "off";
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
    if (changes.autoHideRepostNotifications) {
      autoHideRepostNotifications = changes.autoHideRepostNotifications.newValue === true;
      repostSettingLoaded = true;
      publishNetworkSettings();
      schedule();
    }
  });
  void chrome.storage.local.get(["randomSkipReplyLike","hideCompletedHome","hideCompletedNotifications","notificationHideMode","autoOrganizeNotifications","autoHideLikeNotifications","autoHideFollowNotifications","autoHideRepostNotifications"]).then(saved => {
    if (!connected()) return;
    if (!randomSkipLikeSettingLoaded) randomSkipReplyLike=saved.randomSkipReplyLike===true;
    randomSkipLikeSettingLoaded=true;
    if (!homeSettingLoaded) hideCompletedHome = saved.hideCompletedHome === true;
    homeSettingLoaded = true;
    if (!notificationSettingLoaded) {
      hasNotificationMode = Object.hasOwn(saved,"notificationHideMode") && saved.notificationHideMode !== undefined;
      notificationHideMode = hasNotificationMode ?
        (["completed","replied"].includes(saved.notificationHideMode) ? saved.notificationHideMode : "off") :
        (saved.hideCompletedNotifications === true ? "completed" : "off");
    }
    notificationSettingLoaded = true;
    if (!automaticSettingLoaded) autoOrganizeNotifications = saved.autoOrganizeNotifications === true;
    automaticSettingLoaded = true;
    if (!likeSettingLoaded) autoHideLikeNotifications = saved.autoHideLikeNotifications !== false;
    likeSettingLoaded = true;
    if (!followSettingLoaded) autoHideFollowNotifications = saved.autoHideFollowNotifications !== false;
    followSettingLoaded = true;
    if (!repostSettingLoaded) autoHideRepostNotifications = saved.autoHideRepostNotifications === true;
    repostSettingLoaded = true;
    publishNetworkSettings();
    homeFilter.invalidate(); notificationFilter.invalidate(); schedule();
  },error => console.warn("回过了：",error.message));
  const observer = new MutationObserver(records => {
    if (!connected()) return;
    const owned = ".xrc-labels,.xrc-user-counts,.xrc-inline-author,.xrc-continuous,.xrc-flow-notice,.xrc-notification-controls,.xrc-network-notice,.xrc-ai-ghost,.xrc-ai-notice,.xrc-interaction-alert";
    const relevant = '[data-testid="primaryColumn"],[role="dialog"],[aria-modal="true"],a[data-testid="AppTabBar_Profile_Link"]';
    if (records.some(record => !record.target.closest?.(owned) &&
        (record.target.closest?.(relevant) || [...(record.addedNodes || []),...(record.removedNodes || [])]
          .some(node => node.matches?.(relevant) || node.querySelector?.(relevant))))) {
      scheduleControls(); schedule();
    }
  });
  observer.observe(document,{ childList:true,subtree:true,attributes:true,
    attributeFilter:["aria-selected","data-testid","aria-disabled","disabled","href","datetime"] });
  window.addEventListener("popstate",() => { scheduleControls(); schedule(); });
  document.addEventListener("visibilitychange",() => { if (!document.hidden) { scheduleControls(); schedule(0); } });
  window.postMessage({ channel:CHANNEL,type:"READY" },location.origin);
  schedule();
})();
