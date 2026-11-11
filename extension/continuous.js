(() => {
  "use strict";
  const COMPOSER = '[role="dialog"]';
  const EDITOR = '[contenteditable="true"][data-testid="tweetTextarea_0"]';
  const SEND = '[data-testid="tweetButton"]';
  const CLOSE = '[data-testid="app-bar-close"]';
  const NEXT_NOTE = "从当前帖往下选择，略过已回复。";
  const MAX_AUTO_VIDEO_SKIPS = 3;
  const SEND_KEY_GAP_MS = 500;
  const FEED_LABELS = {profile:"个人主页",search:"搜索",detail:"帖子详情"};
  const QUICK_REPLIES = [
    { label:"一起加油",phrases:[
      "一起加油好兄弟","一起加油鸭","一起加油🦆","一起加油",
      "一起加油呀","一起加油啊","一起加油啦","一起加油哇"
    ] },
    { label:"哈哈",phrases:[
      "哈哈","嘿嘿","哈哈哈","嘿嘿嘿"
    ] },
    { label:"难受啊",phrases:[
      "难受啊","难顶呀","太难了","难受呀",
      "难顶啊","太难了呀"
    ] },
    { label:"太卷了",phrases:[
      "太卷了","别卷了","卷不动了","太卷了呀",
      "太卷了啊","别卷啦","别卷了呀","卷不动啦",
      "卷不动了呀"
    ] },
    { label:"可爱捏",phrases:["可爱捏"] },
    { label:"不许色色",phrases:["不许色色"] }
  ];
  const ENDINGS = ["...","!","!!!","!!"];
  const pick = values => values[Math.floor(Math.random()*values.length)];
  const PRIMARY_COLUMN = '[data-testid="primaryColumn"]';
  const visible = node => {
    const box = node?.getBoundingClientRect();
    return Boolean(box?.width && box.height && getComputedStyle(node).visibility !== "hidden");
  };
  const enabled = node => node && !node.disabled && node.getAttribute("aria-disabled") !== "true";
  const eligible = row => row && !row.evidenceId &&
    (row.status === "not-reply" ? row.origin !== "mine" :
      !["replied","self","not-reply"].includes(row.status));

  function authorFromPostLink(article,id) {
    const time = article?.querySelector("time");
    const href = time?.closest("a")?.getAttribute("href");
    if (!href || time.closest('[role="link"]:not(a)')) return "";
    try {
      const url = new URL(href,location.href);
      const match = url.pathname.match(/^\/([a-z0-9_]{1,15})\/status\/(\d+)\/?$/i);
      return url.origin === location.origin && match && (id === undefined || match[2] === id) ? match[1].toLowerCase() : "";
    } catch { return ""; }
  }

  function candidateAuthor(article,id,row) {
    return authorFromPostLink(article,id) || row?.authorHandle?.toLowerCase() || "";
  }

  function excludedByInteractionGap(row,gap,whitelist) {
    if (!Number.isSafeInteger(gap) || !row?.authorId || whitelist?.has(row.authorId)) return false;
    const {myCommentedPosts:mine,theirCommentedPosts:theirs} = row.personStats || {};
    return mine > 0 && theirs > 0 && mine - theirs > gap;
  }

  function allowedAuthor(skipped,article,id,row,gap,whitelist) {
    if (excludedByInteractionGap(row,gap,whitelist)) return false;
    if (!skipped?.size) return true;
    const author = candidateAuthor(article,id,row);
    return Boolean(author) && !skipped.has(author);
  }

  function create({ accountHandle,tweetId,columnSelector,message,renderLabels,renderPersonStats = () => {},requestRefresh,refreshCycle,timedReplies,skipAuthors,randomSkipLikeEnabled = () => false,interactionBlocked = () => false,connected = () => true,aiBusy = () => false,aiRecommend,aiPhase = () => "",aiFillRecommendedEnabled = () => false,renderAiOptions }) {
    let session;
    let notice;
    let noticeTimer;
    let internalClose = false;
    let internalHeart = false;
    let internalTimedSend = false;
    let openingId = "";
    let rewriteNode;
    let rewriteWatch;
    let contextRevision = 0;
    let lastSendKeyAt = -Infinity;

    function composer() {
      return Array.from(document.querySelectorAll(COMPOSER))
        .find(node => visible(node) && node.querySelector(EDITOR) && node.querySelector(SEND));
    }

    function closeConfirmation() {
      return [...document.querySelectorAll('[data-testid="confirmationSheetDialog"],[role="alertdialog"]')].some(visible);
    }

    function feedColumn(s) {
      return document.querySelector(s.feed === "notifications" ? columnSelector : PRIMARY_COLUMN);
    }

    function selectedHomeTab(primary) {
      const tabs = Array.from(primary?.querySelectorAll('[role="tab"]') || []);
      const index = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
      return index === 0 || index === 1 ? index : -1;
    }

    function tabPath(tab) {
      const link = tab?.matches("a[href]") ? tab : tab?.querySelector("a[href]");
      if (!link) return "";
      try {
        const url = new URL(link.getAttribute("href"),location.href);
        return url.origin === location.origin ? url.pathname.replace(/\/$/,"").toLowerCase() : "";
      } catch { return ""; }
    }

    function profileTabs(primary,root) {
      // Positive profile identity: both Posts and Replies links must belong to this owner.
      const tabs = Array.from(primary?.querySelectorAll('[role="tab"]') || []);
      return tabs.some(tab => tabPath(tab) === root) &&
        tabs.some(tab => tabPath(tab) === root+"/with_replies") ? tabs : [];
    }

    function profileEntry(primary) {
      const path = location.pathname.replace(/\/$/,"").toLowerCase();
      const match = path.match(/^\/([a-z0-9_]{1,15})(?:\/with_replies)?$/);
      if (!match) return null;
      const root = "/"+match[1];
      const tabs = profileTabs(primary,root);
      const selected = tabs.find(tab => tab.getAttribute("aria-selected") === "true");
      return tabs.length && selected && tabPath(selected) === path ? { root,path } : null;
    }

    function searchKey(value) {
      try {
        const url = new URL(value,location.href);
        if (url.origin !== location.origin || !["","live"].includes(url.searchParams.get("f") || "")) return "";
        if (url.pathname !== "/search") {
          const match = url.pathname.match(/^\/hashtag\/([^/]+)\/?$/);
          if (!match) return "";
          const tag = decodeURIComponent(match[1]);
          if (!tag || /[\s/#?]/u.test(tag)) return "";
          url.searchParams.set("q","#"+tag);
        }
        if (!url.searchParams.get("q")?.trim()) return "";
        // Search source is tracking; the query, filter and result tab define the list.
        url.searchParams.delete("src");
        url.searchParams.sort();
        return url.searchParams.toString();
      } catch { return ""; }
    }

    function searchTabs(primary) {
      return Array.from(primary?.querySelectorAll('a[role="tab"][href]') || [])
        .map(tab => ({tab,key:searchKey(tab.getAttribute("href"))}));
    }

    function searchEntry(primary) {
      const key = searchKey(location.href);
      return key && searchTabs(primary).some(item => item.key === key &&
        item.tab.getAttribute("aria-selected") === "true") ? key : "";
    }

    function detailPostId(path) {
      return path.match(/^\/(?:i\/web|[a-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/i)?.[1] || "";
    }

    function mountedArticles(s) {
      const column = feedColumn(s);
      return Array.from(column?.querySelectorAll('article[data-testid="tweet"]') || [])
        .filter(article => !article.closest(COMPOSER));
    }

    const availableArticle = article => !article.hasAttribute("data-xrc-home-hidden") &&
      !article.hasAttribute("data-xrc-notification-hidden");

    function articles(s) { return mountedArticles(s).filter(availableArticle); }

    function mountedCards(s) {
      return mountedArticles(s).map(article => [tweetId(article),article]).filter(([id]) => id);
    }

    function recommendedCandidates() {
      return [...new Map(mountedCards({feed:"home"}).filter(([,article]) =>
        availableArticle(article) && enabled(article.querySelector('[data-testid="reply"]'))))];
    }

    function selectionSignature(ids,recommended) {
      const gap = recommended ? skipAuthors?.recommendedInteractionGap?.() : null;
      return `${contextRevision}:${skipAuthors?.revision() || 0}:${gap ?? ""}:${ids.join(",")}`;
    }

    function cardPosition(cards,{id,article}) {
      const position = cards.findIndex(([key,node]) => key === id && node === article);
      return position >= 0 ? position : cards.findIndex(([key]) => key === id);
    }

    function replyTarget(id,article,cards) {
      const position = cardPosition(cards,{id,article});
      const followingIds = new Set(position >= 0 ? cards.slice(position+1).map(([key]) => key) : []);
      return {id,article,authorHint:authorFromPostLink(article,id),followingIds};
    }

    function cardsAfter(cards,target) {
      const position = cardPosition(cards,target);
      // If X unmounts the current post, only continue with cards known to follow it.
      return position >= 0 ? cards.slice(position+1) : cards.filter(([id]) => target.followingIds.has(id));
    }

    function currentArticle(s) {
      const cached = s.current.article;
      const primary = feedColumn(s);
      if (cached?.isConnected && primary?.contains(cached) && tweetId(cached) === s.current.id &&
          !cached.closest(COMPOSER) && availableArticle(cached)) return cached;
      // X can replace or reuse virtual cards. Revalidate identity before touching a native control.
      return s.current.article = articles(s).find(node => tweetId(node) === s.current.id);
    }

    function nativeHeart(s) {
      const article = currentArticle(s);
      return Array.from(article?.querySelectorAll('[data-testid="like"],[data-testid="unlike"]') || [])
        .find(button => button.closest('article[data-testid="tweet"]') === article);
    }

    function toggleHeart(s) {
      if (!currentSession(s) || !["ready","failed"].includes(s.phase)) return;
      const heart = nativeHeart(s);
      if (!enabled(heart)) return;
      // Only this explicit click invokes X's native control; its response uses the existing save path.
      s.current.heartPending={startedAt:Date.now()};
      heart.click();
      refresh();
    }

    function clearNotice() {
      clearTimeout(noticeTimer);
      notice?.remove();
      notice = null;
    }

    function showNotice(text,action,temporary = false) {
      clearNotice();
      notice = document.createElement("aside");
      notice.className = "xrc-flow-notice";
      notice.setAttribute("role","status");
      const label = document.createElement("span");
      label.textContent = text;
      notice.append(label);
      if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        button.addEventListener("click",event => { event.stopPropagation(); action.run(); });
        notice.append(button);
      }
      if (session && action?.label !== "结束连续回复") {
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "×";
        close.setAttribute("aria-label","结束连续回复");
        close.addEventListener("click",() => finish());
        notice.append(close);
      }
      document.body.append(notice);
      if (temporary) noticeTimer = setTimeout(clearNotice,8000);
    }

    function finish(text = "",{preserveTimed=false}={}) {
      if(!preserveTimed)timedReplies?.stop("连续回复已结束");
      const previous = session;
      session = undefined;
      openingId = "";
      clearTimeout(previous?.timeout);
      rewriteWatch?.disconnect();
      rewriteWatch = undefined;
      rewriteNode = undefined;
      document.querySelectorAll(".xrc-continuous").forEach(node => node.remove());
      clearNotice();
      if (text) showNotice(text,null,true);
    }

    function pauseForAlert() {
      timedReplies?.stop("收到异常提醒，已停止");
      const s=session;if(!s)return;
      clearTimeout(s.timeout);s.autoAdvance=false;
      if(s.afterReply)s.afterReply.cancelled=true;
      s.phase="alert-paused";s.note="X 返回异常，已暂停；请先查看红色提示。";
      clearNotice();if(s.current.dialog?.isConnected)render(s);
    }

    function currentSession(s) {
      if (interactionBlocked() || !connected() || session !== s || accountHandle() !== s.account) return false;
      const column = feedColumn(s);
      if (!column) return false;
      if (s.feed === "detail") {
        const path = location.pathname;
        return column === s.detailColumn &&
          (detailPostId(path) === s.detailId || /^\/compose(?:\/|$)/.test(path));
      }
      if (s.feed === "home") {
        if (!/^\/(?:home|compose)(?:\/|$)/.test(location.pathname)) return false;
        const tabs = [...column.querySelectorAll('[role="tab"]')];
        const selected = tabs.find(tab => tab.getAttribute("aria-selected") === "true");
        return tabs.length > 0 && (!selected || selected === tabs[s.homeTabIndex]);
      }
      if (s.feed === "search") {
        if (location.pathname === "/search" || location.pathname.startsWith("/hashtag/")) {
          if (searchKey(location.href) !== s.searchKey) return false;
        } else if (!/^\/compose(?:\/|$)/.test(location.pathname)) return false;
        const tabs = searchTabs(column);
        const selected = tabs.find(item => item.tab.getAttribute("aria-selected") === "true");
        return tabs.some(item => item.key === s.searchKey) && (!selected || selected.key === s.searchKey);
      }
      if (s.feed === "profile") {
        const path = location.pathname.replace(/\/$/,"").toLowerCase();
        if (path !== s.profile.path && !/^\/compose(?:\/|$)/.test(path)) return false;
        const tabs = profileTabs(column,s.profile.root);
        const selected = tabs.find(tab => tab.getAttribute("aria-selected") === "true");
        return tabs.length > 0 && (!selected || tabPath(selected) === s.profile.path);
      }
      return /^\/(?:notifications|compose)(?:\/|$)/.test(location.pathname);
    }

    function entryFeed(article) {
      if (article.closest(COMPOSER)) return "";
      if (/^\/notifications(?:\/|$)/.test(location.pathname) && article.closest(columnSelector)) return "notifications";
      const primary = document.querySelector(PRIMARY_COLUMN);
      if (!primary?.contains(article)) return "";
      if (/^\/home\/?$/.test(location.pathname) && selectedHomeTab(primary) >= 0) return "home";
      if (detailPostId(location.pathname)) return "detail";
      if (searchEntry(primary)) return "search";
      return profileEntry(primary) ? "profile" : "";
    }

    function start(article,feed,{restoring=false}={}) {
      if (!connected() || interactionBlocked()) return;
      const id = tweetId(article);
      const account = accountHandle();
      if (!id || !account) return;
      const profile = feed === "profile" ? profileEntry(document.querySelector(PRIMARY_COLUMN)) : null;
      if (feed === "profile" && !profile) return;
      const search = feed === "search" ? searchEntry(document.querySelector(PRIMARY_COLUMN)) : "";
      if (feed === "search" && !search) return;
      const detailId = feed === "detail" ? detailPostId(location.pathname) : "";
      const detailColumn = detailId ? article.closest(PRIMARY_COLUMN) : null;
      if (feed === "detail" && (!detailColumn || composer())) return;
      if(!restoring)refreshCycle?.cancel();
      finish("",{preserveTimed:restoring});
      const s = session = {
        profile,searchKey:search,detailId,detailColumn,
        account,feed,homeTabIndex:feed === "home" ? selectedHomeTab(document.querySelector(PRIMARY_COLUMN)) : -1,
        handled:new Set(),current:replyTarget(id,article,mountedCards({feed})),phase:detailId ? "opening" : "ready",
        note:NEXT_NOTE,attempt:null
      };
      if (detailId) s.timeout = setTimeout(() => {
        if (session === s && s.phase === "opening") finish();
      },8000);
      refresh();
    }

    async function resumeRecommended(intent,valid) {
      if (interactionBlocked() || !valid() || session || location.pathname !== "/home") return "paused";
      if (skipAuthors && !await skipAuthors.ready()) throw new Error("跳过名单暂不可用，请刷新 X 后再试。");
      if (interactionBlocked() || !valid() || session || location.pathname !== "/home") return "paused";
      const primary=document.querySelector(PRIMARY_COLUMN);
      const tabs=Array.from(primary?.querySelectorAll('[role="tab"]') || []);
      if (!tabs.length) return "waiting";
      const selected=selectedHomeTab(primary);
      if (selected!==0) {
        if (!intent.switched && tabs.some(tab=>tab.getAttribute("aria-selected")==="true")) {intent.switched=true;tabs[0].click();}
        return "waiting";
      }
      const ids = recommendedCandidates().map(([id]) => id);
      if (!ids.length) return "waiting";
      const signature = selectionSignature(ids,true);
      if (intent.lastCheck===signature) return "waiting";
      intent.lastCheck=signature;
      let awaitingEvidence = false;
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset,offset+100);
        const result = await message({type:"CLASSIFY",account:intent.account,ids:batch});
        if (!valid() || session || location.pathname !== "/home") return "paused";
        const currentColumn = document.querySelector(PRIMARY_COLUMN);
        if (selectedHomeTab(currentColumn) !== 0) {
          return currentColumn?.querySelector('[role="tab"][aria-selected="true"]') ? "paused" : "waiting";
        }
        if (result.recognized === false) return "waiting";
        const rows = new Map(result.rows.map(row => [row.id,row]));
        const classified = new Set(batch);
        const skipped = skipAuthors?.authors(intent.account);
        const gap = skipAuthors?.recommendedInteractionGap?.();
        const whitelist = gap == null ? undefined : skipAuthors?.whitelist(result.accountId);
        // Match IDs to the current cards: X may replace or hide nodes during classification.
        for (const [id,article] of recommendedCandidates()) {
          if (!classified.has(id)) continue;
          const row = rows.get(id);
          const author = candidateAuthor(article,id,row);
          if (author === intent.account || skipped?.has(author) || excludedByInteractionGap(row,gap,whitelist) || row && !eligible(row)) continue;
          if (!author || !row?.personStats) { awaitingEvidence = true; continue; }
          if (!valid()) return "paused";
          start(article,"home",{restoring:true});
          if (!session || session.current.id !== id) return "paused";
          session.phase = "opening";
          return openCurrent(session) ? "opened" : "paused";
        }
      }
      if (signature !== selectionSignature(recommendedCandidates().map(([id]) => id),true)) {
        requestRefresh();
        return "waiting";
      }
      return awaitingEvidence ? "waiting" : "empty";
    }

    function replyPostId(editor) {
      const s=session;
      if (!editor || !s || s.current.dialog?.querySelector(EDITOR) !== editor || !currentSession(s)) return "";
      return s.current.id;
    }

    function replyArticle(editor) {
      return replyPostId(editor) ? currentArticle(session) : null;
    }

    function rootOwnership(editor) {
      const id = replyPostId(editor);
      return id && session.current.context?.id === id ? session.current.context.origin || "unknown" : "unknown";
    }

    const timedPageAllowed = () => timedReplies?.pageAllowed?.() ?? (!document.hidden && (!document.hasFocus || document.hasFocus()));

    const isRecommended = s => s?.feed === "home" && s.homeTabIndex === 0;

    function recommendedReply(editor) {
      const s=session,dialog=s?.current.dialog;
      if (!isRecommended(s) || s.phase !== "ready" || !dialog?.contains(editor) ||
          s.current.composing || s.current.quickPending || !currentSession(s) || !singleReply(dialog)) return null;
      return s.current;
    }

    function canAutoFillUnfocused(editor) {
      return timedReplies?.allowsUnfocused?.()===true && timedPageAllowed() && Boolean(recommendedReply(editor));
    }

    const hasAttachments = dialog => Boolean(dialog.querySelector(
      '[data-testid="attachments"],[data-testid="mediaPreview"],[data-testid^="pollOption_"]'));

    function hasDraft(dialog) {
      return Boolean(dialog.querySelector(EDITOR)?.innerText.trim()) || hasAttachments(dialog);
    }

    function autoSkipAllowed() {
      return timedPageAllowed() && !timedReplies?.isPaused?.() && !timedReplies?.isFinishing?.();
    }

    function skipVideo(editor) {
      const s = session;
      const target = recommendedReply(editor);
      if (!target || composer() !== target.dialog || target.dialog.querySelector(EDITOR) !== editor ||
          target.heartPending || !autoSkipAllowed() || (s.videoSkips || 0) >= MAX_AUTO_VIDEO_SKIPS) return false;
      return closeForNext(s,{autoVideo:true});
    }

    function draftBusy(s) {
      const editor = s.current.dialog?.querySelector(EDITOR);
      if (s.current.fillingText !== undefined && editor?.innerText.replace(/\n$/,"") === s.current.fillingText) {
        delete s.current.fillingText;
      }
      const rewrite = document.querySelector("#xreply-toast");
      if (rewrite !== rewriteNode) {
        rewriteWatch?.disconnect();
        rewriteNode = rewrite;
        if (rewrite) {
          rewriteWatch = new MutationObserver(requestRefresh);
          rewriteWatch.observe(rewrite,{ attributes:true,attributeFilter:["style"],childList:true,subtree:true });
        }
      }
      return aiBusy(editor) || s.current.fillingText !== undefined ||
        (visible(rewrite) && /^改写中/.test(rewrite.innerText.trim()));
    }

    function closeForNext(s,{autoVideo=false}={}) {
      if (!currentSession(s)) return false;
      if (draftBusy(s) || s.current.quickPending) { render(s); return false; }
      const dialog = s.current.dialog;
      const close = dialog?.querySelector(CLOSE);
      if (!enabled(close)) {
        s.note = "未找到关闭按钮，请手动关闭回复框后重新开始。";
        render(s);
        return false;
      }
      s.hadDraft = hasDraft(dialog);
      if (autoVideo && s.hadDraft) return false;
      s.saveClicked = false;
      s.current.autoSkippedVideo = autoVideo;
      if (autoVideo) s.videoSkips = (s.videoSkips || 0)+1;
      s.phase = "closing";
      s.note = autoVideo ? "正在跳过纯视频…" : s.hadDraft ? "正在保存 X 草稿并跳过…" : "正在进入下一条…";
      render(s);
      internalClose = true;
      try { close.click(); } finally { internalClose = false; }
      refresh();
      if (autoVideo && session === s && s.phase === "closing") {
        s.timeout = setTimeout(() => {
          if (!currentSession(s) || s.phase !== "closing") return;
          const note = "X 未确认关闭回复框，请手动处理后继续。";
          if (composer() !== dialog) { finish(note); return; }
          s.current.autoSkippedVideo = false;
          s.phase = "ready";
          s.note = note;
          timedReplies?.stop(s.note);
          render(s);
        },2000);
      }
      return true;
    }

    function saveDraftIfAsked(s) {
      const dialogs = Array.from(document.querySelectorAll(
        '[data-testid="confirmationSheetDialog"],[role="dialog"],[role="alertdialog"]'));
      for (const dialog of dialogs) {
        if (!visible(dialog) || dialog.querySelector(EDITOR)) continue;
        if (!/草稿|帖子|推文|貼文|draft|post|tweet/i.test(dialog.innerText)) continue;
        const save = Array.from(dialog.querySelectorAll('button,[role="button"]')).find(button =>
          visible(button) && /^(保存|保存草稿|儲存|儲存草稿|Save|Save draft)$/i.test(button.innerText.trim()));
        if (enabled(save) && s.saveButton !== save) {
          s.saveButton = save;
          s.saveClicked = true;
          save.click();
        }
        return true;
      }
      return false;
    }

    async function advance(s) {
      if (interactionBlocked() || !currentSession(s) || s.phase === "advancing") return;
      if (s.phase === "refreshing") return;
      s.handled.add(s.current.id);
      if (!s.current.autoSkippedVideo) s.videoSkips = 0;
      if (!s.current.autoSkippedVideo && refreshCycle?.due(s) && !timedReplies?.isPaused() && !timedReplies?.isFinishing?.()) {
        const refreshToken = s.refreshToken = {};
        s.phase="refreshing";clearNotice();
        const valid=()=>currentSession(s)&&s.phase==="refreshing"&&s.refreshToken===refreshToken;
        const result=await refreshCycle.refresh(s,()=>valid()&&!composer());
        if (!valid()) return;
        if (result==="navigating") return;
        if (result==="paused") {
          s.afterReply=null;
          s.phase="sent";s.autoAdvance=false;s.note="已达到换批次数。"+(refreshCycle.pauseMessage() || "本次刷新已暂停，请核对页面状态后继续。");
          showNotice(s.note,{label:"继续换一批",run:()=>advance(s)});return;
        }
      }
      await selectNext(s);
    }

    async function selectNext(s) {
      if (interactionBlocked() || !currentSession(s) || s.phase === "advancing") return;
      s.phase = "advancing";
      const selection = s.selection = {};
      const valid = () => currentSession(s) && s.phase==="advancing" && s.selection===selection;
      const canContinue = () => {
        if (!valid()) return false;
        if (s.current.autoSkippedVideo && (!autoSkipAllowed() || composer() || closeConfirmation())) {
          finish("页面状态已变化，已停止自动跳过。");
          return false;
        }
        return true;
      };
      clearTimeout(s.timeout);
      s.attempt = null;
      s.current.dialog?.querySelector(".xrc-continuous")?.remove();
      clearNotice();
      try {
        if (skipAuthors && !await skipAuthors.ready()) throw new Error("跳过名单暂不可用，请刷新 X 后再试。");
        if (!canContinue()) return;
        const recommended = isRecommended(s);
        const skipVideos = recommended && aiFillRecommendedEnabled();
        const canOpen = ([id,article]) => !s.handled.has(id) && availableArticle(article) &&
          enabled(article.querySelector('[data-testid="reply"]')) &&
          (!skipVideos || !globalThis.XReplyAIReplies?.videoOnlyArticle(article));
        const nextIds = () => [...new Set(cardsAfter(mountedCards(s),s.current).filter(canOpen).map(([id]) => id))];
        let ids = nextIds();
        let next;
        // Only inspect mounted cards; classify locally in bounded batches.
        const signature = recommended ? selectionSignature(ids,true) : "";
        for (let pass = 0; pass < 2 && !next; pass++) {
          for (let offset = 0; offset < ids.length && !next; offset += 100) {
            const result = await message({ type:"CLASSIFY",account:s.account,ids:ids.slice(offset,offset+100) });
            if (!canContinue()) return;
            if (s.afterReply?.timed && !s.afterReply.cancelled && !timedPageAllowed()) {
              timedReplies?.pause("页面不在前台，返回后点击继续本轮");
              return;
            }
            const byId = new Map(result.rows.map(row => [row.id,row]));
            const skipped = skipAuthors?.authors(s.account);
            const gap = recommended ? skipAuthors?.recommendedInteractionGap?.() : null;
            const whitelist = gap == null ? undefined : skipAuthors?.whitelist(result.accountId);
            const cards = mountedCards(s);
            const detailRoot = s.feed === "detail" ? s.current.context?.rootId || s.detailId : "";
            const match = cardsAfter(cards,s.current).find(([id,article]) => {
              const row = byId.get(id);
              return eligible(row) && (!detailRoot || row.rootId === detailRoot) &&
                canOpen([id,article]) && allowedAuthor(skipped,article,id,row,gap,whitelist);
            });
            if (match) next = replyTarget(match[0],match[1],cards);
          }
          if (next || !recommended || pass > 0) break;
          // Catch cards, settings or evidence that changed during the read, without polling.
          ids = nextIds();
          if (selectionSignature(ids,true) === signature) break;
        }
        if (!next) {
          finish("当前位置之后没有符合条件的已加载帖子。向下浏览后，可以从任一条重新开始。");
          return;
        }
        s.afterReply=null;
        s.current = next;
        s.phase = "opening";
        s.note = s.saveClicked ? "上一条已保存到 X 草稿。" : NEXT_NOTE;
        openCurrent(s);
      } catch (error) {
        if (valid()) {
          s.phase = "paused";
          showNotice(error.message,{ label:"结束连续回复",run:() => finish() });
        }
      }
    }

    function openCurrent(s) {
      if (!currentSession(s)) return false;
      const article = currentArticle(s);
      const reply = article?.querySelector('[data-testid="reply"]');
      if (!enabled(reply)) {
        s.phase = "paused";
        showNotice("这条内容已移出页面，可继续选择其他已加载内容。",{
          label:"继续下一条",run:() => selectNext(s)
        });
        return false;
      }
      clearNotice();
      openingId = s.current.id;
      article.scrollIntoView({ block:"nearest",behavior:"instant" });
      reply.click();
      openingId = "";
      s.timeout = setTimeout(() => {
        if (session === s && s.phase === "opening") finish("未能打开下一条，请从列表重新开始。");
      },8000);
      return session === s;
    }

    const postReplyPhase = s => s && ["like-delay","liking"].includes(s.phase);

    function stopAfterReply(s,note) {
      if (!s || session !== s || !s.afterReply) return;
      s.afterReply.cancelled = true;
      const advancing = s.afterReply.timed && (["advancing","refreshing"].includes(s.phase) || s.phase==="sent" && s.autoAdvance);
      if (!postReplyPhase(s) && !advancing) return; // Keep waiting for an in-flight reply receipt.
      clearTimeout(s.timeout);
      s.phase = "sent"; s.autoAdvance = false; s.note = note;
      clearNotice(); refresh();
    }

    function validAfterReply(s,operation) {
      if (!currentSession(s) || s.afterReply !== operation || s.current !== operation.current ||
          operation.cancelled || document.hidden || operation.timed && !timedPageAllowed()) return false;
      const dialog = composer();
      if (dialog && dialog !== s.current.dialog) return false;
      if (dialog && (s.current.composing || s.current.quickPending || draftBusy(s))) return false;
      const text = dialog?.querySelector(EDITOR)?.innerText || "";
      return !text.trim() || text === operation.draft;
    }

    function completeAfterReply(s,operation) {
      if (!validAfterReply(s,operation)) {
        stopAfterReply(s,"评论已发送，后续操作已停止；核对后可继续下一条。");return;
      }
      clearTimeout(s.timeout);
      if (!operation.timed) s.afterReply=null;
      s.phase="sent";s.autoAdvance=true;
      s.note=operation.likeUnavailable?"评论已确认，点赞按钮不可用，略过点赞进入下一条…":
        operation.skipLike?"评论已确认，本次跳过点赞，正在进入下一条…":"评论与点赞已确认，正在进入下一条…";
      clearNotice();refresh();
    }

    function waitThenLike(s,operation) {
      s.phase="like-delay";s.autoAdvance=false;
      if (!validAfterReply(s,operation)) {
        stopAfterReply(s,"评论已发送，后续点赞已取消；核对后可继续下一条。");return;
      }
      s.note=operation.skipLike?"评论已发送，本次不点赞，稍候进入下一条…":"评论已发送，稍候点赞…";clearNotice();refresh();
      s.timeout=setTimeout(()=>{
        if (!validAfterReply(s,operation)) {
          stopAfterReply(s,"评论已发送，页面或编辑状态已变化，未继续点赞。");return;
        }
        if (operation.skipLike) {completeAfterReply(s,operation);return;}
        const heart=nativeHeart(s);
        if (!enabled(heart)) {
          if(s.current.heartPending) {
            stopAfterReply(s,"评论已发送，但已有点赞尚未确认；请核对后继续下一条。");return;
          }
          operation.likeUnavailable=true;
          completeAfterReply(s,operation);return;
        }
        if (heart.getAttribute("data-testid")==="unlike") {
          if (s.current.heartPending) {
            stopAfterReply(s,"评论已发送，已有点赞尚未确认；请核对后继续下一条。");return;
          }
          completeAfterReply(s,operation);return;
        }
        operation.likeStartedAt=Date.now();operation.settled=false;
        s.phase="liking";s.note="评论已发送，正在点赞…";
        s.current.heartPending={startedAt:operation.likeStartedAt};
        clearNotice();refresh();
        s.timeout=setTimeout(()=>stopAfterReply(s,"评论已发送，点赞结果未确认；不会重发评论或重试点赞，可核对后继续下一条。"),10000);
        internalHeart=true;
        try {heart.click();} finally {internalHeart=false;}
      },300+Math.floor(Math.random()*451));
    }

    async function receiveLike(data,saved) {
      if(interactionBlocked())return;
      const s=session,current=s?.current;
      if (!s || !currentSession(s) || data.account!==s.account || !Number.isFinite(data.requestStartedAt) || !saved) return;
      const likes=Array.isArray(data.batch?.likes)?data.batch.likes:[];
      const like=likes.slice(0,500).find(row=>row?.id===current.id && typeof row.liked==="boolean" && row.source==="mutation");
      if (!like) return;
      const pending=current.heartPending,operation=s.afterReply;
      const settlesPending=pending && data.requestStartedAt>=pending.startedAt;
      const settlesOperation=operation && !operation.cancelled && s.phase==="liking" &&
        !operation.settled && like.liked && data.requestStartedAt>=operation.likeStartedAt;
      if (!settlesPending && !settlesOperation) return;
      if (settlesOperation) operation.settled=true;
      try {
        await saved;
        if (session===s && s.current===current && settlesPending && current.heartPending===pending) {
          current.heartPending=null;requestRefresh();
        }
        if (settlesOperation && s.afterReply===operation && s.phase==="liking") completeAfterReply(s,operation);
      } catch {
        if (settlesOperation && s.afterReply===operation) {
          stopAfterReply(s,"评论已发送，点赞成功但记录未保存；请核对后继续，不要重发评论。");
        }
      }
    }

    function cancelTimedFollowup(reason) {
      if(session?.afterReply?.timed)stopAfterReply(session,reason+"；已发出的评论请核对，不会继续点赞。");
    }

    function timedState() {
      const s=session;
      if(!s || !isRecommended(s))return {supported:false,reason:"仅支持为你推荐"};
      const state={supported:true,session:s,account:s.account,id:s.current.id,draft:"",ready:false,resumeReady:s.phase==="ready",likePending:s.phase==="liking"||Boolean(s.current.heartPending)};
      state.settling=Boolean(s.afterReply?.timed && !s.afterReply.cancelled &&
        (["sending","like-delay","liking","advancing","refreshing"].includes(s.phase) || s.phase==="sent" && s.autoAdvance));
      if(interactionBlocked())return {...state,reason:"收到异常提醒，已停止"};
      if(!currentSession(s))return {...state,reason:"页面或账号变化，已停止"};
      if(["failed","uncertain","paused","draft-check","alert-paused"].includes(s.phase))
        return {...state,reason:"当前操作需要核对，已停止定时触发"};
      if(s.phase==="sent"&&!s.autoAdvance)return {...state,awaitingReview:true,reason:"本条已发送，请核对后进入下一条再继续"};
      if(!timedPageAllowed())return {...state,pauseable:true,reason:"页面不在前台，返回后点击继续本轮"};
      if(s.phase!=="ready")return {...state,waiting:"等待本条处理完成"};
      const dialog=s.current.dialog,editor=dialog?.querySelector(EDITOR);
      if(!dialog?.isConnected || composer()!==dialog || !editor)return {...state,reason:"回复框已变化，已停止"};
      if(hasAttachments(dialog))return {...state,reason:"定时发送只支持纯文字，请手动处理附件或投票"};
      state.editor=editor;state.draft=editor.innerText;
      state.ready=Boolean(state.draft.trim() && !s.current.composing && !s.current.quickPending && !draftBusy(s) &&
        singleReply(dialog) && enabled(dialog.querySelector(SEND)));
      state.waiting="等待草稿或AI填入完成";
      return state;
    }

    function timedSend(expected) {
      const state=timedState();
      if(!state.ready || state.reason || state.session!==expected.session || state.id!==expected.id || state.draft!==expected.draft)return false;
      const button=state.session.current.dialog.querySelector('.xrc-flow-send');if(!enabled(button))return false;
      internalTimedSend=true;
      try {button.click();} finally {internalTimedSend=false;}
      return session===state.session && session.phase==="sending";
    }

    function sendNext(s) {
      if (!currentSession(s)) return;
      if (draftBusy(s) || s.current.quickPending) { render(s); return; }
      if (s.phase === "sent") {timedReplies?.stop("已转为手动操作",{preservePaused:true});closeForNext(s);return;}
      const dialog = s.current.dialog;
      const submit = dialog?.querySelector(SEND);
      if (!["ready","failed"].includes(s.phase) || !enabled(submit) || !singleReply(dialog)) return;
      if(!internalTimedSend)timedReplies?.stop("已转为手动发送");
      s.saveClicked = false;
      // Freeze one decision per send attempt; re-renders and setting changes must not reroll it.
      s.afterReply = {current:s.current,draft:dialog.querySelector(EDITOR).innerText,cancelled:false,
        skipLike:randomSkipLikeEnabled() && Math.random()<0.5,timed:internalTimedSend};
      s.attempt = { parentId:s.current.id,clickedAt:Date.now(),requestId:"" };
      s.phase = "sending";
      s.note = s.afterReply.skipLike?"发送中，确认并保存后停顿并进入下一条…":"发送中，确认并保存后再点赞…";
      render(s);
      s.timeout = setTimeout(() => {
        if (session !== s || s.phase !== "sending") return;
        s.phase = "uncertain";
        timedReplies?.stop("发送结果未确认，本轮已结束");
        s.note = "暂未确认发送结果，请先核对；不会重复发送。";
        render(s);
        if (!composer()) showNotice(s.note,{ label:"结束连续回复",run:() => finish() });
      },30000);
      // Use the native composer, including its validation, attachments and current text.
      submit.click();
    }

    function singleReply(dialog) {
      return dialog && dialog.querySelectorAll('[contenteditable="true"][data-testid^="tweetTextarea_"]').length === 1;
    }

    function updateContext(context,row) {
      const labels = context.querySelector(".xrc-labels");
      if (labels) renderLabels(labels,row);
      const preview = context.parentElement.querySelector(".xrc-flow-root");
      if (preview) {
        const excerpt = (row.rootText || "").replace(/\s+/g," ").trim();
        const previewText = excerpt ? `原帖：${excerpt}` : "原帖内容暂未缓存";
        if (preview.textContent !== previewText) preview.textContent = previewText;
        preview.title = excerpt ? `本地缓存文字摘要：${excerpt}` : "仅使用本地缓存，不自动请求原帖。";
      }
      const profile = context.querySelector(".xrc-flow-profile");
      const handle = /^[a-zA-Z0-9_]{1,15}$/.test(row.authorHandle || "") ? row.authorHandle : "";
      if (handle) profile.href = `https://x.com/${handle}`;
      else profile.removeAttribute("href");
      profile.setAttribute("aria-disabled",String(!handle));
      profile.title = handle ? `在单个伴随窗口查看 @${handle}；同一个人只唤起，换人直接切换原窗口，不检查右侧草稿。` :
        "尚未读取到当前回复对象的账号，暂不能打开主页。";
    }

    function renderContext(s,bar) {
      const withDetails = s.feed === "notifications";
      let context = bar.querySelector(".xrc-flow-context");
      if (!context) {
        context = document.createElement("div");
        context.className = withDetails ? "xrc-flow-context" : "xrc-flow-context xrc-flow-context-home";
        if (withDetails) {
          const labels = document.createElement("div");
          labels.className = "xrc-labels";
          labels.setAttribute("aria-label","当前回复对象 · 对话提示");
          renderLabels(labels,{ id:s.current.id,origin:"unknown",status:"unknown" });
          context.append(labels);
        }
        const profile = document.createElement("a");
        profile.className = "xrc-flow-profile";
        profile.textContent = "伴随主页 ↗";
        profile.target = "_blank";
        profile.rel = "noopener noreferrer";
        profile.setAttribute("aria-disabled","true");
        profile.title = "正在确认当前回复对象的账号";
        profile.addEventListener("click",async event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); event.stopPropagation();
          if (!currentSession(s) || profile.getAttribute("aria-disabled") === "true" ||
              profile.getAttribute("aria-busy") === "true") return;
          const handle = s.current.context?.authorHandle;
          if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle || "")) return;
          profile.setAttribute("aria-busy","true");
          try {
            const result = await message({type:"COMPANION_OPEN",handle});
            if (result.handle && result.handle.toLowerCase() !== handle.toLowerCase() && currentSession(s)) {
              showNotice("伴随窗口已按最近一次点击切换到其他对象；如需当前对象，请再点一次。",null,true);
            }
          } catch (error) {
            if (currentSession(s)) showNotice(error.message,null,true);
          } finally { profile.removeAttribute("aria-busy"); }
        });
        context.append(profile);
        bar.append(context);
      }
      let preview = bar.querySelector(".xrc-flow-root");
      if (withDetails && !preview) {
        preview = document.createElement("div");
        preview.className = "xrc-flow-root";
        preview.setAttribute("aria-label","原帖文字摘要");
        preview.textContent = "原帖：读取本地缓存…";
        context.after(preview);
      }
      let people = bar.querySelector(".xrc-flow-people");
      if (!people) {
        people = document.createElement("div");
        people.className = "xrc-flow-people";
        people.setAttribute("aria-label","当前回复对象 · 本地互动原帖数");
        bar.append(people);
      }
      const current = s.current;
      const row = current.context;
      renderPersonStats(people,row?.personStats,row?.authorHandle,row?.authorId);
      if (row && (current.renderedContext !== context || current.renderedRow !== row)) {
        updateContext(context,row);
        current.renderedContext = context; current.renderedRow = row;
      }
      const revision = contextRevision;
      refreshCycle?.render(s,bar);
      if (current.contextRevision === revision) return;
      current.contextRevision = revision;
      // Local classification only; never resolve the profile from the conversation's root author.
      void message({ type:"CLASSIFY",account:s.account,ids:[current.id],includeRootText:withDetails,
        authorHint:current.authorHint }).then(result => {
        if (!currentSession(s) || s.current !== current || contextRevision !== revision) return;
        const row = result.rows.find(item => item.id === current.id);
        if (!row) return;
        current.context = row;
        render(s);
      }).catch(() => {
        if (context.isConnected && s.current === current && contextRevision === revision) {
          context.querySelector(".xrc-flow-profile").title = "本地记录读取失败，请关闭回复框后重试。";
          const preview = bar.querySelector(".xrc-flow-root");
          if (preview) preview.textContent = "原帖内容暂不可用";
        }
      });
    }

    async function fillQuickReply(s,phrases) {
      if (!currentSession(s) || !["ready","failed"].includes(s.phase) || s.current.composing || s.current.quickPending ||
          draftBusy(s) || !singleReply(s.current.dialog)) return;
      const editor = s.current.dialog.querySelector(EDITOR);
      if (!editor || editor.getAttribute("aria-disabled") === "true") return;
      const before = editor.innerText;
      const separator = before && !/\s$/.test(before) ? " " : "";
      const value = separator+pick(phrases)+pick(ENDINGS);
      const current = s.current;
      current.quickPending = true;
      requestRefresh();
      try {
        const inserted = await globalThis.XReplyEditor.write(editor,value,{
          expected:before.replace(/\n$/, ""),
          valid:() => currentSession(s) && s.current === current && !current.composing && !draftBusy(s)
        });
        if (!inserted) s.note = "快捷填入未完成，请直接在回复框输入。";
        else if (s.note === "快捷填入未完成，请直接在回复框输入。") s.note = NEXT_NOTE;
      } catch {s.note = "快捷填入未完成，请直接在回复框输入。";}
      finally {current.quickPending = false;requestRefresh();}
    }

    function render(s) {
      const dialog = s.current.dialog;
      if (!dialog?.isConnected) return;
      // X's outer dialog is transparent; keep our controls in its native footer.
      const nativeToolbar = dialog.querySelector(SEND)?.closest('[data-testid="toolBar"]');
      if (!nativeToolbar) return;
      let bar = dialog.querySelector(".xrc-continuous");
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "xrc-continuous";
        bar.setAttribute("aria-label","连续回复");
        bar.addEventListener("click",event => event.stopPropagation());
        const status = document.createElement("span");
        status.className = "xrc-flow-status";
        status.setAttribute("role","status");
        const skip = document.createElement("button");
        skip.type = "button";
        skip.className = "xrc-flow-skip";
        skip.textContent = "跳过";
        skip.title = "只跳过本轮；未发送内容优先保存到 X 草稿，不标记已回复。";
        skip.addEventListener("click",() => closeForNext(s));
        const heart = document.createElement("button");
        heart.type = "button";
        heart.className = "xrc-flow-heart";
        heart.addEventListener("click",() => toggleHeart(s));
        const send = document.createElement("button");
        send.type = "button";
        send.className = "xrc-flow-send";
        send.setAttribute("aria-keyshortcuts","Alt+Enter");
        send.addEventListener("click",() => sendNext(s));
        const tools = document.createElement("div"); tools.className="xrc-reply-tools";
        const quickReplies = document.createElement("div");
        quickReplies.className = "xrc-quick-replies";
        quickReplies.setAttribute("role","group");
        quickReplies.setAttribute("aria-label","快捷填入，不自动发送");
        for (const [index,{ label,phrases }] of QUICK_REPLIES.entries()) {
          const button = document.createElement("button");
          button.type = "button";
          const caption=document.createElement("span"),key=document.createElement("kbd");
          caption.textContent=label;key.textContent=(/Mac/.test(globalThis.navigator?.platform || "")?"⌥":"Alt+")+(index+1);
          button.append(caption,key);button.setAttribute("aria-label",label);button.setAttribute("aria-keyshortcuts",`Alt+${index+1}`);
          button.className = "xrc-quick-reply";
          button.title = `随机填入：${phrases.join(" / ")}，末尾随机加标点；追加到草稿末尾，不自动发送。快捷键：Option/Alt+${index+1}。`;
          button.addEventListener("mousedown",event => event.preventDefault());
          button.addEventListener("click",() => fillQuickReply(s,phrases));
          quickReplies.append(button);
        }
        tools.append(quickReplies);
        let aiControl;
        if (aiRecommend) {
          const button=document.createElement("button");
          button.type="button";button.className="xrc-ai-recommend";
          const caption=document.createElement("span"),key=document.createElement("kbd");
          caption.className="xrc-ai-caption";caption.textContent="推荐评论";
          key.textContent=/Mac/.test(globalThis.navigator?.platform || "") ? "⌥Q" : "Alt+Q";
          button.append(caption,key);button.setAttribute("aria-busy","false");
          button.setAttribute("aria-label","推荐评论");button.setAttribute("aria-keyshortcuts","Alt+q");
          button.title="Mac：Option+Q；Windows：Alt+Q。点击或按快捷键生成一条并追加到草稿；等待时若继续编辑则不填入，不自动发送。";
          button.addEventListener("mousedown",event=>event.preventDefault());
          button.addEventListener("click",()=>{
            if (!currentSession(s) || !["ready","failed"].includes(s.phase) || draftBusy(s) ||
                s.current.quickPending || s.current.composing || !singleReply(dialog)) return;
            void aiRecommend(dialog.querySelector(EDITOR));
          });
          aiControl=button;
        }
        bar.append(tools,status);
        if (aiControl) bar.append(aiControl);
        bar.append(heart,skip,send);
      }
      if (nativeToolbar.nextElementSibling !== bar) nativeToolbar.after(bar);
      renderContext(s,bar);
      const editor = dialog.querySelector(EDITOR);
      if (renderAiOptions) renderAiOptions(bar.querySelector(".xrc-reply-tools"),editor);
      const phase = aiPhase(editor);
      const aiLabels={generating:"生成中…",polishing:"润色中…",rewriting:"改写中…",writing:"填入中…"};
      const aiButton=bar.querySelector(".xrc-ai-recommend");
      if (aiButton) {
        const caption=aiButton.querySelector(".xrc-ai-caption"),label=aiLabels[phase] || "推荐评论";
        if (caption.textContent!==label) caption.textContent=label;
        const active=String(Boolean(phase&&phase!=="paused"));
        if (aiButton.getAttribute("aria-busy")!==active) aiButton.setAttribute("aria-busy",active);
      }
      const busy = draftBusy(s) || s.current.quickPending === true;
      const source = s.feed === "home" ? (s.homeTabIndex === 1 ? "正在关注" : "为你推荐") :
        FEED_LABELS[s.feed];
      const statusText = `${source ? source+" · " : ""}已处理 ${s.handled.size} 条 · ${phase==="paused" ? (timedReplies?.isPaused?.()?"AI 自动填入已暂停，可手动推荐或继续本轮。":"AI 自动填入已暂停，可点击推荐评论。") : phase ? `AI ${aiLabels[phase]}请稍候` : busy ? "回复正在填入，完成后可继续。" : s.note}`;
      const status = bar.querySelector(".xrc-flow-status");
      if (status.textContent !== statusText) status.textContent = statusText;
      const active=String(Boolean(phase&&phase!=="paused"));
      if(status.dataset.aiActive!==active) status.dataset.aiActive=active;
      const canAct = ["ready","failed"].includes(s.phase);
      const native = nativeHeart(s);
      const heart = bar.querySelector(".xrc-flow-heart");
      const liked = native?.getAttribute("data-testid") === "unlike";
      const heartText = native ? liked ? "♥ 已点" : "♡ 点赞" : "♡ 不可用";
      if (heart.textContent !== heartText) heart.textContent = heartText;
      const pressed = String(liked);
      if (heart.getAttribute("aria-pressed") !== pressed) heart.setAttribute("aria-pressed",pressed);
      const heartDisabled = !canAct || !enabled(native);
      if (heart.disabled !== heartDisabled) heart.disabled = heartDisabled;
      const heartTitle = native ?
        `${liked ? "取消" : "给"}当前正在回复的这条帖子${liked ? "的点赞" : "点赞"}，不影响文字回复或下一条；结果以 X 原生状态为准。` :
        "当前帖子已移出列表或缺少原生红心控件，请关闭回复框后从列表重新打开。";
      if (heart.title !== heartTitle) heart.title = heartTitle;
      const skip = bar.querySelector(".xrc-flow-skip"), skipDisabled = !canAct || busy;
      if (skip.disabled !== skipDisabled) skip.disabled = skipDisabled;
      const send = bar.querySelector(".xrc-flow-send");
      const sendText = s.phase === "sent" ? "下一条" : s.phase === "liking" ? "点赞中…" : s.phase === "like-delay" ? (s.afterReply?.skipLike?"等待下一条…":"等待点赞…") : s.phase === "sending" ? "发送中…" : "评论点赞下条";
      if (send.textContent !== sendText) send.textContent = sendText;
      const single = singleReply(dialog);
      const quickDisabled = !canAct || busy || !single || s.current.composing === true ||
        !editor || editor.getAttribute("aria-disabled") === "true";
      for (const button of bar.querySelectorAll(".xrc-quick-reply,.xrc-ai-recommend")) {
        if (button.disabled !== quickDisabled) button.disabled = quickDisabled;
      }
      const sendDisabled = busy || (s.phase !== "sent" && (!canAct || !enabled(dialog.querySelector(SEND)) || !single));
      if (send.disabled !== sendDisabled) send.disabled = sendDisabled;
      const sendTitle = single ? "先发送评论，确认成功并保存后等待300～750ms，再点赞（已点不重复）；点赞确认保存后进入下一条。开启随机跳过点赞时，每次有50%概率仅停顿后进入下一条，不取消已有点赞。快捷键：Option/Alt+Enter（仅回复输入框）。" : "请先完成多条帖子编辑，再使用连续回复。";
      if (send.title !== sendTitle) send.title = sendTitle;
      timedReplies?.refresh();timedReplies?.render(s,bar);
    }

    function refresh() {
      if (!connected()) return;
      const s = session;
      if (interactionBlocked()) {if(s && s.phase!=="alert-paused")pauseForAlert();return;}
      if (!s) {void refreshCycle?.tick();return;}
      if (!currentSession(s)) { finish(); return; }
      const dialog = composer();
      if (s.phase === "closing") {
        if (s.current.autoSkippedVideo ? closeConfirmation() : saveDraftIfAsked(s)) return;
        if (!dialog) {
          if (s.hadDraft && !s.saveClicked) {
            s.phase = "draft-check";
            showNotice("未确认 X 是否保存了草稿，请核对后再继续。",{
              label:"已确认，继续下一条",run:() => advance(s)
            });
          } else void advance(s);
        }
        return;
      }
      if (s.phase === "advancing" || s.phase === "paused" || s.phase === "draft-check" || s.phase === "refreshing") return;
      if (dialog && !s.current.dialog) {
        if (s.feed === "detail") {
          const previewId = tweetId(dialog);
          if (previewId ? previewId !== s.current.id :
            !dialog.querySelector('[data-testid="tweetText"],[data-testid="tweetPhoto"],[data-testid="videoPlayer"],[data-testid="videoComponent"]')) return;
        }
        s.current.dialog = dialog;
        if (s.phase === "opening") { clearTimeout(s.timeout); s.phase = "ready"; }
      } else if (!dialog && s.current.dialog) {
        if (s.phase === "sent" && s.autoAdvance) { void advance(s); return; }
        if (["sending","uncertain","sent","like-delay","liking"].includes(s.phase)) {
          if (!notice) showNotice(s.note,{ label:s.phase === "sent" ? "下一条" : "结束连续回复",
            run:() => s.phase === "sent" ? advance(s) : finish() });
          return;
        }
        finish();
        return;
      } else if (dialog && s.current.dialog !== dialog) { finish(); return; }
      render(s);
    }

    async function receiveReply(data,saved) {
      if(interactionBlocked())return;
      const s = session;
      const attempt = s?.attempt;
      if (!s || !attempt || !currentSession(s) || data.account !== s.account ||
          data.parentId !== attempt.parentId || !Number.isFinite(data.startedAt) ||
          data.startedAt < attempt.clickedAt || typeof data.requestId !== "string" || data.requestId.length > 80) return;
      if (data.type === "REPLY_STARTED") {
        if (!attempt.requestId) attempt.requestId = data.requestId;
        return;
      }
      if (data.type !== "REPLY_RESULT" || !attempt.requestId || data.requestId !== attempt.requestId || attempt.settled) return;
      if (!["sent","failed","unknown"].includes(data.status)) return;
      if (data.status !== "sent") {
        clearTimeout(s.timeout);
        attempt.settled = true;
        s.phase = data.status === "failed" ? "failed" : "uncertain";
        timedReplies?.stop("发送失败或结果不明，本轮已结束");
        s.note = s.phase === "failed" ? "发送失败，内容留在原处；可修改后重试。" : "发送结果未确认，请先核对；不会自动重发。";
        render(s);
        if (!composer()) showNotice(s.note,{ label:"结束连续回复",run:() => finish() });
        return;
      }
      const tweet = data.batch?.tweets?.[0];
      const user = data.batch?.users?.[0];
      if (!tweet || tweet.parentId !== s.current.id || !user || user.handle !== s.account || tweet.authorId !== user.id) return;
      if (!saved) return;
      clearTimeout(s.timeout);
      attempt.settled = true;
      const autoAdvance = s.phase === "sending";
      // Persist before filtering the next cards, so the same conversation is skipped correctly.
      try {
        await saved;
        if (!currentSession(s) || s.attempt !== attempt) return;
        refreshCycle?.record(s,tweet.id);
        if (autoAdvance && s.afterReply && !s.afterReply.cancelled) {
          waitThenLike(s,s.afterReply);
        } else {
          s.phase = "sent";s.autoAdvance = false;
          s.note = "已确认发送成功，后续点赞已停止；点击下一条继续。";
          clearNotice();refresh();
        }
      } catch {
        if (session !== s) return;
        s.phase = "uncertain";
        timedReplies?.stop("回复记录保存失败，本轮已结束");
        s.note = "回复已发送，但本地记录未保存。请勿重复发送，刷新 X 后继续。";
        render(s);
        if (!composer()) showNotice(s.note,{ label:"结束连续回复",run:() => finish() });
      }
    }

    document.addEventListener("click",event => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if(!internalTimedSend && target?.closest('[data-testid="tweetButton"],.xrc-flow-skip'))timedReplies?.stop("已转为手动操作");
      const tab = target?.closest('[role="tab"]');
      if (tab && session?.feed === "home") {
        const tabs = Array.from(feedColumn(session)?.querySelectorAll('[role="tab"]') || []);
        if (tabs.includes(tab) && tab !== tabs[session.homeTabIndex]) finish();
      }
      if (tab && session?.feed === "search" && feedColumn(session)?.contains(tab) &&
          searchKey(tab.getAttribute("href")) !== session.searchKey) finish();
      if (tab && session?.feed === "profile" && feedColumn(session)?.contains(tab) &&
          tabPath(tab) !== session.profile.path) finish();
      if (postReplyPhase(session) && !internalHeart &&
          (target?.closest('[data-testid="like"],[data-testid="unlike"]') ||
           target?.closest(COMPOSER) && session.current.dialog?.contains(target) && !target.closest(".xrc-flow-send"))) {
        stopAfterReply(session,"评论已发送，你已进行其他操作；后续点赞和跳转停止。");
      }
      const close = target?.closest(CLOSE);
      if (close && session && !internalClose && close.closest(COMPOSER) === composer()) { finish(); return; }
      const reply = target?.closest('[data-testid="reply"]');
      const article = reply?.closest('article[data-testid="tweet"]');
      if (!article) return;
      const feed = entryFeed(article);
      if (!feed) return;
      if (openingId && tweetId(article) === openingId) return;
      start(article,feed);
    },true);
    document.addEventListener("visibilitychange",()=>{
      if (document.hidden && session?.phase!=="refreshing") stopAfterReply(session,"评论已发送，页面已切到后台；后续操作停止。");
    });
    window.addEventListener("pagehide",()=>{if(session?.afterReply && session.phase!=="refreshing")finish();});
    window.addEventListener("blur",()=>{
      if(session?.afterReply?.timed && session.phase!=="refreshing" && !timedPageAllowed())stopAfterReply(session,"页面失去焦点，定时触发的后续操作已停止。");
    });
    document.addEventListener("input",event => {
      if (session?.current.dialog?.contains(event.target)) {
        // X clears its editor after success; a new nonempty draft cancels the remaining steps.
        if (event.isTrusted || session.current.dialog.querySelector(EDITOR)?.innerText.trim()) {
          stopAfterReply(session,"评论已发送，编辑内容已变化；后续操作停止。");
        }
        requestRefresh();
      }
    });
    for (const name of ["compositionstart","compositionend"]) {
      document.addEventListener(name,event => {
        if (session?.current.dialog?.contains(event.target)) {
          session.current.composing = name === "compositionstart";
          if (session.current.composing) stopAfterReply(session,"评论已发送，正在编辑新内容；后续操作停止。");
          requestRefresh();
        }
      });
    }
    const shortcutModifier = event => event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    window.addEventListener("keydown",event => {
      if(event.key==="Enter"&&(event.ctrlKey||event.metaKey))timedReplies?.stop("已转为手动发送");
      const s=session;
      if (!s || event.key!=="Enter" || !shortcutModifier(event) || event.isComposing || event.keyCode===229) return;
      const dialog=s.current.dialog;
      const transitioning=!["ready","failed","sent"].includes(s.phase) || Boolean(s.attempt && !dialog?.isConnected);
      let inBurst=false;
      if (!event.repeat && isRecommended(s) && aiFillRecommendedEnabled()) {
        const now=performance.now();
        inBurst=now-lastSendKeyAt<SEND_KEY_GAP_MS;
        lastSendKeyAt=now;
      }
      // The native list regains focus before the next editor opens. Consume the
      // shortcut at window capture so it cannot reach X's timeline listeners.
      if (transitioning) {
        event.preventDefault();event.stopImmediatePropagation();
        return;
      }
      const editor=event.target instanceof Element ? event.target.closest(EDITOR) : null;
      if (!editor || !dialog?.contains(editor) || !currentSession(s) || s.current.composing) return;
      const button=dialog.querySelector(".xrc-flow-send");
      if (!button) return;
      event.preventDefault();event.stopImmediatePropagation();
      if (!event.repeat && !inBurst && !button.disabled) button.click();
    },true);
    document.addEventListener("keydown",event => {
      const modified=shortcutModifier(event);
      const recommendKey = modified && (event.code === "KeyQ" || event.key.toLowerCase() === "q");
      const digit = modified ? event.code.match(/^Digit([1-6])$/)?.[1] || event.key.match(/^[1-6]$/)?.[0] : "";
      const nativeSend = event.key==="Enter" && (event.ctrlKey || event.metaKey) && postReplyPhase(session);
      if (!recommendKey && !digit && !nativeSend && event.key !== "Tab" && event.key !== "Escape") return;
      const editor = event.target instanceof Element ? event.target.closest(EDITOR) : null;
      if (nativeSend && editor && session.current.dialog?.contains(editor)) {
        stopAfterReply(session,"已转为原生操作，停止后续点赞与跳转。");return;
      }
      if ((recommendKey || digit) && session && editor && session.current.dialog?.contains(editor) && currentSession(session)) {
        if (event.isComposing || event.keyCode === 229 || session.current.composing) return;
        const button = recommendKey ? session.current.dialog.querySelector(".xrc-ai-recommend") :
          session.current.dialog.querySelectorAll(".xrc-quick-reply")[Number(digit)-1];
        if (!button) return;
        event.preventDefault();event.stopImmediatePropagation();
        if (!event.repeat && !button.disabled) button.click();
        return;
      }
      if (event.key === "Tab" && !event.altKey && session && editor && session.current.dialog?.contains(editor)) {
        const suggestion = editor.closest(".DraftEditor-root")?.querySelector("#xreply-ghost")?.dataset.suggestion;
        if (suggestion) {
          // XReply can retarget its unfinished typing to a new editor; wait for this draft to finish.
          session.current.fillingText = editor.innerText.replace(/\n$/,"") + suggestion;
          render(session);
        }
      }
      if (event.key === "Escape" && !event.isComposing && session) {
        const s = session;
        requestAnimationFrame(() => { if (session === s && !composer()) finish(); });
      }
    },true);
    return { refresh,canAutoFillUnfocused,timedState,timedSend,cancelTimedFollowup,pauseForAlert,receiveReply,receiveLike,resumeRecommended,replyPostId,replyArticle,rootOwnership,recommendedReply,skipVideo,notify:text=>showNotice(text,null,true),stop:finish,invalidateContext:() => { contextRevision++; } };
  }

  globalThis.XReplyContinuous = { create,authorFromPostLink };
})();
