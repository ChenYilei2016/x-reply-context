importScripts("core.js","interaction-ledger.js","storage.js","ai-config.js","ai-service.js","companion.js","timed-replies.js","refresh-cycle.js");
let aiService;
let companion;
let refreshCycle;
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
let state;
const urgent = [];
const ordinary = [];
let draining = false;
let urgentRun = 0;
let savedRevision = "";
let revision = 0;
let revisionPending = false;

async function persist(changed = true) {
  revisionPending ||= changed;
  const result=await storage.save(state);
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
  if (message.type === "INGEST") {
    const changed = await persist(core.ingest(state,message.batch,account));
    return { ok:true,revision:savedRevision,changed };
  }
  if (message.type === "CLASSIFY" || message.type === "SUMMARY") {
    const me = core.findAccount(state,account);
    if (me && !state.accounts[me.id]) {
      core.ingest(state,{},account);
      await persist();
    }
    const rows = message.type === "CLASSIFY" && Array.isArray(message.ids) ?
      core.classifyBatch(state,account,message.ids) : [];
    if (message.includeRootText === true) {
      for (const row of rows) row.rootText = state.tweets[row.rootId]?.text || "";
    }
    if (message.type === "CLASSIFY") return { ok:true,rows,account,recognized:Boolean(me) };
    return {
      ok:true, rows, account, recognized:Boolean(me),statistics:state.statistics || null,
      replyCount: me ? Object.values(state.replies).filter(reply => reply.actorId === me.id).length : 0,
      likeCount: me ? Object.values(state.likes || {}).filter(like => like.actorId === me.id && like.liked).length : 0
    };
  }
  return { ok:false, error:"不支持的操作" };
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (!allowedSender(sender) || !message || typeof message !== "object") return false;
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
    aiService ||= globalThis.XReplyAIService.create();
    void aiService.handle(message,sender).then(sendResponse,() => sendResponse({ok:false,error:"AI 配置或服务暂不可用，请检查设置。"}));
    return true;
  }
  const priority = message.type === "INGEST" && message.interaction === true || message.type === "CLASSIFY";
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
      const needsAccount = next && ordinary.length && (!state || !core.findAccount(state,next.message.account));
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
