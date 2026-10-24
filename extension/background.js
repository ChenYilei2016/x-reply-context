importScripts("core.js","storage.js","ai-config.js","ai-service.js");
let aiService;
const core = globalThis.XReplyContext;
const storage = globalThis.XReplyStorage.create();
let state;
const urgent = [];
const ordinary = [];
let draining = false;
let urgentRun = 0;
let savedRevision = "";
let revision = 0;

async function persist() {
  await storage.save(state);
  savedRevision = `${Date.now()}:${++revision}`;
  try { await chrome.storage.local.set({ replyContextRevision:savedRevision }); }
  catch { console.warn("回过了：记录已保存，其他标签页的更新通知暂未送达。"); }
}

function allowedSender(sender) {
  try {
    const url = new URL(sender.url);
    return sender.id === chrome.runtime.id &&
      ((url.protocol === "https:" && ["x.com","twitter.com"].includes(url.hostname)) ||
       url.origin === new URL(chrome.runtime.getURL("/")).origin);
  } catch { return false; }
}

async function handleMessage(message) {
  if (!state) {
    state = await storage.load();
    core.prepare(state);
    if (!state.people || Object.values(state.people).some(person =>
      typeof person.myCommentedPosts !== "number" || typeof person.theirCommentedPosts !== "number" ||
      typeof person.firstCommentOnMyPostId !== "string")) {
      core.ingest(state,{},"");
      await persist();
    }
  }
  const account = core.handle(message.account);
  if (message.type === "INGEST") {
    core.ingest(state,message.batch,account);
    await persist();
    return { ok:true,revision:savedRevision };
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
      ok:true, rows, account, recognized:Boolean(me),
      replyCount: me ? Object.values(state.replies).filter(reply => reply.actorId === me.id).length : 0,
      likeCount: me ? Object.values(state.likes || {}).filter(like => like.actorId === me.id && like.liked).length : 0
    };
  }
  return { ok:false, error:"不支持的操作" };
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (!allowedSender(sender) || !message || typeof message !== "object") return false;
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
