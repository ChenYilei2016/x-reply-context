import vm from "node:vm";
import { readFile,writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { users,demoTweets,post,graphql } from "../fixtures.mjs";

const sources = await Promise.all(["core.js","observe.js","card-filter.js","notification-filter.js"]
  .map(name => process.argv[3] ? execFileSync("git",["show",`${process.argv[3]}:extension/${name}`],{ encoding:"utf8" }) :
    readFile(new URL(`../../extension/${name}`,import.meta.url),"utf8")));
const cases = [];
for (const operation of ["TweetDetail","TweetResultByRestId","NotificationsTimeline","HomeTimeline",
  "HomeLatestTimeline","UserRepliesTimeline","REST-all","REST-mentions","REST-verified",
  "CreateTweet","CreateNoteTweet","TweetDetail-no-history"]) {
  for (const transport of ["fetch","xhr"]) {
    let modal = false;
    let state;
    let core;
    const timers = [];
    const requests = [];
    const messages = [];
    const listeners = [];
    const location = { origin:"https://x.com",href:"https://x.com/notifications",pathname:"/notifications" };
    const card = {
      id:demoTweets[8].id,isConnected:true,attributes:new Map(),closest:() => null,
      hasAttribute(key) { return this.attributes.has(key); },
      getAttribute(key) { return this.attributes.get(key) ?? null; },
      setAttribute(key,value) { this.attributes.set(key,value); },
      removeAttribute(key) { this.attributes.delete(key); },
      getBoundingClientRect:() => ({ top:120,bottom:280,height:160 })
    };
    const anchor = { previousElementSibling:null,before(button) {
      button.isConnected = true; button.children?.forEach(child => { child.isConnected = true; });
      this.previousElementSibling = button;
    } };
    const primary = { querySelector:() => ({ parentElement:anchor }),querySelectorAll:() => [card] };
    const document = {
      querySelector:selector => selector.includes("AppTabBar_Profile_Link") ? { getAttribute:() => "/my_account" } : primary,
      querySelectorAll:() => card.hasAttribute("data-xrc-notification-hidden") ? [card] : [],
      createElement:() => ({ isConnected:false,children:[],append(...items) { this.children.push(...items); },
        before(button) { button.isConnected = true; this.previousElementSibling = button; },
        setAttribute() {},addEventListener() {},remove() { this.isConnected = false; } })
    };
    const historical = post("2112500000000099999","101",demoTweets[5].id,card.id,"303","历史回复，并非当前空回复框发出");
    const result = graphql(historical);
    if (operation === "CreateNoteTweet") {
      delete result.legacy.full_text;
      result.note_tweet = { note_tweet_results:{ result:{ text:historical.text } } };
    }
    const payload = operation.startsWith("REST-") ? {
      globalObjects:{ tweets:{ [historical.id]:result.legacy },users:Object.fromEntries(users.map(u =>
        [u.id,{ id_str:u.id,screen_name:u.handle }])) }
    } : operation.startsWith("Create") ? {
      data:{ [operation === "CreateTweet" ? "create_tweet" : "notetweet_create"]:{ tweet_results:{ result } } }
    } : { data:{ timeline:{ result:graphql(operation.endsWith("no-history") ? demoTweets[8] : historical) } } };
    class Xhr {
      handlers = {};
      open(_method,url) { this.url = url; }
      addEventListener(name,handler) { (this.handlers[name] ||= []).push(handler); }
      send() {
        requests.push(this.url); this.status = 200; this.responseType = "json"; this.response = payload;
        for (const handler of this.handlers.load || []) handler();
      }
    }
    const window = {
      innerHeight:720,scrollY:0,
      fetch:async url => { requests.push(url); return new Response(JSON.stringify(payload),{ headers:{ "content-type":"application/json" } }); },
      addEventListener:(_name,listener) => listeners.push(listener),
      postMessage:data => {
        messages.push(data);
        if (data.type === "OBSERVED" || (data.type === "REPLY_RESULT" && data.status === "sent")) {
          core.ingest(state,data.batch,"my_account");
        }
      }
    };
    const context = vm.createContext({ window,document,location,XMLHttpRequest:Xhr,URL,Request,TextDecoder,
      setTimeout:callback => timers.push(callback),clearTimeout() {} });
    for (const source of sources) vm.runInContext(source,context);
    core = context.XReplyContext; state = core.createState();
    core.ingest(state,{ users,tweets:demoTweets,likes:[{ id:card.id,account:"my_account",liked:true,observedAt:Date.now() }] },"my_account");
    for (const listener of listeners) listener({ source:window,origin:location.origin,data:{ channel:"x-reply-context-v1",type:"READY" } });
    const filter = context.XReplyNotificationFilter.create({
      accountHandle:() => "my_account",tweetId:a => a.id,columnSelector:"column",
      enabled:() => true,ready:() => true,save:async () => {},holdLayout:() => modal,
      message:async request => ({ rows:request.ids.map(id => core.classify(state,request.account,id)) })
    });
    await filter.refresh();
    const before = core.classify(state,"my_account",card.id);
    modal = true;
    const url = operation.startsWith("REST-") ? `https://x.com/i/api/2/notifications/${operation.slice(5)}.json` :
      `https://x.com/i/api/graphql/review/${operation.replace("-no-history","")}`;
    const body = operation.startsWith("Create") ? JSON.stringify({ variables:{ reply:{ in_reply_to_tweet_id:card.id } } }) : undefined;
    if (transport === "fetch") await window.fetch(url,body ? { method:"POST",body } : undefined);
    else { const xhr = new Xhr(); xhr.open(body ? "POST" : "GET",url); xhr.send(body); }
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    while (timers.length) timers.shift()();
    filter.invalidate(); await filter.refresh();
    modal = false; await filter.refresh();
    const after = core.classify(state,"my_account",card.id);
    const hiddenAfterEmptyClose = card.hasAttribute("data-xrc-notification-hidden");
    const correctlyRecorded = after.status === (operation.endsWith("no-history") ? "unknown" : "replied");
    cases.push({ operation,transport,before:before.status,after:after.status,evidence:after.evidenceId,
      createRequests:requests.filter(url => /Create(?:Note)?Tweet/.test(url)).length,
      hiddenAfterEmptyClose,stable:!hiddenAfterEmptyClose,correctlyRecorded });
  }
}
const result = { cases,stable:cases.every(row => row.stable && row.correctlyRecorded) };
if (process.argv[2]) await writeFile(process.argv[2],JSON.stringify(result,null,2));
console.log(JSON.stringify({ cases:cases.length,stable:result.stable,hiddenWithoutSend:cases.filter(row =>
  row.createRequests === 0 && row.hiddenAfterEmptyClose).length,incorrectRecords:cases.filter(row => !row.correctlyRecorded).length },null,2));
if (!result.stable) process.exitCode = 1;
