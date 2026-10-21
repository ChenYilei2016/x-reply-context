import { users, demoTweets, post } from "./fixtures.mjs";
import { checkLayout } from "./layout-check.mjs";
import { checkHeights } from "./height-check.mjs";
import { installComposerDemo } from "./composer-demo.mjs";
const core = globalThis.XReplyContext;
const state = core.createState();
core.ingest(state,{ users,tweets:demoTweets },"my_account");
core.ingest(state,{ likes:[demoTweets[1].id,demoTweets[8].id].map(id => ({
  id,liked:true,account:"my_account",observedAt:Date.now()
})) },"my_account");
const storageListeners = [];
const replyWrites = new Map();
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
        for (const listener of storageListeners) listener({ replyContext:{} },"local");
        return { ok:true };
      }
      if (message.type === "CLASSIFY") return {
        ok:true,rows:message.ids.map(id => core.classify(state,message.account,id)),
        replyCount:Object.keys(state.replies).length,
        likeCount:Object.values(state.likes).filter(like => like.liked).length
      };
      return { ok:true };
    }
  },
  storage:{ onChanged:{ addListener:listener => storageListeners.push(listener) } }
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
      <div class="replying">回复 <a href="/my_account">@my_account</a></div>
      <div class="text-shell"><div data-testid="tweetText">${tweet.text}</div></div>
      <div class="actions-shell"><div role="group" class="actions"><button type="button" data-testid="reply" aria-label="回复 ${author.handle}">回复</button><span>♡ 1</span><span>↗</span><span>▥ 12</span></div></div>
    </div>`;
  if (prepend) timeline.prepend(article); else timeline.append(article);
}
for (const index of [11,3,7,4,8,10]) addNotification(demoTweets[index]);
installComposerDemo({ state,core,addNotification });
await import("/extension/observe.js");
await import("/extension/continuous.js");
const script = document.createElement("script");
script.src = "/extension/content.js";
document.body.append(script);
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
