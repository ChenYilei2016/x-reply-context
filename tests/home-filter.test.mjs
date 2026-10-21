import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { users,homeTweets,demoTweets } from "./fixtures.mjs";
await import("../extension/core.js");
const core = globalThis.XReplyContext;
const source = await readFile(new URL("../extension/card-filter.js",import.meta.url),"utf8")+
  await readFile(new URL("../extension/home-filter.js",import.meta.url),"utf8");
const hidden = "data-xrc-home-hidden";

function setup(tweets = homeTweets) {
  const state = core.createState();
  core.ingest(state,{ users,tweets:[...demoTweets,...tweets] },"my_account");
  const cards = tweets.map(tweet => ({
    id:tweet.id,isConnected:true,attributes:new Map(),
    closest:() => null,
    hasAttribute(key) { return this.attributes.has(key); },
    getAttribute(key) { return this.attributes.get(key) ?? null; },
    setAttribute(key,value) { this.attributes.set(key,value); },
    removeAttribute(key) { this.attributes.delete(key); }
  }));
  const env = { enabled:true,account:"my_account",modal:false,following:false,calls:[],reply:null };
  const location = { pathname:"/home" };
  const primary = {
    querySelector:() => ({ getAttribute:key => key === "aria-selected" ? String(!env.following) : null }),
    querySelectorAll:() => cards
  };
  const document = {
    querySelector:() => primary,
    querySelectorAll:() => cards.filter(card => card.hasAttribute(hidden))
  };
  const context = vm.createContext({ document,location });
  vm.runInContext(source,context);
  const filter = context.XReplyHomeFilter.create({
    accountHandle:() => env.account,tweetId:card => card.id,
    enabled:() => env.enabled,holdLayout:() => env.modal,
    message:async request => {
      env.calls.push(request.ids.length);
      if (env.reply) return env.reply(request);
      return { rows:request.ids.map(id => core.classify(state,request.account,id)) };
    }
  });
  return { state,cards,env,location,filter };
}

test("主页折叠自己的帖子与回复、评论且直接点赞的别人原帖；关闭或切页签恢复",async () => {
  const { state,cards,env,filter } = setup([...homeTweets,demoTweets[2],demoTweets[4]]);
  // Alice is commented, Bob's original only liked; a liked reply under Alice is insufficient.
  core.ingest(state,{ likes:[homeTweets[3].id,demoTweets[7].id,homeTweets[0].id].map(id =>
    ({ id,account:"my_account",liked:true,observedAt:Date.now() })) },"my_account");
  await filter.refresh();
  assert.deepEqual(cards.map(card => card.hasAttribute(hidden)),[true,false,false,false,false,true,false]);
  core.ingest(state,{ likes:[{ id:homeTweets[1].id,account:"my_account",liked:true,observedAt:Date.now() }] },"my_account");
  filter.invalidate(); await filter.refresh();
  assert.deepEqual(cards.map(card => card.hasAttribute(hidden)),[true,true,false,false,false,true,false]);
  env.enabled = false; await filter.refresh();
  assert.equal(cards.some(card => card.hasAttribute(hidden)),false);
  env.enabled = true; env.following = true; await filter.refresh();
  assert.equal(cards.some(card => card.hasAttribute(hidden)),false);
  env.following = false; await filter.refresh();
  assert.equal(cards[1].hasAttribute(hidden),true);
  env.account = "other_account"; await filter.refresh();
  assert.equal(cards.some(card => card.hasAttribute(hidden)),false,"换账号不能沿用前一个人的记录");
});

test("回复框期间暂缓；卡片重绘复用不误隐藏；取消点赞恢复",async () => {
  const { state,cards,env,filter } = setup();
  const id = cards[1].id;
  core.ingest(state,{ likes:[{ id,account:"my_account",liked:true,observedAt:Date.now() }] },"my_account");
  env.modal = true; await filter.refresh();
  assert.equal(cards[1].hasAttribute(hidden),false);
  env.modal = false; await filter.refresh();
  assert.equal(cards[1].hasAttribute(hidden),true);
  cards[1].removeAttribute(hidden); await filter.refresh();
  assert.equal(cards[1].hasAttribute(hidden),true,"同一ID重绘后重新折叠");
  cards[1].id = "99999999"; await filter.refresh();
  assert.equal(cards[1].hasAttribute(hidden),false,"容器复用成未知帖不能沿用隐藏标记");
  cards[1].id = id; await filter.refresh();
  core.ingest(state,{ likes:[{ id,account:"my_account",liked:false,observedAt:Date.now()+1,source:"mutation" }] },"my_account");
  filter.invalidate(); await filter.refresh();
  assert.equal(cards[1].hasAttribute(hidden),false);
});

test("只分类已加载卡片，每批不超过100；过期异步结果不改页面",async () => {
  const extra = Array.from({ length:205 },(_,i) => ({ ...homeTweets[1],id:String(90000000+i),conversationId:String(90000000+i) }));
  const { env,cards,filter,location } = setup(extra);
  await filter.refresh();
  assert.deepEqual(env.calls,[100,100,5]);
  let complete;
  env.reply = request => new Promise(resolve => { complete = () => resolve({ rows:request.ids.map(id =>
    ({ id,status:"not-reply",origin:"others",evidenceId:"1",likeEvidenceId:id })) }); });
  filter.invalidate();
  const pending = filter.refresh();
  env.enabled = false; filter.invalidate(); complete(); await pending;
  assert.equal(cards.some(card => card.hasAttribute(hidden)),false);
  location.pathname = "/notifications"; env.enabled = true; await filter.refresh();
  assert.equal(cards.some(card => card.hasAttribute(hidden)),false);
});
