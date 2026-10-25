import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import '../extension/core.js';
import '../extension/follow-context.js';
const core=globalThis.XReplyContext,make=globalThis.XReplyFollowContext.create;
const user=(id,perspective)=>({rest_id:id,core:{screen_name:'peer'+id},relationship_perspectives:perspective});
test('关注字段独立提取，不进入可保存batch或互动state；false与缺字段不同',()=>{
 const rows=[];
 const batch=core.extract({users:[user('2',{following:true,followed_by:false}),user('3',{following:false}),
  {rest_id:'4',legacy:{screen_name:'peer4',following:false,followed_by:true}},
  {rest_id:'5',core:{screen_name:'peer5'},relationship_counts:{following:3,followers:8}}]},r=>rows.push(r));
 assert.equal(rows.length,3);assert.equal(rows.find(r=>r.id==='2').followedBy,false);
 assert.equal(rows.find(r=>r.id==='3').followedBy,undefined);
 assert.ok(!JSON.stringify(batch).includes('follow'));
 const state=core.createState();core.ingest(state,batch,'peer2');assert.ok(!JSON.stringify(state).includes('follow'));
});
test('逐方向合并、旧响应保护、账号切换清空、页面清空',()=>{
 const cache=make();cache.setAccount('me');
 cache.ingest('me',[{id:'2',following:true,followedBy:false}],2);
 assert.equal(cache.ingest('me',[{id:'2',following:true}],3).length,0);
 cache.ingest('me',[{id:'2',following:false}],1);
 assert.equal(cache.read('me','2').following,true);assert.equal(cache.read('me','2').followedBy,false);
 cache.ingest('me',[{id:'2',followedBy:true}],4);
 assert.equal(cache.read('me','2').followedBy,true);
 cache.setAccount('other');assert.equal(cache.read('me','2'),undefined);
 assert.equal(cache.ingest('me',[{id:'2',following:true}],10).length,0);
 cache.setAccount('me');assert.equal(cache.read('me','2'),undefined);
 cache.ingest('me',[{id:'2',following:false}],5);cache.clear();assert.equal([...cache.values()].length,0);
});
test('每批最多500，每页最多10000，淘汰不写盘',()=>{
 const cache=make();cache.setAccount('me');
 for(let n=0;n<21;n++)cache.ingest('me',Array.from({length:500},(_,i)=>({id:String(n*500+i+1),following:true})),n+1);
 assert.equal([...cache.values()].length,10000);assert.equal(cache.read('me','1'),undefined);assert.equal(cache.read('me','10500').following,true);
});
const sources=await Promise.all(['core.js','follow-context.js','observe.js'].map(n=>readFile(new URL('../extension/'+n,import.meta.url),'utf8')));
function environment(){
 let account='me';const messages=[],listeners=new Map(),timers=new Map(),requests=[];let timer=0;
 class Xhr extends EventTarget {open(){} send(){} complete(payload){this.status=200;this.responseType='json';this.response=payload;this.dispatchEvent(new Event('load'));this.dispatchEvent(new Event('loadend'));}}
 const location={origin:'https://x.com',href:'https://x.com/notifications'};
 const window={postMessage:m=>messages.push(m),addEventListener:(name,fn)=>listeners.set(name,fn),fetch:()=>new Promise(resolve=>requests.push(resolve))};
 const context=vm.createContext({window,location,URL,Request,TextDecoder,XMLHttpRequest:Xhr,document:{querySelector:()=>({getAttribute:()=>'/'+account})},setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)});
 sources.forEach(s=>vm.runInContext(s,context));
 const signal=type=>listeners.get('message')({source:window,origin:location.origin,data:{channel:'x-reply-context-v1',type}});
 const settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));};
 const respond=async(index,payload)=>{requests[index](new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}}));await settle();};
 return {window,messages,requests,Xhr,signal,respond,settle,account:value=>{account=value;signal('NOTIFICATION_FILTER_CONTEXT');},hide:()=>listeners.get('pagehide')()};
}
test('fetch握手前数据只暂存，READY后独立发出；XHR亦复用，不新增请求',async()=>{
 const env=environment();const p=env.window.fetch('/i/api/graphql/hash/HomeTimeline');
 await env.respond(0,{data:user('2',{following:true,followed_by:false})});await p;
 assert.equal(env.messages.filter(m=>m.type==='FOLLOW_CONTEXT').length,0);
 env.signal('READY');const first=env.messages.find(m=>m.type==='FOLLOW_CONTEXT');assert.equal(first.account,'me');assert.equal(first.rows[0].following,true);
 const xhr=new env.Xhr();xhr.open('GET','/i/api/2/notifications/all.json');xhr.send();xhr.complete({users:[user('2',{following:false,followed_by:true})]});await env.settle();
 const next=env.messages.filter(m=>m.type==='FOLLOW_CONTEXT').at(-1);assert.equal(next.rows[0].following,false);assert.equal(next.rows[0].followedBy,true);
 assert.equal(env.requests.length,1);
 assert.ok(env.messages.filter(m=>m.batch).every(m=>!JSON.stringify(m.batch).includes('following')));
});
test('切换账号后又切回，旧请求不得重新带回关注关系；未知账号不采用',async()=>{
 const env=environment();env.signal('READY');const old=env.window.fetch('/i/api/graphql/hash/HomeTimeline');
 env.account('other');env.account('me');await env.respond(0,{data:user('2',{following:true})});await old;
 assert.equal(env.messages.filter(m=>m.type==='FOLLOW_CONTEXT').length,0);
 env.account('');const anonymous=env.window.fetch('/i/api/graphql/hash/HomeTimeline');env.account('me');await env.respond(1,{data:user('2',{followed_by:true})});await anonymous;
 assert.equal(env.messages.filter(m=>m.type==='FOLLOW_CONTEXT').length,0);
 const fresh=env.window.fetch('/i/api/graphql/hash/HomeTimeline');await env.respond(2,{data:user('2',{following:false})});await fresh;
 assert.equal(env.messages.filter(m=>m.type==='FOLLOW_CONTEXT').length,1);
});
