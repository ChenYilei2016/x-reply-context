import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import '../extension/core.js';
import {performanceState,fixtureRootId} from './diagnostics/performance-fixture.mjs';
const core=globalThis.XReplyContext;
const observer=await readFile(new URL('../extension/observe.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function observerEnvironment(payload) {
  const messages=[],listeners=[],timers=new Map();let timerId=0;
  class Xhr extends EventTarget {
    open(){} send(){}
    abort(){this.dispatchEvent(new Event('abort'));this.dispatchEvent(new Event('loadend'));}
    complete(){this.status=200;this.responseType='json';this.response={data:{favorite_tweet:'Done'}};this.dispatchEvent(new Event('load'));this.dispatchEvent(new Event('loadend'));}
  }
  const location={origin:'https://x.com',href:'https://x.com/notifications'};
  const window={postMessage:message=>messages.push(message),addEventListener:(_name,fn)=>listeners.push(fn),
    fetch:async()=>new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}})};
  const context=vm.createContext({XReplyContext:core,XMLHttpRequest:Xhr,window,location,URL,Request,TextDecoder,
    document:{querySelector:()=>({getAttribute:()=>'/me'})},
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(observer,context);
  listeners.forEach(fn=>fn({source:window,origin:location.origin,data:{channel:'x-reply-context-v1',type:'READY'}}));
  return {Xhr,window,messages,timers};
}
test('XHR取消后复用，只记录当前成功请求，不污染旧帖',async()=>{
  const {Xhr,messages}=observerEnvironment();const xhr=new Xhr();
  const send=id=>{xhr.open('POST','https://x.com/i/api/graphql/hash/FavoriteTweet');xhr.send(JSON.stringify({variables:{tweet_id:id}}));};
  send('123');xhr.abort();send('456');xhr.complete();await tick();await tick();
  assert.deepEqual(messages.filter(m=>m.type==='OBSERVED').flatMap(m=>m.batch.likes.map(l=>l.id)),['456']);
});
test('同一响应的完整/部分帖子对象均保留完整关系，与顺序无关',()=>{
  const full={id:'101',author_id:'2',text:'reply',conversation_id:'100',in_reply_to_user_id:'1',referenced_tweets:[{type:'replied_to',id:'100'}]};
  const partial={id:'101',author_id:'2',text:'reply'};
  for(const entries of [[partial,full],[full,partial]]){
    const tweet=core.extract({entries}).tweets[0];
    assert.deepEqual([tweet.conversationId,tweet.parentId,tweet.recipientId],['100','100','1']);
  }
});
test('单响应600条经过观察器仍全部输出，每批不超过500',async()=>{
  const entries=Array.from({length:600},(_,i)=>({id:String(i+1),author_id:'2',text:'fixture',referenced_tweets:[]}));
  const {window,messages,timers}=observerEnvironment({entries});
  await window.fetch('/i/api/graphql/hash/NotificationsTimeline');
  for(let i=0;i<20;i++)await tick();for(const fn of [...timers.values()])fn();
  const batches=messages.filter(m=>m.type==='OBSERVED').map(m=>m.batch);
  assert.equal(new Set(batches.flatMap(b=>b.tweets.map(t=>t.id))).size,600);
  assert.ok(batches.every(b=>b.tweets.length<=500&&b.users.length<=500&&b.likes.length<=500));
});
test('重复已知数据只刷新保留时间，不全量枚举或重建分类索引',()=>{
  const now=Date.now(),state=performanceState(core,now),tweet=state.tweets[fixtureRootId(0)],user=state.users['2'];
  const before=core.classify(state,'me',tweet.id);core.saved(state);
  for(const name of ['users','tweets','roots','replies','likes','people'])state[name]=new Proxy(state[name],{ownKeys(){throw new Error(`重复观察不应枚举 ${name}`);}});
  core.ingest(state,{users:[user],tweets:[tweet]},'me',now+1);
  assert.deepEqual(core.classify(state,'me',tweet.id),before);
  assert.equal(state.tweets[tweet.id].seenAt,now+1);
});
test('重复回复刷新关联证据时间，跨过旧到期点仍保留统计；真正过期后清理',()=>{
  const start=1e12,state=core.createState();
  const users=[{id:'1',handle:'me'},{id:'2',handle:'peer'}];
  const root={id:'100',authorId:'2',conversationId:'100',parentId:'',recipientId:'',text:'root'};
  const reply={id:'101',authorId:'1',conversationId:'100',parentId:'100',recipientId:'2',text:'reply'};
  core.ingest(state,{users,tweets:[root,reply]},'me',start);core.classify(state,'me','100');core.saved(state);
  const recent=start+core.RETENTION_MS-10;
  assert.equal(core.ingest(state,{users,tweets:[root,reply]},'me',recent),false);
  assert.equal(state.replies['1:100:2'].seenAt,recent);assert.equal(state.people['1:2'].seenAt,recent);
  core.ingest(state,{users,tweets:[root,reply]},'me',start+core.RETENTION_MS+2);
  assert.equal(core.classify(state,'me','100').personStats.myCommentedPosts,1);
  core.ingest(state,{},'me',start+2*core.RETENTION_MS+3);
  assert.equal(Object.keys(state.replies).length,0);
});
test('真实关系补全和新账号仍重建统计与分类',()=>{
  const state=core.createState(),now=Date.now();
  const reply={id:'101',authorId:'1',parentId:'100',recipientId:'2',text:'reply'};
  core.ingest(state,{users:[{id:'1',handle:'me'},{id:'2',handle:'peer'}],tweets:[reply]},'me',now);
  assert.equal(core.classify(state,'me','101').rootId,'');
  assert.equal(core.ingest(state,{tweets:[{id:'100',authorId:'2',conversationId:'100',text:'root'}]},'me',now+1),true);
  assert.equal(core.classify(state,'me','100').personStats.myCommentedPosts,1);
  core.ingest(state,{},'peer',now+2);
  assert.equal(core.classify(state,'peer','101').personStats.theirCommentedPosts,1);
});
test('成功回复的大响应：即时回执与普通批次合计保留600帖，创建记录只传一次',async()=>{
  const created={rest_id:'999',legacy:{user_id_str:'1',full_text:'reply',conversation_id_str:'100',in_reply_to_status_id_str:'100',in_reply_to_user_id_str:'2'},core:{user_results:{result:{rest_id:'1',legacy:{screen_name:'me'}}}}};
  const extras=Array.from({length:599},(_,i)=>({id:String(i+1000),author_id:'2',text:'context',referenced_tweets:[]}));
  const {window,messages,timers}=observerEnvironment({data:{create_tweet:{tweet_results:{result:created}},extras}});
  await window.fetch('/i/api/graphql/hash/CreateTweet',{method:'POST',body:JSON.stringify({variables:{reply:{in_reply_to_tweet_id:'100'}}})});
  for(let i=0;i<20;i++)await tick();for(const fn of [...timers.values()])fn();
  const batches=messages.filter(m=>m.type==='OBSERVED'||m.type==='REPLY_RESULT'&&m.status==='sent').map(m=>m.batch);
  const tweets=batches.flatMap(b=>b.tweets);
  assert.equal(tweets.length,600);assert.equal(new Set(tweets.map(t=>t.id)).size,600);
  assert.ok(batches.every(b=>b.tweets.length<=500));
  assert.equal(messages.find(m=>m.type==='REPLY_RESULT').batch.tweets[0].id,'999');
});
test('重复观察保存时间但不广播；关系变化保存失败后再次成功仍广播',async()=>{
  const now=Date.now(),state=core.createState(),user={id:'1',handle:'me'};
  core.ingest(state,{users:[user]},'me',now);core.saved(state);
  let listener,fail=false,saves=0;const broadcasts=[];
  const scope=vm.createContext({URL,console,setTimeout,importScripts(){},XReplyContext:core,
    XReplyStorage:{create:()=>({load:async()=>state,save:async()=>{saves++;if(fail){fail=false;throw new Error('test write failure');}core.saved(state);}})},
    chrome:{runtime:{id:'test',getURL:p=>`chrome-extension://test${p}`,onMessage:{addListener:fn=>{listener=fn;}}},storage:{local:{set:async value=>broadcasts.push(value)}}}});
  vm.runInContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),scope);
  const send=batch=>new Promise(resolve=>listener({type:'INGEST',account:'me',batch},{id:'test',url:'https://x.com/notifications'},resolve));
  assert.equal((await send({users:[user]})).changed,false);assert.equal(saves,1);assert.equal(broadcasts.length,0);
  const tweet={id:'100',authorId:'1',conversationId:'100',text:'new'};
  fail=true;assert.equal((await send({tweets:[tweet]})).ok,false);
  const recovered=await send({tweets:[tweet]});assert.equal(recovered.changed,true);assert.equal(broadcasts.length,1);
  const duplicate=await send({tweets:[tweet]});assert.equal(duplicate.changed,false);assert.equal(duplicate.revision,recovered.revision);
});
