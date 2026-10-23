import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const sources = await Promise.all(['core.js','observe.js'].map(name => readFile(new URL(`../extension/${name}`,import.meta.url),'utf8')));
for (const transport of ['fetch','xhr']) test(`${transport} 点赞必须等成功回执，但回执后不再等200ms合批`,async () => {
  const messages = []; const listeners = []; const timers = [];
  const location = { origin:'https://x.com',href:'https://x.com/notifications' };
  let respond;
  const response = new Promise(resolve => { respond = resolve; });
  class Xhr {
    handlers = {};
    open() {} send() {}
    addEventListener(name,fn) { this.handlers[name] = fn; }
    complete() { this.status=200; this.responseType='json'; this.response={ data:{ favorite_tweet:'Done' } }; this.handlers.load(); }
  }
  const window = { fetch:() => response,postMessage:message => messages.push(message),
    addEventListener:(_name,fn) => listeners.push(fn) };
  const context = vm.createContext({ window,location,XMLHttpRequest:Xhr,URL,Request,TextDecoder,
    document:{ querySelector:() => ({ getAttribute:() => '/me' }) },
    setTimeout:(fn,delay) => { timers.push({ fn,delay }); return timers.length; },clearTimeout() {} });
  sources.forEach(source => vm.runInContext(source,context));
  listeners.forEach(fn => fn({ source:window,origin:location.origin,data:{ channel:'x-reply-context-v1',type:'READY' } }));
  const url = 'https://x.com/i/api/graphql/hash/FavoriteTweet';
  const body = JSON.stringify({ variables:{ tweet_id:'123' } });
  let xhr;
  if (transport === 'fetch') void window.fetch(url,{ method:'POST',body });
  else { xhr = new Xhr(); xhr.open('POST',url); xhr.send(body); }
  assert.equal(messages.some(message => message.type === 'OBSERVED'),false);
  if (xhr) xhr.complete();
  else respond(new Response(JSON.stringify({ data:{ favorite_tweet:'Done' } }),{ headers:{ 'content-type':'application/json' } }));
  for (let i=0;i<20 && !messages.some(message => message.type === 'OBSERVED');i++) await new Promise(resolve => setImmediate(resolve));
  const observed = messages.find(message => message.type === 'OBSERVED');
  assert.ok(observed,'没有执行任何合批计时器也应立即收到成功回执');
  assert.equal(observed.interaction,true);
  assert.equal(observed.account,'me'); assert.equal(observed.batch.likes[0].id,'123');
  assert.equal(observed.batch.likes[0].source,'mutation');
  assert.equal(timers.length,0);
});

for (const readyBefore of [true,false]) test(`连续响应超过500条不截断；观察器${readyBefore?'已就绪':'等待握手'}`,async()=>{
  const messages=[],listeners=[],timers=new Map();let task=0,sequence=0;
  const location={origin:'https://x.com',href:'https://x.com/notifications'};
  const window={postMessage:message=>messages.push(message),addEventListener:(_name,fn)=>listeners.push(fn),fetch:async()=>{
    const start=sequence++*300;
    return new Response(JSON.stringify({data:{entries:Array.from({length:300},(_,i)=>({rest_id:String(start+i+1),legacy:{
      user_id_str:'2',full_text:'fixture',conversation_id_str:String(start+i+1),in_reply_to_status_id_str:null
    }}))}}),{headers:{'content-type':'application/json'}});
  }};
  const scope=vm.createContext({window,location,URL,Request,TextDecoder,XMLHttpRequest:class{open(){} send(){}},
    document:{querySelector:()=>({getAttribute:()=>'/me'})},
    setTimeout:fn=>{timers.set(++task,fn);return task;},clearTimeout:id=>timers.delete(id)});
  sources.forEach(source=>vm.runInContext(source,scope));
  const ready=()=>listeners.forEach(fn=>fn({source:window,origin:location.origin,data:{channel:'x-reply-context-v1',type:'READY'}}));
  if(readyBefore)ready();
  await window.fetch('/i/api/graphql/test/NotificationsTimeline');
  await window.fetch('/i/api/graphql/test/NotificationsTimeline');
  for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
  if(!readyBefore)ready();
  for(const [id,fn] of [...timers]){timers.delete(id);fn();}
  const batches=messages.filter(message=>message.type==='OBSERVED').map(message=>message.batch);
  assert.equal(new Set(batches.flatMap(batch=>batch.tweets.map(tweet=>tweet.id))).size,600);
  assert.ok(batches.every(batch=>batch.tweets.length<=500));
});
