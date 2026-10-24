import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { users,post,graphql,demoTweets } from "./fixtures.mjs";
import "../extension/core.js";
const core = globalThis.XReplyContext;

test("主页原帖可查已评论依据，楼中楼按原帖去重而通知仍按人判断", () => {
  const state = core.createState();
  core.ingest(state,{ users,tweets:demoTweets },"my_account");
  const original = core.classify(state,"my_account",demoTweets[5].id);
  assert.equal(original.status,"not-reply");
  assert.equal(original.evidenceId,demoTweets[6].id);
  assert.equal(core.classify(state,"my_account",demoTweets[0].id).origin,"mine");
  const root = post("2112500000000060001","202","2112500000000060001");
  const bob = post("2112500000000060002","303",root.id,root.id,"202");
  const mine = post("2112500000000060003","101",root.id,bob.id,"303");
  const alice = post("2112500000000060004","202",root.id,bob.id,"303");
  core.ingest(state,{ tweets:[root,bob,mine,alice] },"my_account");
  assert.equal(core.classify(state,"my_account",root.id).evidenceId,mine.id,"楼中楼也证明这篇原帖评过了");
  assert.equal(core.classify(state,"my_account",alice.id).status,"unknown","通知不跨人套用已回");
  assert.equal(core.classify(state,"my_account",alice.id).personStats.myCommentedPosts,2);
});

test("长帖正文只有 note_tweet 时仍提取帖子关系和片段", () => {
  const value = graphql(demoTweets[6]);
  delete value.legacy.full_text;
  value.note_tweet = { note_tweet_results:{ result:{ text:"长评论正文".repeat(60) } } };
  const parsed = core.extract(value);
  assert.equal(parsed.tweets.length,1);
  assert.equal(parsed.tweets[0].parentId,demoTweets[5].id);
  assert.equal(parsed.tweets[0].text.length,200);
});

test("主页两种时间线与普通/长评论经 fetch/XHR 保存一次，随后通知识别为已回", async t => {
  const sources = {
    core:await readFile(new URL("../extension/core.js",import.meta.url),"utf8"),
    observer:await readFile(new URL("../extension/observe.js",import.meta.url),"utf8")
  };
  for (const homeOperation of ["HomeTimeline","HomeLatestTimeline"]) {
    for (const replyOperation of ["CreateTweet","CreateNoteTweet"]) {
      for (const transport of ["fetch","xhr"]) {
        await t.test(`${homeOperation} / ${replyOperation} / ${transport}`,async () => {
          const state = core.createState();
          core.ingest(state,{ users },"my_account");
          let response;
          let requestPromise;
          let account = "my_account";
          let writes = 0;
          let finished;
          const location = { origin:"https://x.com",href:"https://x.com/home" };
          const listeners = [];
          class Xhr extends EventTarget {

            open() {}
            send() {}

            complete(payload) {
              this.status = 200;
              this.responseType = "json";
              this.response = payload;
              this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend'));
            }
          }
          const window = {
            fetch:() => requestPromise,
            addEventListener:(_name,fn) => listeners.push(fn),
            postMessage:event => {
              if (event.type !== "OBSERVED" && !(event.type === "REPLY_RESULT" && event.status === "sent")) return;
              core.ingest(state,event.batch,event.account || account);
              if (event.batch.tweets.some(tweet => tweet.authorId === "101" && tweet.parentId)) writes++;
              finished?.();
            }
          };
          const context = vm.createContext({ window,location,XMLHttpRequest:Xhr,URL,Request,TextDecoder,
            setTimeout:fn => setTimeout(fn,0),clearTimeout,
            document:{ querySelector:() => ({ getAttribute:() => `/${account}` }) }
          });
          vm.runInContext(sources.core,context);
          vm.runInContext(sources.observer,context);
          listeners.forEach(fn => fn({ source:window,origin:location.origin,
            data:{ channel:"x-reply-context-v1",type:"READY" } }));
          async function receive(operation,payload,body) {
            const saved = new Promise(resolve => { finished = resolve; });
            const url = `https://x.com/i/api/graphql/rotatedQueryId/${operation}`;
            if (transport === "xhr") {
              const xhr = new Xhr();
              xhr.open(body ? "POST" : "GET",url);
              xhr.send(body);
              xhr.complete(payload);
            } else {
              response = new Response(JSON.stringify(payload),{ headers:{ "content-type":"application/json" } });
              requestPromise = Promise.resolve(response);
              const request = body && replyOperation === "CreateNoteTweet" ?
                new Request(url,{ method:"POST",body }) : null;
              assert.equal(request ? window.fetch(request) : window.fetch(url,body ? { method:"POST",body } : {}),requestPromise);
              if (request) assert.equal(request.bodyUsed,false);
            }
            let timeout;
            try {
              await Promise.race([saved,new Promise((_,reject) => {
                timeout = setTimeout(() => reject(new Error(`${operation} 未进入记录链路`)),200);
              })]);
            } finally { clearTimeout(timeout); }
          }
          await receive(homeOperation,{ data:{ home:{ entries:[{ result:graphql(demoTweets[5]) }] } } });
          const entry = homeOperation === "HomeTimeline" ?
            (transport === "xhr" ? "/compose/post" : "/home") :
            (transport === "fetch" ? `/alice/status/${demoTweets[5].id}` : "/notifications");
          location.href = `https://x.com${entry}`;
          const wrapper = replyOperation === "CreateNoteTweet" ? "notetweet_create" : "create_tweet";
          const result = graphql(demoTweets[6]);
          if (replyOperation === "CreateNoteTweet") {
            delete result.legacy.full_text;
            result.note_tweet = { note_tweet_results:{ result:{ text:demoTweets[6].text } } };
          }
          const visibleResult = replyOperation === "CreateNoteTweet" && transport === "xhr" ?
            { __typename:"TweetWithVisibilityResults",tweet:result } : result;
          await receive(replyOperation,{ data:{ [wrapper]:{ tweet_results:{ result:visibleResult } } } },
            JSON.stringify({ variables:{ reply:{ in_reply_to_tweet_id:demoTweets[5].id } } }));
          assert.equal(writes,1);
          assert.equal(core.classify(state,account,demoTweets[5].id).evidenceId,demoTweets[6].id);
          assert.equal(state.people["101:202"].myCommentedPosts,1);
          location.href = "https://x.com/notifications";
          await receive("NotificationsTimeline",{ data:{ entries:[{ result:graphql(demoTweets[7]) }] } });
          const notification = core.classify(state,account,demoTweets[7].id);
          assert.equal(notification.status,"replied");
          assert.equal(notification.origin,"others");
          assert.equal(notification.evidenceId,demoTweets[6].id);
          assert.equal(notification.personStats.myCommentedPosts,1);
          assert.equal(writes,1,"通知重载不再次保存同一发送回执");
        });
      }
    }
  }
});
