import { users, demoTweets, homeTweets, post } from "./fixtures.mjs";
import { checkLayout } from "./layout-check.mjs";
import { checkHeights } from "./height-check.mjs";
import { checkHearts } from "./heart-check.mjs";
import { checkNotificationFilter } from "./notification-filter-check.mjs";
import { checkNotificationStability } from "./notification-stability-check.mjs";
import { installComposerDemo } from "./composer-demo.mjs";
const core = globalThis.XReplyContext;
const state = core.createState();
const home = location.pathname === "/home";
core.ingest(state,{ users,tweets:demoTweets },"my_account");
if (home) core.ingest(state,{ users,tweets:homeTweets,likes:[{
  id:homeTweets[3].id,liked:true,account:"my_account",observedAt:Date.now()
}] },"my_account");
core.ingest(state,{ likes:[demoTweets[1].id,demoTweets[8].id].map(id => ({
  id,liked:true,account:"my_account",observedAt:Date.now()
})) },"my_account");
const storageListeners = [];
const replyWrites = new Map();
const settings = { hideCompletedHome:false,hideCompletedNotifications:false };
let pauseClassification = false;
let releaseClassification;
globalThis.chrome = {
  runtime:{
    onMessage:{ addListener() {} },
    async sendMessage(message) {
      if (message.type === "INGEST") {
        core.ingest(state,message.batch,message.account);
        for (const tweet of message.batch.tweets || []) {
          if (tweet.authorId === "101" && tweet.parentId) replyWrites.set(tweet.id,(replyWrites.get(tweet.id) || 0)+1);
        }
        document.querySelector("#composer-evidence").dataset.replyWrites = JSON.stringify(Object.fromEntries(replyWrites));
        document.querySelector("#composer-evidence").dataset.homeRecords = JSON.stringify(
          homeTweets.map(tweet => core.classify(state,message.account,tweet.id)));
        document.querySelector("#composer-evidence").dataset.likeRecords = JSON.stringify(state.likes);
        for (const listener of storageListeners) listener({ replyContext:{} },"local");
        return { ok:true };
      }
      if (message.type === "CLASSIFY") {
        const snapshot = {
          ok:true,rows:message.ids.map(id => core.classify(state,message.account,id)),
          replyCount:Object.keys(state.replies).length,
          likeCount:Object.values(state.likes).filter(like => like.liked).length
        };
        if (pauseClassification) {
          pauseClassification = false;
          await new Promise(resolve => { releaseClassification = resolve; });
        }
        return snapshot;
      }
      return { ok:true };
    }
  },
  storage:{
    local:{
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key,settings[key]]));
      },
      async set(values) {
        if (document.querySelector("#demo-settings-fail")?.checked) throw new Error("模拟设置保存失败");
        const changes = {};
        for (const [key,newValue] of Object.entries(values)) {
          changes[key] = { oldValue:settings[key],newValue };
          settings[key] = newValue;
        }
        for (const listener of storageListeners) listener(changes,"local");
      }
    },
    onChanged:{ addListener:listener => storageListeners.push(listener) }
  }
};

const timeline = document.querySelector("#timeline");
function addNotification(tweet,prepend = false) {
  if (timeline.querySelector(`[data-demo-id="${tweet.id}"]`)) return;
  const author = users.find(user => user.id === tweet.authorId);
  const article = document.createElement("article");
  article.dataset.testid = "tweet";
  article.dataset.demoId = tweet.id;
  // Only fixed local fixture values are inserted into this demonstration document.
  article.innerHTML = `
    <div class="avatar">${author.handle[0].toUpperCase()}</div>
    <div class="body">
      <div class="user"><strong>${author.handle[0].toUpperCase() + author.handle.slice(1)}</strong>
        <span class="muted">@${author.handle}</span><span class="muted">·</span>
        <a href="/${author.handle}/status/${tweet.id}"><time>2 分钟</time></a></div>
      ${tweet.parentId ? '<div class="replying">回复 <a href="/my_account">@my_account</a></div>' : ''}
      <div class="text-shell"><div data-testid="tweetText">${tweet.text}</div></div>
      <div class="actions-shell"><div role="group" class="actions"><button type="button" data-testid="reply" aria-label="回复 ${author.handle}">回复</button><button type="button" data-testid="${state.likes[`101:${tweet.id}`]?.liked ? 'unlike' : 'like'}" aria-label="红心 ${author.handle}">${state.likes[`101:${tweet.id}`]?.liked ? '♥' : '♡'} 1</button><span>↗</span><span>▥ 12</span></div></div>
    </div>`;
  if (prepend) timeline.prepend(article); else timeline.append(article);
  return article;
}
if (home) {
  document.querySelector("h1").textContent = "主页";
  document.querySelector(".tabs").innerHTML = '<div role="tab" aria-selected="true" tabindex="0">为你推荐</div><div role="tab" aria-selected="false" tabindex="-1">正在关注</div>';
  document.querySelectorAll('.tabs [role="tab"]').forEach(tab => tab.addEventListener("click",() => {
    document.querySelectorAll('.tabs [role="tab"]').forEach(item => item.setAttribute("aria-selected",String(item === tab)));
  }));
  homeTweets.forEach(tweet => addNotification(tweet));
  const button = document.createElement("button");
  button.id = "home-to-notifications";
  button.textContent = "查看主页评论后的通知";
  button.addEventListener("click",() => {
    const rootId = homeTweets[2].id;
    const reply = state.replies[`101:${rootId}:505`];
    if (!reply) { document.querySelector("#simulation-status").textContent = "请先回复 Carol 的主页原帖。"; return; }
    const incoming = post("2112500000000050003","505",rootId,reply.id,"101","谢谢你的评论，这是主页评论后的新通知。");
    core.ingest(state,{ tweets:[incoming] },"my_account");
    timeline.replaceChildren();
    document.querySelector(".tabs").innerHTML = '<a role="tab" href="/notifications" aria-selected="true">全部</a>';
    document.querySelector("h1").textContent = "通知";
    history.replaceState(null,"","/notifications");
    addNotification(incoming);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  document.querySelector(".aside").append(button);
} else {
  for (const index of [11,3,7,4,8,10]) addNotification(demoTweets[index]);
  const aggregate = document.createElement("article");
  aggregate.dataset.testid = "notification";
  aggregate.textContent = "虚构用户点赞了你的帖子（聚合通知）";
  timeline.prepend(aggregate);
}
installComposerDemo({ state,core,addNotification });
await import("/extension/observe.js");
await import("/extension/card-filter.js");
await import("/extension/home-filter.js");
await import("/extension/notification-filter.js");
await import("/extension/continuous.js");
const script = document.createElement("script");
script.src = "/extension/content.js";
document.body.append(script);
document.querySelector("#demo-hide-completed").addEventListener("change",event => {
  void chrome.storage.local.set({ hideCompletedHome:event.target.checked });
});
document.querySelector("#simulate").addEventListener("click",event => {
  core.ingest(state,{ tweets:[
    post("2112500000000000014","101","2112500000000000001","2112500000000000013","505","欢迎来交流！")
  ] },"my_account");
  for (const listener of storageListeners) listener({ replyContext:{} },"local");
  event.target.disabled = true;
  document.querySelector("#simulation-status").textContent = "已在自己的原帖回复 Carol：文字变为已回；我评他仍为 0、他评我仍为 1，首次评论的 NEW 保留。";
});
let bobLiked = false;
document.querySelector("#simulate-heart").addEventListener("click",event => {
  bobLiked = !bobLiked;
  core.ingest(state,{ likes:[{
    id:demoTweets[4].id,liked:bobLiked,account:"my_account",observedAt:Date.now(),source:"mutation"
  }] },"my_account");
  for (const listener of storageListeners) listener({ replyContext:{} },"local");
  event.target.textContent = bobLiked ? "演示：取消 Bob 的红心" : "演示：给 Bob 点红心";
  document.querySelector("#simulation-status").textContent = bobLiked ?
    "点赞成功：只更新红心，不改变文字回复。可以再点按钮验证取消。" :
    "取消点赞成功：这条红心记录已撤销，文字回复保持不变。";
});
let layoutReplySequence = 0;
document.querySelector("#check-layout").addEventListener("click",async event => {
  event.target.disabled = true;
  await checkLayout(() => {
    const rootId = String(2112500000000080000n + BigInt(++layoutReplySequence * 2));
    const replyId = String(BigInt(rootId) + 1n);
    core.ingest(state,{ tweets:[
      post(rootId,"505",rootId),post(replyId,"101",rootId,rootId,"505")
    ],likes:[{
      id:demoTweets[11].id,liked:!state.likes[`101:${demoTweets[11].id}`]?.liked,
      account:"my_account",observedAt:Date.now(),source:"mutation"
    }] },"my_account");
    for (const listener of storageListeners) listener({ replyContext:{} },"local");
    return state.people["101:505"].myCommentedPosts;
  });
  event.target.disabled = false;
});
document.querySelector("#check-heights").addEventListener("click",async event => {
  event.target.disabled = true;
  await checkHeights(() => {
    core.ingest(state,{ tweets:[
      post("2112500000000000014","101",demoTweets[0].id,demoTweets[11].id,"505","欢迎来交流！")
    ],likes:[{
      id:demoTweets[11].id,liked:true,account:"my_account",observedAt:Date.now(),source:"mutation"
    }] },"my_account");
    for (const listener of storageListeners) listener({ replyContext:{} },"local");
  });
});
document.querySelector("#check-hearts").addEventListener("click",async event => {
  event.target.disabled = true;
  await checkHearts();
  event.target.disabled = false;
});
document.querySelector("#check-notification-filter").addEventListener("click",async event => {
  event.target.disabled = true;
  await checkNotificationFilter(() => {
    const incoming = post("2112500000000070001","202",demoTweets[0].id,demoTweets[2].id,"101","新到达的已完成对话通知");
    core.ingest(state,{ tweets:[incoming] },"my_account");
    addNotification(incoming,true);
    for (const listener of storageListeners) listener({ replyContext:{} },"local");
  });
  event.target.disabled = false;
});
let diagnosticSequence = 0;
const notifyDiagnosticChange = () => storageListeners.forEach(listener => listener({ replyContext:{} },"local"));
document.querySelector("#check-stability").addEventListener("click",async event => {
  event.target.disabled = true;
  await checkNotificationStability({
    pauseLabels() { pauseClassification = true; notifyDiagnosticChange(); },
    paused:() => Boolean(releaseClassification),
    releaseLabels() { releaseClassification?.(); releaseClassification = undefined; },
    lateReply(id) {
      const target = state.tweets[id];
      core.ingest(state,{ tweets:[post(String(2112500000000800000n+BigInt(++diagnosticSequence)),"101",
        target.conversationId,id,target.authorId,"稍晚读取到的历史回复，并非当前发送")] },"my_account");
      notifyDiagnosticChange();
    },
    burst(count) {
      const tweets = Array.from({ length:count },(_,i) => post(String(2112500000000810000n+BigInt(i)),"202",
        demoTweets[0].id,demoTweets[2].id,"101",`新增的已完成对话通知 ${i+1}`));
      core.ingest(state,{ tweets },"my_account");
      const rows = tweets.map(tweet => addNotification(tweet,true));
      notifyDiagnosticChange(); return rows;
    }
  });
  event.target.disabled = false;
});
