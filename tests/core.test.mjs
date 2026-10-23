import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { users, post, graphql, demoTweets } from "./fixtures.mjs";
import "../extension/core.js";
const core = globalThis.XReplyContext;

function stateWith(tweets, account = "my_account") {
  const state = core.createState();
  core.ingest(state,{ users,tweets },account);
  return state;
}

test("批量分类与逐条口径一致，点赞变化和原帖回退不会沿用过期索引", () => {
  const state = stateWith(demoTweets);
  const ids = [...demoTweets.map(tweet => tweet.id),'999999'];
  const compare = () => {
    for (const account of ['my_account','other_account','missing']) {
      assert.deepEqual(core.classifyBatch(state,account,ids),ids.map(id => core.classify(state,account,id)));
    }
  };
  compare();
  core.ingest(state,{ likes:[{ id:demoTweets[8].id,account:'my_account',liked:true,observedAt:Date.now() }] },'my_account');
  compare();
  core.ingest(state,{ likes:[{ id:demoTweets[8].id,account:'my_account',liked:false,observedAt:Date.now()+1 }] },'my_account');
  state.replies = {};
  compare();
  assert.equal(core.classifyBatch(state,'my_account',Array(101).fill(demoTweets[0].id)).length,100);
});

test("回复框主页指向当前评论作者，不沿用原帖作者", () => {
  const state = stateWith(demoTweets);
  const row = core.classify(state,"my_account",demoTweets[8].id);
  assert.equal(row.authorHandle,"bob");
  assert.equal(row.rootHandle,"alice");
  assert.equal(core.classify(state,"my_account","999999999").authorHandle,undefined);
});

test("我的原帖和别人的原帖：有我回复此人的证据才标为已回应", () => {
  const state = stateWith(demoTweets);
  const own = core.classify(state,"my_account","2112500000000000004");
  assert.equal(own.origin,"mine");
  assert.equal(own.status,"replied");
  assert.equal(own.evidenceId,"2112500000000000003");
  const other = core.classify(state,"my_account","2112500000000000008");
  assert.equal(other.origin,"others");
  assert.equal(other.status,"replied");
  assert.equal(other.evidenceId,"2112500000000000007");
});

test("同帖第三人、新原帖、另一个账号均不会沿用已回应", () => {
  const state = stateWith(demoTweets);
  for (const id of ["2112500000000000005","2112500000000000009","2112500000000000011"]) {
    assert.equal(core.classify(state,"my_account",id).status,"unknown");
  }
  assert.equal(core.classify(state,"other_account","2112500000000000004").status,"unknown");
  assert.equal(core.classify(state,"","2112500000000000004").origin,"unknown");
});

test("只有发原帖、点赞、回复数量、@提及和失败响应不能证明回复过", () => {
  const original = post("100","101","100");
  const incoming = post("101","202","100","100","101");
  const state = stateWith([original,incoming]);
  assert.equal(core.classify(state,"my_account","101").status,"unknown");
  core.ingest(state,core.extract({
    errors:[{ message:"failed" }], favorite_count:1, reply_count:1,
    draft:{ text:"@alice 谢谢",in_reply_to_status_id:"101" }
  }),"my_account");
  core.ingest(state,{ tweets:[post("102","101","102","","","@alice 谢谢")] },"my_account");
  assert.equal(core.classify(state,"my_account","101").status,"unknown");
});

test("父帖晚到、部分字段缺失及乱序加载可以补全同一条证据", () => {
  const state = stateWith([
    post("100","101","100"), post("103","101","","102"),
    post("104","202","100","103","101")
  ]);
  assert.equal(core.classify(state,"my_account","104").status,"unknown");
  core.ingest(state,{ tweets:[post("102","202","100","100","101")] },"my_account");
  assert.equal(core.classify(state,"my_account","104").evidenceId,"103");
  core.ingest(state,{ tweets:[post("102","202","","","")] },"my_account");
  assert.equal(core.classify(state,"my_account","104").status,"replied");
});

test("账号稍晚被识别时，之前加载的真实回复仍可索引", () => {
  const state = core.createState();
  core.ingest(state,{ tweets:demoTweets },"my_account");
  core.ingest(state,{ users },"my_account");
  assert.equal(core.classify(state,"my_account","2112500000000000004").status,"replied");
});

test("兼容通知旧结构、GraphQL 的新用户结构；大 ID 保持字符串", () => {
  const tweet = demoTweets[2];
  const parsed = core.extract({ data:{ create_tweet:{ tweet_results:{ result:graphql(tweet) } } } });
  assert.equal(parsed.tweets.length,1);
  assert.deepEqual(parsed.tweets[0],tweet);
  assert.deepEqual(parsed.users,[users[0]]);
  const legacy = core.extract({ globalObjects:{
    users:{ 101:{ id_str:"101",screen_name:"my_account" } },
    tweets:{ [tweet.id]:graphql(tweet).legacy }
  } });
  assert.deepEqual(legacy.tweets[0],tweet);
  assert.deepEqual(legacy.users,[users[0]]);
});

test("转帖中的复制字段不冒充自己的回复，原回复仍可读取", () => {
  const original = graphql(post("101","202","100","100","101"));
  const retweet = graphql(post("102","101","100","100","202"));
  retweet.legacy.retweeted_status_result = { result:original };
  const parsed = core.extract(retweet);
  assert.equal(parsed.tweets.some(tweet => tweet.id === "102"),false);
  assert.equal(parsed.tweets.some(tweet => tweet.id === "101"),true);
});

test("引用帖的回复和红心按外层新原帖判断，不借用被引用帖或楼中楼的红心", () => {
  const quoted = post("700","101","700");
  const outer = post("800","202","800");
  const value = graphql(outer);
  value.quoted_status_result = { result:graphql(quoted) };
  const state = stateWith(core.extract(value).tweets);
  core.ingest(state,{ tweets:[post("701","101","700","700","101")],
    likes:[{ id:"700",liked:true,account:"my_account",observedAt:Date.now() }] },"my_account");
  let row = core.classify(state,"my_account","800");
  assert.equal(row.status,"not-reply"); assert.equal(row.rootId,"800");
  assert.equal(row.origin,"others"); assert.equal(row.evidenceId,""); assert.equal(row.likeEvidenceId,"");
  core.ingest(state,{ tweets:[post("801","101","800","800","202"),post("802","202","800","801","101")],
    likes:[{ id:"802",liked:true,account:"my_account",observedAt:Date.now() }] },"my_account");
  row = core.classify(state,"my_account","800");
  assert.equal(row.evidenceId,"801");
  assert.equal(row.likeEvidenceId,"","点赞楼中楼不能冒充点赞引用帖本身");
  core.ingest(state,{ likes:[{ id:"800",liked:true,account:"my_account",observedAt:Date.now() }] },"my_account");
  assert.equal(core.classify(state,"my_account","800").likeEvidenceId,"800");
});

test("未知父帖、引用、自我串帖不冒充已经回复某个参与者", () => {
  const state = stateWith([
    post("100","101","100"), post("101","101","100","100","101"),
    post("102","202","100","101","101"), post("103","202","","","")
  ]);
  assert.equal(core.classify(state,"my_account","102").status,"unknown");
  assert.equal(core.classify(state,"my_account","103").status,"unknown");
  assert.equal(core.classify(state,"my_account","100").status,"not-reply");
});

test("缓存和证据保留 90 天、上限 10000 条，清理后回到待确认", () => {
  const state = core.createState();
  const start = 1000000000000;
  core.ingest(state,{ users,tweets:demoTweets },"my_account",start);
  core.ingest(state,{},"my_account",start + core.RETENTION_MS + 1);
  assert.equal(Object.keys(state.replies).length,0);
  assert.equal(Object.keys(state.people).length,0);
  assert.equal(core.classify(state,"my_account","2112500000000000004").status,"unknown");
  for (let i = 1; i <= 10010; i++) {
    state.tweets[String(i)] = { ...post(String(i),"101",String(i)),seenAt:start };
  }
  core.ingest(state,{},"my_account",start);
  assert.equal(Object.keys(state.tweets).length,10000);
});

test("页面观察器保留原 fetch 行为，只读取成功的目标响应", async () => {
  const messages = [];
  const listeners = [];
  let response = new Response(JSON.stringify({ data:{ result:graphql(demoTweets[2]) } }),
    { headers:{ "content-type":"application/json" } });
  const originalPromise = Promise.resolve(response);
  const location = { origin:"https://x.com",href:"https://x.com/notifications" };
  class Xhr { open() {} send() {} }
  const window = {
    fetch:() => originalPromise,
    addEventListener:(_name,listener) => listeners.push(listener),
    postMessage:message => messages.push(message)
  };
  const context = vm.createContext({
    window,location,XMLHttpRequest:Xhr,URL,TextDecoder,setTimeout,clearTimeout,console,
    document:{ querySelector:() => ({ getAttribute:() => "/my_account" }) }
  });
  vm.runInContext(await readFile(new URL("../extension/core.js",import.meta.url),"utf8"),context);
  vm.runInContext(await readFile(new URL("../extension/observe.js",import.meta.url),"utf8"),context);
  for (const listener of listeners) listener({
    source:window,origin:location.origin,data:{ channel:"x-reply-context-v1",type:"READY" }
  });
  const returned = window.fetch("https://x.com/i/api/graphql/hash/CreateTweet");
  assert.equal(returned,originalPromise);
  assert.equal((await returned).bodyUsed,false);
  await new Promise(resolve => setTimeout(resolve,300));
  const observed = messages.find(message => message.type === "OBSERVED");
  assert.equal(observed.batch.tweets[0].id,demoTweets[2].id);
  assert.equal(response.bodyUsed,false);
  messages.length = 0;
  window.fetch("https://x.com/i/api/graphql/hash/SendMessage");
  await new Promise(resolve => setTimeout(resolve,250));
  assert.equal(messages.length,0);
});

test("后台串行合并多标签消息，并拒绝非 X 网页调用", async () => {
  let listener;
  let saved = { replyContext:stateWith(demoTweets.slice(0,3)) };
  saved.replyContext.people = {
    "101:202":{ sent:1,received:1,firstReceivedId:demoTweets[1].id,established:true,seenAt:Date.now() }
  };
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const chrome = {
    runtime:{
      id:extensionId,getURL:path => `chrome-extension://${extensionId}${path}`,
      onMessage:{ addListener:value => { listener = value; } }
    },
    storage:{ local:{
      get:async () => structuredClone(saved),
      set:async data => { Object.assign(saved,structuredClone(data)); }
    } }
  };
  const context = vm.createContext({ chrome,console,URL,XReplyStorage:{ create:() => ({
    load:async () => structuredClone(saved.replyContext),
    save:async value => { saved.replyContext = structuredClone(value); }
  }) } });
  vm.runInContext(await readFile(new URL("../extension/core.js",import.meta.url),"utf8"),context);
  context.importScripts = () => {};
  vm.runInContext(await readFile(new URL("../extension/background.js",import.meta.url),"utf8"),context);
  const sender = { id:extensionId,url:"https://x.com/notifications" };
  const send = message => new Promise((resolve,reject) => {
    if (!listener(message,sender,resolve)) reject(new Error("Valid message was rejected"));
  });
  const upgraded = await send({ type:"CLASSIFY",account:"my_account",ids:[demoTweets[1].id] });
  assert.equal(upgraded.rows[0].personStats.myCommentedPosts,0,"自己的原帖下回应不算我评他");
  assert.equal(upgraded.rows[0].personStats.theirCommentedPosts,1);
  assert.equal(upgraded.rows[0].newPerson,true,"旧的已回应标记不影响新的首次评论口径");
  assert.equal(upgraded.rows[0].rootText,undefined,"普通列表分类不额外传输正文");
  const excerpt = await send({ type:"CLASSIFY",account:"my_account",ids:[demoTweets[1].id],includeRootText:true });
  assert.equal(excerpt.rows[0].rootText,demoTweets[0].text,"回复框复用本地原帖摘要");
  assert.equal(saved.replyContext.people["101:202"].firstCommentOnMyPostId,demoTweets[1].id);
  assert.equal(saved.replyContext.people["101:202"].sent,undefined);
  await Promise.all([
    send({ type:"INGEST",account:"my_account",batch:{ users,tweets:demoTweets.slice(0,3) } }),
    send({ type:"INGEST",account:"my_account",batch:{ tweets:demoTweets.slice(3) } })
  ]);
  const result = await send({ type:"CLASSIFY",account:"my_account",ids:[demoTweets[3].id] });
  assert.equal(result.rows[0].status,"replied");
  assert.equal(listener({ type:"INGEST" },{ id:extensionId,url:"https://example.com" },() => {}),false);
  assert.ok(saved.replyContext.replies["101:2112500000000000001:202"]);
  await send({ type:"INGEST",account:"my_account",batch:{ tweets:[post('880','202','879','879','101','这是评论内容')] } });
  const missingRoot = await send({ type:"CLASSIFY",account:"my_account",ids:['880'],includeRootText:true });
  assert.equal(missingRoot.rows[0].rootText,'',"正文缺失时不拿评论内容冒充原帖");
});

test("文字和红心独立：只点赞、只回复和两者都有均可同时显示", () => {
  const state = stateWith(demoTweets);
  const now = Date.now();
  core.ingest(state,{ likes:[
    { id:demoTweets[1].id,account:"my_account",liked:true,observedAt:now },
    { id:demoTweets[8].id,account:"my_account",liked:true,observedAt:now }
  ] },"my_account",now);
  const both = core.classify(state,"my_account",demoTweets[3].id);
  assert.equal(both.status,"replied");
  assert.equal(both.likeEvidenceId,demoTweets[1].id);
  const textOnly = core.classify(state,"my_account",demoTweets[7].id);
  assert.equal(textOnly.status,"replied");
  assert.equal(textOnly.likeEvidenceId,"");
  const heartOnly = core.classify(state,"my_account",demoTweets[8].id);
  assert.equal(heartOnly.status,"unknown");
  assert.equal(heartOnly.likeEvidenceId,demoTweets[8].id);
  assert.equal(core.classify(state,"my_account",demoTweets[4].id).likeEvidenceId,"");
  assert.equal(core.classify(state,"my_account",demoTweets[10].id).likeEvidenceId,"");
  assert.equal(core.classify(state,"other_account",demoTweets[3].id).likeEvidenceId,"");
});

test("点赞对方原帖可覆盖其后续回复；取消一条不会误清除此人其他红心", () => {
  const state = stateWith(demoTweets);
  const now = Date.now();
  const like = (id,liked,observedAt) => ({ id,liked,observedAt,account:"my_account",source:"mutation" });
  core.ingest(state,{ likes:[
    like(demoTweets[5].id,true,now),like(demoTweets[7].id,true,now)
  ] },"my_account",now);
  assert.ok(core.classify(state,"my_account",demoTweets[7].id).likeEvidenceId);
  core.ingest(state,{ likes:[like(demoTweets[7].id,false,now+1)] },"my_account",now+1);
  assert.equal(core.classify(state,"my_account",demoTweets[7].id).likeEvidenceId,demoTweets[5].id);
  core.ingest(state,{ likes:[like(demoTweets[5].id,false,now+2)] },"my_account",now+2);
  const result = core.classify(state,"my_account",demoTweets[7].id);
  assert.equal(result.likeEvidenceId,"");
  assert.equal(result.status,"replied");
});

test("晚到的旧页面状态不能覆盖成功的点赞或取消点赞", () => {
  const state = stateWith(demoTweets);
  const now = Date.now();
  const event = (liked,observedAt,source) => ({
    id:demoTweets[1].id,account:"my_account",liked,observedAt,source
  });
  core.ingest(state,{ likes:[event(true,now,"mutation")] },"my_account",now);
  core.ingest(state,{ likes:[event(false,now-100,"snapshot")] },"my_account",now+1);
  assert.ok(core.classify(state,"my_account",demoTweets[3].id).likeEvidenceId);
  core.ingest(state,{ likes:[event(false,now+2,"mutation")] },"my_account",now+2);
  core.ingest(state,{ likes:[event(true,now+1,"snapshot")] },"my_account",now+3);
  assert.equal(core.classify(state,"my_account",demoTweets[3].id).likeEvidenceId,"");
});

test("红心来自 favorited 字段，不使用点赞数量；归属使用请求时账号", () => {
  const raw = graphql(demoTweets[1]);
  raw.legacy.favorite_count = 100;
  assert.equal(core.extract(raw).likes.length,0);
  raw.legacy.favorited = true;
  assert.deepEqual(core.extract(raw).likes,[{ id:demoTweets[1].id,liked:true }]);
  const state = stateWith(demoTweets);
  const now = Date.now();
  core.ingest(state,{ likes:[
    { id:demoTweets[1].id,liked:true,account:"other_account",observedAt:now }
  ] },"my_account",now);
  assert.equal(core.classify(state,"my_account",demoTweets[3].id).likeEvidenceId,"");
  assert.ok(core.classify(state,"other_account",demoTweets[3].id).likeEvidenceId);
});

test("升级保留原回复；未知原帖可显示本条已点赞，记录过期后回到待确认", () => {
  const state = stateWith(demoTweets);
  delete state.likes;
  const now = Date.now();
  core.ingest(state,{ likes:[
    { id:"900",liked:true,account:"my_account",observedAt:now }
  ] },"my_account",now);
  assert.equal(core.classify(state,"my_account","900").likeEvidenceId,"900");
  assert.equal(core.classify(state,"my_account",demoTweets[3].id).status,"replied");
  core.ingest(state,{},"my_account",now + core.RETENTION_MS + 1);
  assert.equal(Object.keys(state.likes).length,0);
});

test("fetch 和 XHR 仅在点赞回执成功后记录；失败和切换账号不误记", async () => {
  const messages = [];
  const listeners = [];
  let account = "my_account";
  let resolveResponse;
  let currentPromise;
  class Xhr {
    open() {}
    addEventListener(_name,listener) { this.listener = listener; }
    send(body) { this.sentBody = body; }
    complete(payload,status=200) {
      this.status = status; this.responseType = "json"; this.response = payload;
      this.listener();
    }
  }
  const location = { origin:"https://x.com",href:"https://x.com/notifications" };
  const window = {
    fetch:() => currentPromise,
    addEventListener:(_name,listener) => listeners.push(listener),
    postMessage:message => messages.push(message)
  };
  const context = vm.createContext({
    window,location,XMLHttpRequest:Xhr,URL,Request,TextDecoder,setTimeout,clearTimeout,
    document:{ querySelector:() => ({ getAttribute:() => `/${account}` }) }
  });
  vm.runInContext(await readFile(new URL("../extension/core.js",import.meta.url),"utf8"),context);
  vm.runInContext(await readFile(new URL("../extension/observe.js",import.meta.url),"utf8"),context);
  for (const listener of listeners) listener({
    source:window,origin:location.origin,data:{ channel:"x-reply-context-v1",type:"READY" }
  });
  messages.length = 0;
  const flush = async () => {
    await new Promise(resolve => setTimeout(resolve,260));
    return messages.splice(0).filter(message => message.type === "OBSERVED").flatMap(message => message.batch.likes);
  };
  async function fetchReaction(payload,{ switchAccount=false,asRequest=false }={}) {
    currentPromise = new Promise(resolve => { resolveResponse = resolve; });
    const url = "https://x.com/i/api/graphql/hash/FavoriteTweet";
    const init = { method:"POST",body:JSON.stringify({ variables:{ tweet_id:demoTweets[1].id } }) };
    const request = asRequest ? new Request(url,init) : url;
    const returned = asRequest ? window.fetch(request) : window.fetch(request,init);
    assert.equal(returned,currentPromise);
    assert.equal(messages.length,0);
    if (switchAccount) account = "other_account";
    resolveResponse(new Response(JSON.stringify(payload),{ headers:{ "content-type":"application/json" } }));
    const likes = await flush();
    if (asRequest) assert.equal(request.bodyUsed,false);
    return likes;
  }
  let likes = await fetchReaction({ data:{ favorite_tweet:"Done" } },{ asRequest:true });
  assert.equal(likes[0].liked,true);
  assert.equal(likes[0].account,"my_account");
  assert.equal((await fetchReaction({ errors:[{ message:"denied" }] })).length,0);
  assert.equal((await fetchReaction({ data:{ favorite_tweet:"Done" } },{ switchAccount:true })).length,0);
  account = "my_account";
  const xhr = new Xhr();
  xhr.open("POST","https://x.com/i/api/graphql/hash/UnfavoriteTweet");
  const body = JSON.stringify({ variables:{ tweet_id:demoTweets[1].id } });
  xhr.send(body);
  assert.equal(xhr.sentBody,body);
  assert.equal(messages.length,0);
  xhr.complete({ data:{ unfavorite_tweet:"Done" } });
  likes = await flush();
  assert.equal(likes[0].liked,false);
});

test("UserRepliesTimeline 历史页加载后增加回复记录，不仅记录 CreateTweet", async () => {
  const state = stateWith([demoTweets[0],demoTweets[1],demoTweets[5]]);
  const listeners = [];
  const timers = [];
  class Xhr {
    open() {}
    send() {}
    addEventListener(_name,listener) { this.listener = listener; }
    complete(payload) {
      this.status = 200; this.responseType = ""; this.responseText = JSON.stringify(payload);
      this.listener?.();
    }
  }
  const location = { origin:"https://x.com",href:"https://x.com/my_account/with_replies" };
  const window = {
    fetch:() => Promise.resolve(),
    addEventListener:(_name,listener) => listeners.push(listener),
    postMessage:message => {
      if (message.type === "OBSERVED") core.ingest(state,message.batch,"my_account");
    }
  };
  const context = vm.createContext({
    window,location,XMLHttpRequest:Xhr,URL,
    setTimeout:callback => timers.push(callback),
    document:{ querySelector:() => ({ getAttribute:() => "/my_account" }) }
  });
  vm.runInContext(await readFile(new URL("../extension/core.js",import.meta.url),"utf8"),context);
  vm.runInContext(await readFile(new URL("../extension/observe.js",import.meta.url),"utf8"),context);
  for (const listener of listeners) listener({
    source:window,origin:location.origin,data:{ channel:"x-reply-context-v1",type:"READY" }
  });
  async function receive(operation,tweet) {
    const xhr = new Xhr();
    xhr.open("GET",`https://x.com/i/api/graphql/currentQuery/${operation}`);
    xhr.send();
    xhr.complete({ data:{ timeline:{ result:graphql(tweet) } } });
    await new Promise(resolve => setImmediate(resolve));
    while (timers.length) timers.shift()();
  }
  await receive("CreateTweet",demoTweets[2]);
  assert.equal(Object.keys(state.replies).length,1);
  // Operation observed on the real X replies page on 2026-10-20.
  await receive("UserRepliesTimeline",demoTweets[6]);
  assert.equal(Object.keys(state.replies).length,2,"历史回复页的响应没有进入记录");
});

test("主页点赞评论后，NotificationsTimeline 新通知能关联原帖及两项互动", async () => {
  const state = stateWith([]);
  const listeners = [];
  const timers = [];
  class Xhr {
    open() {}
    send() {}
    addEventListener(_name,listener) { this.listener = listener; }
    complete(payload) {
      this.status = 200; this.responseType = ""; this.responseText = JSON.stringify(payload);
      this.listener?.();
    }
  }
  const location = { origin:"https://x.com",href:"https://x.com/home" };
  const window = {
    fetch:() => Promise.resolve(),
    addEventListener:(_name,listener) => listeners.push(listener),
    postMessage:message => {
      if (message.type === "OBSERVED" || (message.type === "REPLY_RESULT" && message.status === "sent")) {
        core.ingest(state,message.batch,message.account || "my_account");
      }
    }
  };
  const context = vm.createContext({
    window,location,XMLHttpRequest:Xhr,URL,
    setTimeout:callback => timers.push(callback),
    document:{ querySelector:() => ({ getAttribute:() => "/my_account" }) }
  });
  vm.runInContext(await readFile(new URL("../extension/core.js",import.meta.url),"utf8"),context);
  vm.runInContext(await readFile(new URL("../extension/observe.js",import.meta.url),"utf8"),context);
  for (const listener of listeners) listener({
    source:window,origin:location.origin,data:{ channel:"x-reply-context-v1",type:"READY" }
  });
  async function receive(operation,payload,body) {
    const xhr = new Xhr();
    xhr.open(body ? "POST" : "GET",`https://x.com/i/api/graphql/currentQuery/${operation}`);
    xhr.send(body);
    xhr.complete(payload);
    await new Promise(resolve => setImmediate(resolve));
    while (timers.length) timers.shift()();
  }
  await receive("HomeTimeline",{ data:{ result:graphql(demoTweets[5]) } });
  await receive("FavoriteTweet",{ data:{ favorite_tweet:"Done" } },
    JSON.stringify({ variables:{ tweet_id:demoTweets[5].id } }));
  await receive("CreateTweet",{ data:{ create_tweet:{ tweet_results:{ result:graphql(demoTweets[6]) } } } },
    JSON.stringify({ variables:{ reply:{ in_reply_to_tweet_id:demoTweets[5].id } } }));
  assert.equal(Object.keys(state.replies).length,1,"主页发出的回复应先入库");
  assert.equal(Object.values(state.likes).filter(like => like.liked).length,1);
  location.href = "https://x.com/notifications";
  // Operation observed on the real notifications page on 2026-10-20.
  await receive("NotificationsTimeline",{ data:{ timeline:{ result:graphql(demoTweets[7]) } } });
  const result = core.classify(state,"my_account",demoTweets[7].id);
  assert.equal(result.origin,"others","通知缺失导致主页已回复的原帖仍显示待确认");
  assert.equal(result.evidenceId,demoTweets[6].id);
  assert.equal(result.likeEvidenceId,demoTweets[5].id);
});

test("我评他与他评我按对方的不同原帖数统计，同帖多次及重复加载只算一篇", () => {
  const state = stateWith(demoTweets);
  const aliceId = demoTweets[10].id;
  let result = core.classify(state,"my_account",aliceId);
  const expected = { myCommentedPosts:1,theirCommentedPosts:2 };
  assert.deepEqual(result.personStats,expected);
  assert.equal(result.status,"unknown","跨帖次数不能改变当前原帖的已回复判断");
  const repeated = [
    post("2112500000000000022","101",demoTweets[5].id,demoTweets[7].id,"202"),
    post("2112500000000000023","101",demoTweets[5].id,demoTweets[8].id,"303")
  ];
  core.ingest(state,{ users,tweets:[...demoTweets,...repeated] },"my_account");
  assert.deepEqual(core.classify(state,"my_account",aliceId).personStats,expected);
  assert.equal(core.classify(state,"my_account",demoTweets[8].id).personStats.myCommentedPosts,0,
    "在 Alice 原帖下回 Bob，不算评论 Bob 的原帖");
  for (const tweet of [demoTweets[6],...repeated]) delete state.tweets[tweet.id];
  core.ingest(state,{},"my_account");
  assert.deepEqual(core.classify(state,"my_account",aliceId).personStats,expected,
    "缓存帖子淘汰后，仍能复用回应索引且同一原帖只算一次");
  const anotherRoot = post("2112500000000000024","202","2112500000000000024");
  core.ingest(state,{ tweets:[
    anotherRoot,
    post("2112500000000000025","303",anotherRoot.id,anotherRoot.id,"202"),
    post("2112500000000000026","101",anotherRoot.id,"2112500000000000025","303")
  ] },"my_account");
  assert.deepEqual(core.classify(state,"my_account",aliceId).personStats,
    { myCommentedPosts:2,theirCommentedPosts:2 },"楼中楼按原帖作者累计，不按直接收件人累计");
  core.ingest(state,{},"other_account");
  assert.deepEqual(core.classify(state,"other_account",aliceId).personStats,
    { myCommentedPosts:0,theirCommentedPosts:0 });
  assert.equal(core.classify(state,"other_account",aliceId).newPerson,false);
});

test("首次评论我的原帖且我评他为零才标新，自己帖下回话不取消，评论他的原帖后取消", () => {
  const state = stateWith([demoTweets[0],demoTweets[11]]);
  const firstId = demoTweets[11].id;
  let result = core.classify(state,"my_account",firstId);
  assert.deepEqual(result.personStats,{ myCommentedPosts:0,theirCommentedPosts:1 });
  assert.equal(result.newPerson,true);
  core.ingest(state,{ tweets:[demoTweets[11]] },"my_account");
  assert.equal(core.classify(state,"my_account",firstId).newPerson,true);
  const later = post("2112500000000000015","505",demoTweets[0].id,demoTweets[0].id,"101");
  core.ingest(state,{ tweets:[later] },"my_account");
  assert.equal(core.classify(state,"my_account",later.id).newPerson,false);
  core.ingest(state,{ tweets:[
    post("2112500000000000016","101",demoTweets[0].id,firstId,"505")
  ] },"my_account");
  result = core.classify(state,"my_account",firstId);
  assert.equal(result.newPerson,true,"在自己原帖下回应不改变我评他，首次通知仍标新");
  assert.deepEqual(result.personStats,{ myCommentedPosts:0,theirCommentedPosts:1 });
  const peerRoot = post("2112500000000000017","505","2112500000000000017");
  core.ingest(state,{ tweets:[
    peerRoot,post("2112500000000000018","101",peerRoot.id,peerRoot.id,"505")
  ] },"my_account");
  result = core.classify(state,"my_account",firstId);
  assert.equal(result.newPerson,false);
  assert.equal(result.personStats.myCommentedPosts,1);
});

test("点赞和取消点赞不改变首次评论标记，也不增加评论过的原帖数", () => {
  const state = stateWith([demoTweets[0],demoTweets[11]]);
  const tweetId = demoTweets[11].id;
  const now = Date.now();
  core.ingest(state,{ likes:[
    { id:tweetId,account:"my_account",liked:true,observedAt:now,source:"mutation" }
  ] },"my_account",now);
  let result = core.classify(state,"my_account",tweetId);
  assert.equal(result.newPerson,true);
  assert.deepEqual(result.personStats,{ myCommentedPosts:0,theirCommentedPosts:1 });
  core.ingest(state,{ likes:[
    { id:tweetId,account:"my_account",liked:false,observedAt:now+1,source:"mutation" }
  ] },"my_account",now+1);
  result = core.classify(state,"my_account",tweetId);
  assert.equal(result.newPerson,true);
  assert.equal(result.likeEvidenceId,"");
  assert.deepEqual(result.personStats,{ myCommentedPosts:0,theirCommentedPosts:1 });
});

test("NEW 仅针对我的原帖，其他原帖中的回复不占首次，未知归属确认后再判断", () => {
  const thirdPartyReply = post("2112500000000000012","505",demoTweets[5].id,demoTweets[6].id,"101");
  const state = stateWith([demoTweets[0],demoTweets[5],demoTweets[6],thirdPartyReply,demoTweets[11]]);
  assert.equal(core.classify(state,"my_account",thirdPartyReply.id).newPerson,false);
  assert.equal(core.classify(state,"my_account",demoTweets[11].id).newPerson,true);

  const unknown = post("2112500000000000032","505","2112500000000000030","2112500000000000031","101");
  const incomplete = stateWith([unknown]);
  assert.equal(core.classify(incomplete,"my_account",unknown.id).newPerson,false);
  core.ingest(incomplete,{ tweets:[post(unknown.conversationId,"101",unknown.conversationId)] },"my_account");
  assert.equal(core.classify(incomplete,"my_account",unknown.id).newPerson,true);
});

test("旧缓存可本地补建统计，自我串帖、普通提及和未知原帖不冒充评论对方原帖", () => {
  const state = stateWith(demoTweets);
  delete state.people;
  core.ingest(state,{ tweets:[
    post("2112500000000000020","101",demoTweets[0].id,demoTweets[0].id,"101"),
    post("2112500000000000021","101","2112500000000000021","","","@alice 提及不是回复"),
    post("2112500000000000030","101","2112500000000000028","2112500000000000029","202")
  ] },"my_account");
  assert.deepEqual(core.classify(state,"my_account",demoTweets[3].id).personStats,
    { myCommentedPosts:1,theirCommentedPosts:2 });
  core.ingest(state,{ tweets:[post("2112500000000000028","202","2112500000000000028")] },"my_account");
  assert.deepEqual(core.classify(state,"my_account",demoTweets[3].id).personStats,
    { myCommentedPosts:2,theirCommentedPosts:2 },"原帖作者晚到后自动补计");
  assert.equal(state.people["101:101"],undefined);
  assert.equal(core.classify(state,"my_account","999").newPerson,false);
});

test("成功回复只保存一次，评论不同原帖累计而同帖重复去重，并保留完整响应证据", async () => {
  const state = stateWith([]);
  let response;
  let writes = 0;
  const timers = [];
  const listeners = [];
  const roots = ["2112500000000070001","2112500000000070002","2112500000000070003"];
  class Xhr { open() {} send() {} }
  const location = { origin:"https://x.com",href:"https://x.com/notifications" };
  const window = {
    fetch:async () => response,
    addEventListener:(_name,listener) => listeners.push(listener),
    postMessage:event => {
      if (event.type === "OBSERVED" || (event.type === "REPLY_RESULT" && event.status === "sent")) {
        core.ingest(state,event.batch,event.account || "my_account");
        writes++;
      }
    }
  };
  const context = vm.createContext({ window,location,XMLHttpRequest:Xhr,URL,TextDecoder,
    setTimeout:callback => timers.push(callback),
    document:{ querySelector:() => ({ getAttribute:() => "/my_account" }) }
  });
  vm.runInContext(await readFile(new URL("../extension/core.js",import.meta.url),"utf8"),context);
  vm.runInContext(await readFile(new URL("../extension/observe.js",import.meta.url),"utf8"),context);
  listeners.forEach(listener => listener({ source:window,origin:location.origin,
    data:{ channel:"x-reply-context-v1",type:"READY" } }));
  for (const [index,rootId] of [...roots,roots[0]].entries()) {
    const root = graphql(post(rootId,"202",rootId));
    root.legacy.favorited = true;
    const reply = post(String(2112500000000070100n+BigInt(index)),"101",rootId,rootId,"202");
    const payload = { data:{ create_tweet:{ tweet_results:{ result:graphql(reply) } },context:root } };
    response = new Response(JSON.stringify(payload),{ headers:{ "content-type":"application/json" } });
    await window.fetch("https://x.com/i/api/graphql/hash/CreateTweet",{
      method:"POST",body:JSON.stringify({ variables:{ reply:{ in_reply_to_tweet_id:rootId } } })
    });
    await new Promise(resolve => setTimeout(resolve,10));
    while (timers.length) timers.shift()();
    assert.equal(state.people["101:202"].myCommentedPosts,Math.min(index+1,3));
    assert.equal(writes,index+1,"同一成功回复不再从回执与普通观察通路各保存一次");
    assert.equal(state.users["202"].handle,"alice","成功回执保留响应附带的原帖作者");
    assert.equal(state.likes[`101:${rootId}`].liked,true,"附带点赞状态仍绑定请求账号");
  }
});

test("连续回复回执绑定请求、目标和账号；失败、原帖及不匹配回执不能触发下一条", async () => {
  const messages = [];
  let account = "my_account";
  let responsePromise;
  class Xhr {
    handlers = {};
    open() {}
    send() {}
    addEventListener(name,handler) { (this.handlers[name] ||= []).push(handler); }
    complete(payload) {
      this.status = 200; this.responseType = "json"; this.response = payload;
      this.handlers.load.forEach(handler => handler());
    }
  }
  const location = { origin:"https://x.com",href:"https://x.com/notifications" };
  const listeners = [];
  const window = {
    fetch:() => responsePromise,
    addEventListener:(_name,listener) => listeners.push(listener),
    postMessage:message => messages.push(message)
  };
  const context = vm.createContext({
    window,location,XMLHttpRequest:Xhr,URL,Request,TextDecoder,setTimeout,clearTimeout,
    document:{ querySelector:() => ({ getAttribute:() => `/${account}` }) }
  });
  vm.runInContext(await readFile(new URL("../extension/core.js",import.meta.url),"utf8"),context);
  vm.runInContext(await readFile(new URL("../extension/observe.js",import.meta.url),"utf8"),context);
  for (const listener of listeners) listener({ source:window,origin:location.origin,
    data:{ channel:"x-reply-context-v1",type:"READY" } });
  const url = "https://x.com/i/api/graphql/hash/CreateTweet";
  const body = JSON.stringify({ variables:{ tweet_text:"原生草稿保持不动",reply:{ in_reply_to_tweet_id:demoTweets[1].id } } });
  const payloadFor = tweet => ({ data:{ create_tweet:{ tweet_results:{ result:graphql(tweet) } } } });
  const settle = () => new Promise(resolve => setTimeout(resolve,30));
  async function send(payload,{ status=200,request=false,switchAccount=false,draftBody=body }={}) {
    const start = messages.length;
    let complete;
    responsePromise = new Promise(resolve => { complete = resolve; });
    const init = { method:"POST",body:draftBody };
    const req = request ? new Request(url,init) : url;
    assert.equal(request ? window.fetch(req) : window.fetch(req,init),responsePromise);
    await settle();
    if (switchAccount) account = "other_account";
    complete(new Response(JSON.stringify(payload),{ status,headers:{ "content-type":"application/json" } }));
    await settle();
    if (request) assert.equal(req.bodyUsed,false,"只读取克隆，不消费原始请求正文");
    return messages.slice(start);
  }
  let events = await send(payloadFor(demoTweets[2]),{ request:true });
  const started = events.find(event => event.type === "REPLY_STARTED");
  const sent = events.find(event => event.type === "REPLY_RESULT");
  assert.equal(sent.status,"sent");
  assert.equal(sent.requestId,started.requestId);
  assert.equal(sent.parentId,demoTweets[1].id);
  assert.equal(sent.batch.tweets[0].id,demoTweets[2].id);
  assert.equal(JSON.stringify(sent).includes("原生草稿保持不动"),false,"不广播请求中的草稿正文");
  events = await send(payloadFor(demoTweets[6]));
  assert.equal(events.find(event => event.type === "REPLY_RESULT").status,"unknown","回执目标不匹配不能当作成功");
  const rejected = post("2112500000000099999","101",demoTweets[0].id,demoTweets[1].id,"202");
  events = await send({ ...payloadFor(rejected),errors:[{ message:"failed" }] });
  assert.equal(events.find(event => event.type === "REPLY_RESULT").status,"unknown","返回新帖子同时带错误时不能宣称一定失败");
  events = await send({ errors:[{ message:"failed" }] });
  assert.equal(events.find(event => event.type === "REPLY_RESULT").status,"failed");
  events = await send({}, { status:429 });
  assert.equal(events.find(event => event.type === "REPLY_RESULT").status,"failed");
  events = await send({}, { status:500 });
  assert.equal(events.find(event => event.type === "REPLY_RESULT").status,"unknown");
  events = await send(payloadFor(demoTweets[2]),{ switchAccount:true });
  assert.equal(events.some(event => event.type === "REPLY_RESULT"),false);
  account = "my_account";
  events = await send(payloadFor(demoTweets[0]),{ draftBody:JSON.stringify({ variables:{ tweet_text:"原帖" } }) });
  assert.equal(events.some(event => event.type.startsWith("REPLY_")),false);
  const start = messages.length;
  const xhr = new Xhr();
  xhr.open("POST",url); xhr.send(body); xhr.complete(payloadFor(demoTweets[2]));
  await settle();
  assert.equal(messages.slice(start).find(event => event.type === "REPLY_RESULT").status,"sent");
  await new Promise(resolve => setTimeout(resolve,220));
  assert.equal(messages.filter(event => event.type === "OBSERVED").flatMap(event => event.batch.tweets)
    .some(tweet => tweet.id === rejected.id),false,"失败回执不能写成已回复");
});
