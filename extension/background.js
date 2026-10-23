importScripts("core.js");
const core = globalThis.XReplyContext;
const storageKey = "replyContext";
let state;
let queue = Promise.resolve();

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
    const saved = (await chrome.storage.local.get(storageKey))[storageKey];
    state = saved?.version === 1 ? saved : core.createState();
    if (!state.people || Object.values(state.people).some(person =>
      typeof person.myCommentedPosts !== "number" || typeof person.theirCommentedPosts !== "number" ||
      typeof person.firstCommentOnMyPostId !== "string")) {
      core.ingest(state,{},"");
      await chrome.storage.local.set({ [storageKey]:state });
    }
  }
  const account = core.handle(message.account);
  if (message.type === "INGEST") {
    core.ingest(state,message.batch,account);
    await chrome.storage.local.set({ [storageKey]: state });
    return { ok:true };
  }
  if (message.type === "CLASSIFY" || message.type === "SUMMARY") {
    const me = core.findAccount(state,account);
    if (me && !state.accounts[me.id]) {
      core.ingest(state,{},account);
      await chrome.storage.local.set({ [storageKey]: state });
    }
    const rows = message.type === "CLASSIFY" && Array.isArray(message.ids) ?
      core.classifyBatch(state,account,message.ids) : [];
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
  const work = queue.then(() => handleMessage(message));
  queue = work.catch(() => {});
  work.then(sendResponse, () => sendResponse({ ok:false, error:"本地记录暂时不可用，请刷新 X 页面后重试。" }));
  return true;
});
