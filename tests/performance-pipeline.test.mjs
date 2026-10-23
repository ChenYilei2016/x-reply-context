import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import '../extension/core.js';
import {performanceState,fixtureRootId} from './diagnostics/performance-fixture.mjs';
const core=globalThis.XReplyContext;

test('上限记录中的单次红心只标记本条；复用分类索引而不枚举历史集合',()=>{
  const now=Date.now(), state=performanceState(core,now);
  const tweet=fixtureRootId(0), like=Object.values(state.likes)[0];
  core.classifyBatch(state,'me',[tweet]); core.saved(state);
  for(const name of ['users','tweets','roots','replies','likes','people']) {
    state[name]=new Proxy(state[name],{ownKeys(){throw new Error(`热路径全量枚举 ${name}`);}});
  }
  core.ingest(state,{likes:[{id:like.id,account:'me',liked:false,source:'mutation',observedAt:now+1}]},'me',now+1);
  core.classifyBatch(state,'me',[tweet]);
  const dirty=core.changes(state);
  assert.deepEqual([...dirty.likes],[`${like.actorId}:${like.id}`]);
  assert.ok(['users','tweets','roots','replies','people'].every(name=>dirty[name].size===0));
});

test('点赞热路径仍在过期或容量超限时维护上限并使分类缓存失效',()=>{
  const now=Date.now(),state=performanceState(core,now);
  const old=Object.values(state.likes)[0];
  core.classifyBatch(state,'me',[fixtureRootId(0)]);
  core.ingest(state,{likes:[{id:'111',account:'me',liked:true,observedAt:now+1}]},'me',now+1);
  assert.equal(Object.keys(state.likes).length,10000);
  assert.ok(state.likes[`${old.actorId}:111`]);
  core.ingest(state,{likes:[{id:'111',account:'me',liked:false,observedAt:now+core.RETENTION_MS+2}]},'me',now+core.RETENTION_MS+2);
  assert.ok(Object.keys(state.likes).length<10000);
  assert.equal(core.classifyBatch(state,'me',[fixtureRootId(0)])[0].likeEvidenceId,'');
});

test('互动越过后台排队批次，保持单写入与冷启动账号依赖',async()=>{
  const state=core.createState(), now=Date.now();
  core.ingest(state,{users:[{id:'1',handle:'me'}]},'me',now);
  let listener, release; const order=[]; let concurrent=0, maximum=0,block=false;
  const context=vm.createContext({URL,console,setTimeout,importScripts(){},XReplyContext:core,
    XReplyStorage:{create:()=>({load:async()=>state,save:async()=>{
      maximum=Math.max(maximum,++concurrent);
      if(block){block=false;await new Promise(resolve=>{release=resolve;});}
      concurrent--;
    }})},chrome:{runtime:{id:'test',getURL:p=>`chrome-extension://test${p}`,onMessage:{addListener:f=>{listener=f;}}},storage:{local:{set:async()=>{}}}}});
  vm.runInContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),context);
  const send=(name,message)=>new Promise(resolve=>listener(message,{id:'test',url:'https://x.com/notifications'},result=>{order.push(name);resolve(result);}));
  await send('warm',{type:'SUMMARY',account:'me'}); order.length=0;
  block=true;
  const first=send('busy',{type:'INGEST',account:'me',batch:{}});
  await new Promise(resolve=>setImmediate(resolve));
  const slow=send('ordinary',{type:'INGEST',account:'me',batch:{}});
  const fast=send('interaction',{type:'INGEST',account:'me',interaction:true,batch:{likes:[{id:'7',account:'me',liked:true,observedAt:now+1,source:'mutation'}]}});
  release(); await Promise.all([first,slow,fast]);
  assert.deepEqual(order,['busy','interaction','ordinary']); assert.equal(maximum,1);
  // A new account's mapping may still be queued; do not drop its receipt by running it too early.
  block=true; const busy=send('busy2',{type:'INGEST',account:'me',batch:{}});
  await new Promise(resolve=>setImmediate(resolve));
  const bootstrap=send('bootstrap',{type:'INGEST',account:'other',batch:{users:[{id:'2',handle:'other'}]}});
  const receipt=send('other-like',{type:'INGEST',account:'other',interaction:true,batch:{likes:[{id:'8',account:'other',liked:true,observedAt:now+2}]}});
  release(); await Promise.all([busy,bootstrap,receipt]);
  assert.equal(state.likes['2:8'].liked,true);
});
