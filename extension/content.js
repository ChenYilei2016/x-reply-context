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
  const skipAuthors = globalThis.XReplySkipAuthors?.createClient(chrome.storage,() => schedule(0));
  const homeFilter = globalThis.XReplyHomeFilter.create({
    accountHandle,tweetId,message,holdLayout,enabled:() => hideCompletedHome
  });

  function disconnectRuntime() {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(timer); timer = undefined; pending.clear(); again = false;
    observer.disconnect();
    continuous?.stop(); aiReplies?.stop(); refreshCycle?.cancel();timedReplies?.stop("扩展连接已失效");
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

  function renderNetworkNotice() {
    const timeline = location.pathname.includes("mentions") ? "mentions" :
      location.pathname.includes("verified") ? "verified" : "all";
    const account = accountHandle();
    const paused = networkStatus?.paused && networkStatus.account === account &&
      networkStatus.key?.toLowerCase() === `${account}:${timeline}`;
    const summary = notificationFilter.hiddenSummary();
    const allHidden = summary.total > 0 && summary.hidden === summary.total;
    const show = /^\/notifications(?:\/|$)/.test(location.pathname) && !holdLayout() && (paused || allHidden);
    if (!show) { if (networkNotice) networkNotice.hidden = true; return; }
    if (!networkNotice) {
      networkNotice = document.createElement("div");
      networkNotice.className = "xrc-network-notice";
      networkNotice.setAttribute("role","status");
      const text = document.createElement("span");
      const next = document.createElement("button"); next.type = "button"; next.className = "xrc-network-continue";
      next.addEventListener("click",() => {
        if (holdLayout() || !networkStatus?.paused || networkStatus.account !== accountHandle()) return;
        window.postMessage({ channel:CHANNEL,type:"NOTIFICATION_FILTER_CONTINUE",key:networkStatus.key },location.origin);
        networkNotice.hidden = true;
        window.dispatchEvent(new Event("scroll"));
      });
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
      `本批 ${summary.hidden} 条帖子均已隐藏${paused ? "，分页已暂停" : "，可显示本批继续查看"}` :
      networkStatus.empty ? "本批没有可显示通知，已暂停翻页" : "本批已加载，继续翻页需手动确认";
    const next = networkNotice.querySelector(".xrc-network-continue");
    next.hidden = !paused;
    next.disabled = networkStatus?.loading === true;
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
    lastSignature = ""; annotationRevision++; classifications.clear(); continuous?.invalidateContext();
  }

  async function sendMessage(payload) {
    if (!connected()) throw new Error("扩展连接已失效，请刷新页面");
    try {
      const reply = await chrome.runtime.sendMessage(payload);
      if (!connected()) throw new Error("扩展连接已失效，请刷新页面");
      if (payload.type === "AI_REQUEST" && (reply?.cancelled || reply?.contextUsed)) return reply;
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
    const missing = payload.ids.filter(id => !classifications.has(keyFor(id)));
    if (missing.length) {
      const reply = await sendMessage({ ...payload,ids:missing });
      if (revision !== annotationRevision) return reply;
      for (const row of reply.rows) classifications.set(keyFor(row.id),row);
      const rows = payload.ids.map(id => classifications.get(keyFor(id))).filter(Boolean);
      // Only mounted/recent cards need a UI cache; this does not remove stored evidence.
      while (classifications.size > 1000) classifications.delete(classifications.keys().next().value);
      return { ...reply,rows };
    }
    return { ok:true,rows:payload.ids.map(id => classifications.get(keyFor(id))) };
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

  function persistInteraction(batch,account) {
    const saved = message({ type:"INGEST",account,batch,interaction:true });
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

  function isSkipAuthorLink(anchor,handle) {
    if (PEOPLE_LIST_PATH.test(location.pathname)) return Boolean(anchor?.closest('[data-testid="UserCell"]'));
    const article = anchor?.closest('article[data-testid="tweet"]');
    return Boolean(article && !article.closest('[role="dialog"]') && globalThis.XReplyContinuous?.authorFromPostLink?.(article) === handle);
  }

  function renderAuthorTools(anchor,account,handle,skipped,body) {
    let tools = body ? body.previousElementSibling : anchor.nextElementSibling;
    if (!tools?.matches(".xrc-inline-author")) {
      tools = document.createElement("span");
      tools.className = "xrc-inline-author";
      if (body) body.before(tools);
      else anchor.after(tools);
    }
    tools.classList.toggle("xrc-inline-author-row",Boolean(body));
    let button = tools.querySelector(".xrc-skip-author");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "xrc-skip-author";
      button.textContent = "⊘";
      tools.append(button);
    }
    if (tools.dataset.account !== account) tools.dataset.account = account;
    if (tools.dataset.author !== handle) {
      tools.dataset.author = handle;
      button.setAttribute("aria-label",`自动下一条时跳过 @${handle}`);
    }
    if (button.getAttribute("aria-pressed") !== String(skipped)) button.setAttribute("aria-pressed",String(skipped));
    const title = skipped ? `已跳过 @${handle}。点击恢复。` : `自动下一条时跳过 @${handle}。`;
    if (button.title !== title) button.title = title;
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
    if (showCounts || showSkip) {
      const names = peopleList ? PEOPLE_NAMES : TWEET_NAMES;
      const column = recommended || document.querySelector('[data-testid="primaryColumn"]');
      const showStats = !peopleList && !column?.matches?.(NOTIFICATION_COLUMN);
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
          const tools = renderAuthorTools(anchor,account,handle,skipped.has(handle),body);
          visibleTools.set(tools,{anchor,postId});
          const cached = inlinePersonStats.get(postId);
          if (showStats) {
            if (postId) targets.set(postId,{postId,authorHandle:handle});
            renderInlinePersonStats(tools,cached?.stats);
          } else tools.querySelector(".xrc-inline-person-stats")?.remove();
          renderUserCounts(tools,showStats ? handle : "",cached?.authorId);
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
          inlinePersonStats.set(postId,{revision,stats:row?.personStats,authorId:row?.authorId});
        }
      }
      for (const [tools,{anchor,postId}] of inlineAuthorTools) {
        if (!targets.has(postId) || !tools.isConnected || !anchor.isConnected || tools.dataset.account !== account ||
            profileHandle(anchor) !== tools.dataset.author) continue;
        const article = anchor.closest('article[data-testid="tweet"]');
        if (article && tweetId(article) === postId) {
          const cached = inlinePersonStats.get(postId);
          renderInlinePersonStats(tools,cached?.stats);
          renderUserCounts(tools,tools.dataset.author,cached?.authorId);
        }
      }
      while (inlinePersonStats.size > 1000) inlinePersonStats.delete(inlinePersonStats.keys().next().value);
    } catch (error) {
      console.warn("回过了：",error.message);
    }
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
    if (userCounts.size) renderUserCounts(bar.querySelector(".xrc-main-labels"),result.authorHandle,result.authorId);
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
    const main = document.createElement("div");
    main.className = "xrc-main-labels";
    main.replaceChildren(...labels);
    bar.replaceChildren(main);
    if (result.newPerson) {
      const badge = document.createElement("strong");
      badge.className = "xrc-new-person";
      badge.textContent = "NEW";
      badge.title = "这条是本地记录中他首次评论你的原帖，且你评论过他的原帖数为 0。";
      bar.append(badge);
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
    onAutoFillBlocked:(editor,reason)=>{if(continuous?.recommendedReply(editor))timedReplies?.stop(reason);}});
  refreshCycle = globalThis.XReplyRefreshCycle?.create({storage:chrome.storage,message,accountHandle,requestRefresh:scheduleControls,getTimed:()=>timedReplies,
    resume:(intent,valid)=>continuous.resumeRecommended(intent,valid),notify:text=>continuous?.notify(text)});
  timedReplies = globalThis.XReplyTimedReplies?.create({storage:chrome.storage,readState:()=>continuous?.timedState(),
    trigger:state=>continuous?.timedSend(state),requestRefresh:scheduleControls,keepAwake,
    onContinue:state=>aiReplies?.resumeAutomatic(state.editor)||"",
    onInterrupt:reason=>{aiReplies?.pause();continuous?.cancelTimedFollowup(reason);},cancelRefresh:id=>refreshCycle?.cancel(id)});
  continuous = globalThis.XReplyContinuous?.create({refreshCycle,timedReplies,skipAuthors,randomSkipLikeEnabled:()=>randomSkipReplyLike,interactionBlocked:()=>interactionAlert?.blocked()===true, accountHandle,tweetId,columnSelector:NOTIFICATION_COLUMN,message,renderLabels:(bar,row) => renderLabels(bar,row,false),renderPersonStats,requestRefresh:scheduleControls,connected,aiBusy:editor => aiReplies?.busy(editor) === true,aiRecommend:editor => aiReplies?.recommend(editor),aiPhase:editor => aiReplies?.phase(editor) || "",
    renderAiOptions:(tools,editor) => aiReplies?.renderOptions(tools,editor),
    aiFillRecommendedEnabled:()=>aiReplies?.fillRecommendedEnabled() === true});

  document.addEventListener("click",async event => {
    const button = event.target?.closest?.(".xrc-skip-author");
    const tools = button?.closest(".xrc-inline-author");
    const anchor = inlineAuthorTools.get(tools)?.anchor;
    if (!anchor?.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled || !connected()) return;
    const account = accountHandle();
    const author = profileHandle(anchor);
    if (!account || account !== tools.dataset.account || !author || author !== tools.dataset.author || !isSkipAuthorLink(anchor,author)) {
      schedule(0);
      return;
    }
    button.disabled = true;
    try {
      await message({ type:"SET_REPLY_SKIP_AUTHOR",account,author,skipped:!skipAuthors.authors(account).has(author) });
    } catch (error) {
      continuous?.notify(error.message);
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
        persistInteraction(data.batch,data.account) : null;
      void continuous?.receiveReply(data,saved);
      return;
    }
    if (event.data.type !== "OBSERVED") return;
    if (event.data.interaction === true) {
      if (event.data.account === accountHandle() && event.data.batch) {
        const saved=persistInteraction(event.data.batch,event.data.account);
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
