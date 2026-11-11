importScripts("core.js","interaction-ledger.js","storage.js","ai-config.js","ai-context.js","ai-service.js","companion.js","timed-replies.js","refresh-cycle.js","post-video.js","video-download.js","reply-skip-authors.js","interaction-report-data.js");
let aiService;
let companion;
let refreshCycle;
let videoDownload;
let saveSkippedAuthor;
let saveWhitelistedAuthor;
const AWAKE_KEY = "timedAwakeTabs";
const AWAKE_ALARM = "timedAwakeCleanup";
let awakeQueue = Promise.resolve();
let awakeTimer;
let awakeTabs;
function refreshCycles() {return refreshCycle ||= globalThis.XReplyRefreshCycle.createBackground(chrome);}
chrome.tabs?.onRemoved?.addListener(id=>{
  if (chrome.power && chrome.alarms) void updateAwake(tabs=>{for(const [key,lease] of Object.entries(tabs))if(lease.tabId===id)delete tabs[key];}).catch(()=>{});
  void refreshCycles().removed(id).catch(()=>{});
});
chrome.alarms?.onAlarm.addListener(alarm=>{
  if (alarm.name===AWAKE_ALARM) void updateAwake().catch(()=>{});
});
function companionWindow() {
  return companion ||= globalThis.XReplyCompanion.create(chrome);
}
chrome.windows?.onRemoved.addListener(id => {
  void companionWindow().removed(id).catch(() => {});
});
const core = globalThis.XReplyContext;
const storage = globalThis.XReplyStorage.create();
const reportMessages = new Set(["INTERACTION_REPORT","INTERACTION_REPORT_SET_SKIP","INTERACTION_REPORT_SET_WHITELIST"]);
let state;
const urgent = [];
const ordinary = [];
let draining = false;
let urgentRun = 0;
let savedRevision = "";
let revision = 0;
let revisionPending = false;
let savePending = false;

function cachedThread(postId,account) {
  const post = state?.tweets[postId];
  if (!post) return {};
  const directParent = post.parentId !== postId ? state.tweets[post.parentId] : null;
  const parent = post.parentId !== post.conversationId ? directParent : null;
  const root = post.conversationId !== postId ? state.tweets[post.conversationId] : null;
  const me = core.findOwnAccount(state,account);
  function role(authorId) {
    if (!me || !authorId) return "";
    if (authorId === me.id) return "我";
    return authorId === post.authorId ? "对方" : "第三人";
  }
  const standalone = post.conversationId === postId && !post.parentId && !post.recipientId;
  return {
    parent:parent?.text,root:root?.text,
    postAuthor:role(post.authorId),
    replyTo:standalone ? "无特定对象" : role(post.recipientId || directParent?.authorId || state.roots?.[post.parentId]?.authorId),
    parentAuthor:role(parent?.authorId),
    rootAuthor:role(root?.authorId || state.roots?.[post.conversationId]?.authorId)
  };
}

async function persist(changed = true) {
  revisionPending ||= changed;
  savePending = true;
  const result=await storage.save(state);
  savePending = false;
  revisionPending ||= result?.statsChanged===true;
  if (!revisionPending) return false;
  savedRevision = `${Date.now()}:${++revision}`;
  try { await chrome.storage.local.set({ replyContextRevision:savedRevision }); revisionPending = false; }
  catch { console.warn("回过了：记录已保存，其他标签页的更新通知暂未送达。"); }
  return true;
}

function allowedSender(sender) {
  try {
    const url = new URL(sender.url);
    return sender.id === chrome.runtime.id &&
      ((url.protocol === "https:" && ["x.com","twitter.com"].includes(url.hostname)) ||
       url.origin === new URL(chrome.runtime.getURL("/")).origin);
  } catch { return false; }
}

function updateAwake(change=()=>{}) {
  const result=awakeQueue.then(async()=>{
    if (!awakeTabs) {
      const saved=(await chrome.storage.session.get(AWAKE_KEY))[AWAKE_KEY] || {};
      // Migrate the previous per-tab leases once; a late old document owns only its own lease.
      awakeTabs=Object.fromEntries(Object.entries(saved).map(([key,lease])=>{
        const tabId=lease.tabId ?? Number(key);
        return [`${tabId}:${lease.documentId}`,{...lease,tabId}];
      }));
    }
    const next={...awakeTabs};
    change(next);
    const now=Date.now();
    for (const [tabId,lease] of Object.entries(next)) {
      if (lease.expiresAt<=now) delete next[tabId];
    }
    const leases=Object.values(next);
    if (leases.length) {
      // The browser alarm survives a worker restart. Register it before acquiring the lock.
      if (!await chrome.alarms.get(AWAKE_ALARM)) await chrome.alarms.create(AWAKE_ALARM,{periodInMinutes:1});
      await chrome.storage.session.set({[AWAKE_KEY]:next});
      if (!Object.keys(awakeTabs).length) chrome.power.requestKeepAwake("system");
      const expiresAt=Math.min(...leases.map(lease=>lease.expiresAt));
      clearTimeout(awakeTimer);
      awakeTimer=setTimeout(()=>{void updateAwake().catch(()=>{});},Math.max(0,expiresAt-Date.now()));
    } else {
      chrome.power.releaseKeepAwake();
      clearTimeout(awakeTimer);
      await chrome.storage.session.remove(AWAKE_KEY);
      await chrome.alarms.clear(AWAKE_ALARM);
    }
    awakeTabs=next;
  });
  awakeQueue=result.catch(()=>{});
  return result;
}

async function keepAwake(until,sender) {
  const tabId=sender.tab?.id,documentId=sender.documentId;
  if (!chrome.power || !chrome.alarms || !Number.isInteger(tabId) || sender.frameId!==0 || (typeof documentId!=="string" || !documentId || documentId.length>128) ||
      !["https://x.com","https://twitter.com"].includes(new URL(sender.url).origin)) return false;
  if (!Number.isFinite(until) || until<0) return false;
  const key=`${tabId}:${documentId}`;
  await updateAwake(tabs=>{
    if (until===0) {
      delete tabs[key];
    } else if (until>Date.now()) {
      tabs[key]={tabId,documentId,expiresAt:Math.min(until,Date.now()+20000)};
    }
  });
  return true;
}

function writeSkipAuthor({account,author,skipped}) {
  saveSkippedAuthor ||= globalThis.XReplySkipAuthors.createWriter(chrome.storage);
  return saveSkippedAuthor(account,author,skipped);
}

async function writeWhitelistAuthor(accountId,peerId,whitelisted) {
  const lists = globalThis.XReplySkipAuthors;
  saveWhitelistedAuthor ||= lists.createWriter(chrome.storage,lists.WHITELIST_KEY);
  try { return await saveWhitelistedAuthor(accountId,peerId,whitelisted); }
  catch { return {ok:false,error:"白名单未保存，请重试。"}; }
}

function setPostAuthorWhitelist(message,account) {
  const me = core.findOwnAccount(state,account);
  const postId = core.id(message.postId);
  const peerId = core.id(message.peerId);
  if (!me || me.id !== core.id(message.accountId) || !peerId || state.tweets[postId]?.authorId !== peerId) {
    return {ok:false,error:"当前账号或帖子作者尚未确认，请稍后再试。"};
  }
  return writeWhitelistAuthor(me.id,peerId,message.whitelisted);
}

async function handleInteractionReport(message,account) {
  const me = core.findOwnAccount(state,account);
  if (!me || me.id !== core.id(message.accountId)) {
    return {ok:false,error:"当前报表账号无法确认，请从该账号的 X 页面重新打开。"};
  }
  if (savePending) await persist();
  const lists = globalThis.XReplySkipAuthors;
  if (message.type === "INTERACTION_REPORT") {
    const authors = await lists.readLists(chrome.storage,account,me.id);
    return {ok:true,...globalThis.XReplyInteractionReport.page(state,me,authors,message)};
  }
  const whitelist = message.type === "INTERACTION_REPORT_SET_WHITELIST";
  const included = whitelist ? message.whitelisted : message.skipped;
  const author = core.handle(message.author);
  const peerId = core.id(message.peerId);
  if (included === true && (!peerId || core.findAccount(state,author)?.id !== peerId ||
      !Object.hasOwn(state.people,`${me.id}:${peerId}`))) {
    return {ok:false,error:"作者账号已变化或无法确认，请刷新报表后重试。"};
  }
  if (whitelist) return writeWhitelistAuthor(me.id,peerId,included);
  try { return await writeSkipAuthor({account,author,skipped:included}); }
  catch { return {ok:false,error:"名单未保存，请重试。"}; }
}

async function recordObserved(account,batch) {
  const changed = await persist(core.ingest(state,batch,account));
  return {ok:true,revision:savedRevision,changed};
}

function recordReplyEvidence(message,account) {
  const me = core.findOwnAccount(state,account);
  const reply = message.reply;
  const replyId = core.id(reply?.id);
  const parentId = core.id(message.parentId);
  if (!me || !replyId || !parentId || replyId === parentId || reply.authorId !== me.id || reply.parentId !== parentId) {
    return {ok:true,changed:false};
  }
  const conversationId = core.id(reply.conversationId);
  const recipientId = core.id(reply.recipientId);
  const previous = state.tweets[replyId];
  const parent = state.tweets[parentId];
  if (conversationId === replyId ||
      previous && (previous.authorId !== me.id || previous.parentId && previous.parentId !== parentId ||
        conversationId && previous.conversationId && previous.conversationId !== conversationId) ||
      parent && (conversationId && parent.conversationId && parent.conversationId !== conversationId ||
        recipientId && parent.authorId !== recipientId)) {
    return {ok:true,changed:false};
  }
  return recordObserved(account,{tweets:[{id:replyId,authorId:me.id,parentId,conversationId,recipientId,text:reply.text}]});
}

async function handleMessage(message) {
  if (!state) {
    state = await storage.load();
    core.prepare(state);
    if (!state.statistics && (!state.people || Object.values(state.people).some(person =>
      typeof person.myCommentedPosts !== "number" || typeof person.theirCommentedPosts !== "number" ||
      typeof person.firstCommentOnMyPostId !== "string"))) {
      core.ingest(state,{},"");
      await persist();
    }
  }
  const account = core.handle(message.account);
  if (message.type === "INGEST") return recordObserved(account,message.batch);
  if (message.type === "RECORD_REPLY_EVIDENCE") return recordReplyEvidence(message,account);
  if (message.type === "SET_REPLY_WHITELIST_AUTHOR") return setPostAuthorWhitelist(message,account);
  if (reportMessages.has(message.type)) return handleInteractionReport(message,account);
  if (["PERSON_STATS","CLASSIFY","SUMMARY"].includes(message.type)) {
    const me = core.findOwnAccount(state,account);
    const registering = Boolean(me && !state.accounts[me.id]);
    if (registering) core.ingest(state,{},account);
    if (registering || savePending) await persist(registering);
    if (message.type === "PERSON_STATS") return { ok:true,accountId:me?.id || "",rows:core.personStatsBatch(state,account,message.authors) };
    const rows = message.type === "CLASSIFY" && Array.isArray(message.ids) ?
      core.classifyBatch(state,account,message.ids,message.authorHint) : [];
    if (message.includeRootText === true) {
      for (const row of rows) row.rootText = state.tweets[row.rootId]?.text || "";
    }
    if (message.type === "CLASSIFY") return { ok:true,rows,account,accountId:me?.id || "",recognized:Boolean(me) };
    return {
      ok:true, rows, account, accountId:me?.id || "", recognized:Boolean(me),statistics:state.statistics || null,
      interactionLimit:core.INTERACTION_LIMIT,
      replyCount: me ? Object.values(state.replies).filter(reply => reply.actorId === me.id).length : 0,
      likeCount: me ? Object.values(state.likes || {}).filter(like => like.actorId === me.id && like.liked).length : 0
    };
  }
  return { ok:false, error:"不支持的操作" };
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (!allowedSender(sender) || !message || typeof message !== "object") return false;
  if (reportMessages.has(message.type) && sender.url.split(/[?#]/,1)[0] !== chrome.runtime.getURL("interaction-report.html")) return false;
  if ((message.type === "RECORD_REPLY_EVIDENCE" || message.type === "SET_REPLY_WHITELIST_AUTHOR") &&
      (sender.frameId !== 0 || !["https://x.com","https://twitter.com"].includes(new URL(sender.url).origin))) return false;
  if (message.type === "SET_REPLY_SKIP_AUTHOR") {
    void writeSkipAuthor(message).then(sendResponse,() => sendResponse({ ok:false,error:"跳过名单未保存，请重试。" }));
    return true;
  }
  if (message.type === "DOWNLOAD_POST_VIDEO") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) return false;
    videoDownload ||= globalThis.XReplyVideoDownload.create(chrome);
    void videoDownload.download(message).then(sendResponse,() => sendResponse({ ok:false,error:"暂时无法下载，请重试。" }));
    return true;
  }
  if (message.type === "TIMED_KEEP_AWAKE") {
    void keepAwake(message.until,sender).then(ok=>sendResponse({ok}),()=>sendResponse({ok:false}));
    return true;
  }
  if (["REFRESH_ARM","REFRESH_TAKE","REFRESH_CANCEL"].includes(message.type)) {
    void refreshCycles().handle(message,sender).then(sendResponse,()=>sendResponse({ok:false,error:"自动换批状态暂不可用。"}));
    return true;
  }
  if (message.type === "COMPANION_OPEN") {
    void companionWindow().open(message,sender).then(sendResponse);
    return true;
  }
  if (typeof message.type === "string" && message.type.startsWith("AI_")) {
    aiService ||= globalThis.XReplyAIService.create({ readThread:cachedThread });
    void aiService.handle(message,sender).then(sendResponse,() => sendResponse({ok:false,error:"AI 配置或服务暂不可用，请检查设置。"}));
    return true;
  }
  const priority = message.type === "INGEST" && message.interaction === true ||
    message.type === "RECORD_REPLY_EVIDENCE" || message.type === "CLASSIFY";
  (priority ? urgent : ordinary).push({ message,sendResponse });
  void drain();
  return true;
});

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (urgent.length || ordinary.length) {
      // Bootstrap account evidence before prioritizing a receipt that only contains a tweet ID.
      const next = urgent[0];
      const needsAccount = next && ordinary.length && (!state || !core.findOwnAccount(state,next.message.account));
      const takeUrgent = urgent.length && (!ordinary.length || (!needsAccount && urgentRun < 8));
      const task = (takeUrgent ? urgent : ordinary).shift();
      urgentRun = takeUrgent ? urgentRun+1 : 0;
      try { task.sendResponse(await handleMessage(task.message)); }
      catch { task.sendResponse({ ok:false,error:"本地记录暂时不可用，请刷新 X 页面后重试。" }); }
      // Let the receipt's UI request arrive before starting another background write.
      if (!urgent.length && ordinary.length) await new Promise(resolve => setTimeout(resolve,0));
    }
  } finally { draining = false; }
}
