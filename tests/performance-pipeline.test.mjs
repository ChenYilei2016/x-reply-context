import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import '../extension/core.js';
import '../extension/interaction-report-data.js';
import '../extension/reply-skip-authors.js';
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
  assert.equal(Object.keys(state.likes).length,20000);
  assert.ok(state.likes[`${old.actorId}:111`]);
  core.ingest(state,{likes:[{id:'111',account:'me',liked:false,observedAt:now+core.RETENTION_MS+2}]},'me',now+core.RETENTION_MS+2);
  assert.ok(Object.keys(state.likes).length<20000);
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

test('人物统计首次读取补记先到评论，保存失败时下次读取重试',async()=>{
  const state=core.createState();state.statistics={version:2,incomplete:false};
  core.ingest(state,{users:[{id:'1',handle:'me'},{id:'2',handle:'peer'}],
    tweets:[{id:'100',authorId:'1',conversationId:'100'},{id:'101',authorId:'2',conversationId:'100',parentId:'100',recipientId:'1'}]},'');
  core.saved(state);
  let listener,saves=0;
  const context=vm.createContext({URL,console,setTimeout,importScripts(){},XReplyContext:core,
    XReplyStorage:{create:()=>({load:async()=>state,save:async()=>{
      if(++saves===1)throw Error('模拟保存中断');
      assert.deepEqual([...core.interactionChanges(state).facts.keys()],['1:2:in:100']);
      state.people['1:2']={myCommentedPosts:0,theirCommentedPosts:1};
      core.saved(state);
    }})},chrome:{runtime:{id:'test',getURL:p=>`chrome-extension://test${p}`,onMessage:{addListener:f=>{listener=f;}}},storage:{local:{set:async()=>{}}}}});
  vm.runInContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),context);
  const read=()=>new Promise(resolve=>listener({type:'PERSON_STATS',account:'me',authors:['peer']},
    {id:'test',url:'https://x.com/home'},resolve));
  assert.equal((await read()).ok,false);
  assert.equal((await read()).rows[0].personStats.theirCommentedPosts,1);
  assert.equal((await read()).rows[0].personStats.theirCommentedPosts,1);
  assert.equal(saves,2);
});

test('个人资料过期后报表沿用已核验的账号，名单和部分回执只接受匹配的身份',async()=>{
  const state=core.createState(),now=Date.now();
  state.statistics={version:2,incomplete:true};
  core.ingest(state,{users:[{id:'1',handle:'me'}]},'me',now-core.RETENTION_MS-1);
  core.ingest(state,{users:[{id:'2',handle:'peer'},{id:'3',handle:'new_peer'}],
    tweets:[{id:'100',authorId:'2',conversationId:'100'},{id:'201',authorId:'3',conversationId:'201'}]},'',now);
  core.saved(state);
  assert.equal(core.findAccount(state,'me'),null);
  state.people['1:2']={myCommentedPosts:3,theirCommentedPosts:4};
  let listener;
  const written=[], lists={};
  const context=vm.createContext({URL,console,setTimeout,importScripts(){},XReplyContext:core,
    XReplyInteractionReport:globalThis.XReplyInteractionReport,XReplySkipAuthors:globalThis.XReplySkipAuthors,
    XReplyStorage:{create:()=>({load:async()=>state,save:async()=>{
      written.push(...core.interactionChanges(state).facts.keys());core.saved(state);
    }})},chrome:{runtime:{id:'test',getURL:path=>new URL(path,'chrome-extension://test/').href,onMessage:{addListener:fn=>{listener=fn;}}},
      storage:{local:{get:async()=>structuredClone(lists),set:async values=>Object.assign(lists,structuredClone(values))}}}});
  vm.runInContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),context);
  const send=(message,url='https://x.com/home')=>new Promise(resolve=>listener(message,{id:'test',url,frameId:0},resolve));
  const reportUrl='chrome-extension://test/interaction-report.html?account=me';
  const reportQuery={type:'INTERACTION_REPORT',account:'me',accountId:'1'};
  const report=await send(reportQuery,reportUrl);
  assert.equal(report.rows[0].theirCommentedPosts,4);
  const add={...reportQuery,type:'INTERACTION_REPORT_SET_WHITELIST',author:'peer',peerId:'2',whitelisted:true};
  assert.equal((await send({...add,accountId:'3'},reportUrl)).ok,false);
  assert.equal((await send({...add,peerId:'3'},reportUrl)).ok,false);
  assert.equal((await send(add,reportUrl)).ok,true);
  assert.equal((await send({...reportQuery,filter:'whitelist'},reportUrl)).rows[0].peerId,'2');
  assert.equal((await send({type:'CLASSIFY',account:'me',ids:['100']})).accountId,'1');
  assert.equal((await send({...add,author:'',whitelisted:false},reportUrl)).ok,true);
  assert.equal((await send({...reportQuery,filter:'whitelist'},reportUrl)).total,0);
  const stats=await send({type:'PERSON_STATS',account:'me',authors:['201','999'].map(postId=>({postId,authorHandle:'new_peer'}))});
  assert.equal(stats.accountId,'1');
  assert.deepEqual(Array.from(stats.rows,row=>[row.postId,row.postAuthorConfirmed]),[['201',true],['999',false]]);
  const fromFeed={type:'SET_REPLY_WHITELIST_AUTHOR',account:'me',accountId:'1',postId:'201',peerId:'3',whitelisted:true};
  assert.equal((await send({...fromFeed,accountId:'9'})).ok,false);
  assert.equal((await send({...fromFeed,peerId:'2'})).ok,false);
  assert.equal((await send({...fromFeed,postId:'999'})).ok,false);
  assert.equal(listener(fromFeed,{id:'test',url:'https://x.com/home',frameId:1},()=>{}),false);
  assert.equal((await send(fromFeed)).ok,true);
  assert.equal((await send({...reportQuery,filter:'whitelist'},reportUrl)).rows[0].peerId,'3');
  assert.equal((await send({...fromFeed,whitelisted:false})).ok,true);
  assert.equal((await send({...reportQuery,filter:'whitelist'},reportUrl)).total,0);
  const receipt={type:'RECORD_REPLY_EVIDENCE',account:'me',parentId:'100',reply:{id:'101',authorId:'1',parentId:'100'}};
  assert.equal((await send({...receipt,reply:{...receipt.reply,authorId:'3'}})).changed,false);
  assert.equal((await send({...receipt,parentId:'200'})).changed,false);
  assert.equal((await send(receipt)).changed,true);
  assert.deepEqual(written,['1:2:out:100']);
  core.ingest(state,{users:[{id:'9',handle:'me'}]},'',now+1);
  assert.equal((await send({...receipt,reply:{...receipt.reply,id:'102',authorId:'9'}})).changed,false);
  assert.equal(state.tweets['102'],undefined);
});
