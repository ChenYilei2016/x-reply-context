import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/timed-replies.js',import.meta.url),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
function setup(config={enabled:true,minSeconds:10,maxSeconds:20,maxAttempts:2,maxMinutes:1},wallStart=1800000000000) {
 let clock=0,id=0,runSequence=0,listener;const timers=new Map(),events=new Map(),calls=[],interrupts=[],cancellations=[],wake=[];
 class Element {
  constructor(tag="div"){this.tag=tag;this.children=[];this.dataset={};this.isConnected=true;}
  closest(){return this;}setAttribute(){}addEventListener(){}
  append(...nodes){this.children.push(...nodes);}remove(){this.isConnected=false;}
  querySelector(selector){return this.children.find(n=>n.tag===selector);}
 }
 const state={supported:true,session:{},account:'me',id:'1',draft:'ready draft',ready:true,resumeReady:true};
 const document={hidden:false,body:new Element(),createElement:tag=>new Element(tag),addEventListener:(n,f)=>events.set(n,f)};
 const scope=vm.createContext({document,Element,location:{pathname:"/home"},crypto:{randomUUID:()=>"run-"+(++runSequence)},window:{addEventListener:(n,f)=>events.set(n,f)},Date:class extends Date{static now(){return wallStart+clock;}},performance:{now:()=>clock,getEntriesByType:()=>[{type:"navigate"}]},Math:Object.assign(Object.create(Math),{random:()=>0}),
  setTimeout:(fn,delay)=>{timers.set(++id,{fn,at:clock+delay});return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source,scope);
 let trigger=s=>{calls.push({id:s.id,at:clock});state.ready=false;return true;};
 const controller=scope.XReplyTimedReplies.create({storage:{local:{get:async()=>({timedReplies:config})},onChanged:{addListener:f=>{listener=f;}}},
  readState:()=>state,trigger:s=>trigger(s),requestRefresh(){},onInterrupt:reason=>interrupts.push(reason),cancelRefresh:id=>cancellations.push(id),
  keepAwake:(until,leaving=false)=>wake.push({until,leaving})});
 function advance(ms){const end=clock+ms;let iterations=0;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;assert.ok(++iterations<1000,'no timer loop');clock=next[1].at;timers.delete(next[0]);next[1].fn();}clock=end;}
 return {controller,state,calls,timers,advance,scope,document,events,Element,interrupts,cancellations,wake,setTrigger:f=>{trigger=f;},change:value=>listener({timedReplies:{newValue:value}},'local')};
}
test('默认关闭且间隔默认3～10秒，次数/时长均有界',async()=>{
 const env=setup(undefined);await flush();const api=env.scope.XReplyTimedReplies;assert.equal(env.timers.size,0,'仅开启设置不自动开始');
 assert.equal(api.defaults.enabled,false);assert.equal(api.defaults.minSeconds,3);assert.equal(api.defaults.maxSeconds,10);assert.equal(api.defaults.maxAttempts,500);
 for(const input of [{minSeconds:2},{minSeconds:30,maxSeconds:20},{maxAttempts:501},{maxMinutes:241}])assert.throws(()=>api.normalize(input));
 const off=setup({});await flush();off.controller.start();assert.equal(off.timers.size,0);
});
test('草稿就绪才计时，每次至少10秒，达到次数不再触发，始终只有一个计时器',async()=>{
 const env=setup();await flush();env.controller.start();assert.equal(env.timers.size,1);
 for(let i=0;i<100;i++)env.controller.refresh();assert.equal(env.timers.size,1);
 env.advance(9999);assert.equal(env.calls.length,0);env.advance(1);assert.equal(env.calls.length,1);
 env.state.id='2';env.state.draft='next';env.state.ready=true;env.controller.refresh();env.advance(10000);
 assert.equal(env.calls.length,2);assert.equal(env.timers.size,0);env.state.id='3';env.controller.refresh();env.advance(60000);assert.equal(env.calls.length,2);
});
test('空草稿只等待时长截止，不轮询、不请求AI、不无限重试',async()=>{
 const env=setup();await flush();env.state.ready=false;env.controller.start();assert.equal(env.timers.size,1);
 env.advance(60000);assert.equal(env.calls.length,0);assert.equal(env.timers.size,0);
 env.state.ready=true;env.controller.refresh();assert.equal(env.timers.size,0);
});
test('时长截止优先于尚未到期的随机发送，不追赶补发',async()=>{
 const env=setup();await flush();env.state.ready=false;env.controller.start();env.advance(55000);
 env.state.ready=true;env.controller.refresh();env.advance(5000);assert.equal(env.calls.length,0);assert.equal(env.timers.size,0);
});
test('草稿/目标/账号/会话或异常状态变化立即停止，不自行恢复',async()=>{
 for(const update of [{draft:'changed'},{id:'2'},{account:'other'},{session:{}},{reason:'rate limited'},{ready:false}]){
  const env=setup();await flush();env.controller.start();Object.assign(env.state,update);env.controller.refresh();env.advance(20000);
  assert.equal(env.calls.length,0);assert.equal(env.timers.size,0);env.state.reason='';env.state.ready=true;env.controller.refresh();assert.equal(env.timers.size,0);
 }
});
test('关闭设置、后台、失焦、离页及手动输入取消计时',async()=>{
 for(const action of ['settings','visibilitychange','blur','pagehide','input','compositionstart']){
  const env=setup();await flush();env.controller.start();
  if(action==='settings')env.change({enabled:false});
  else {env.document.hidden=true;env.events.get(action)({isTrusted:true,target:new env.Element()});}
  env.advance(20000);assert.equal(env.calls.length,0);assert.equal(env.timers.size,0);
  assert.deepEqual(env.wake.map(value=>value.until),[1800000060000,0]);
 }
});

test('防休眠随运行开始、暂停、继续和时长上限，不在普通浏览启用',async()=>{
 const env=setup();await flush();
 env.state.ready=false;
 env.controller.refresh();assert.deepEqual(env.wake,[]);
 env.controller.start();env.controller.pause();env.controller.continueRun();
 env.advance(60000);
 assert.deepEqual(env.wake.map(value=>value.until),[1800000060000,0,1800000060000,0]);
});

test('防休眠按标签页释放，旧文档不能释放新文档，失联在租约到期后清理',async()=>{
 const events=[],session={},alarms=new Map();let now=Date.now();
 const background=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 function boot() {
  let receive,onAlarm,id=0;
  const timers=new Map();
  const context=vm.createContext({URL,importScripts(){},XReplyContext:{},XReplyStorage:{create:()=>({})},
   Date:class extends Date{static now(){return now;}},
   setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
   chrome:{runtime:{id:'ext',getURL:()=> 'chrome-extension://ext/',onMessage:{addListener:fn=>{receive=fn;}}},
    storage:{session:{get:async()=>structuredClone(session),set:async data=>Object.assign(session,structuredClone(data)),
     remove:async key=>{delete session[key];}}},
    alarms:{get:async name=>alarms.get(name),create:async(name,options)=>alarms.set(name,options),
     clear:async name=>alarms.delete(name),onAlarm:{addListener:fn=>{onAlarm=fn;}}},
    power:{requestKeepAwake:level=>events.push(level),releaseKeepAwake:()=>events.push('release')}}});
  vm.runInContext(background,context);
  const send=(tab,documentId,until,frameId=0)=>new Promise(resolve=>{
   receive({type:'TIMED_KEEP_AWAKE',until},{id:'ext',tab:{id:tab},documentId,frameId,url:'https://x.com/home'},r=>resolve(r.ok));
  });
  return {send,timers,onAlarm:()=>onAlarm({name:[...alarms.keys()][0]})};
 }
 const until=now+60000,first=boot();
 assert.equal(await first.send(1,'nested',until,1),false);
 assert.equal(await first.send(1,'old',until),true);
 await first.send(2,'other',until);
 await first.send(1,'next',until);
 await first.send(1,'old',0);
 assert.deepEqual(events,['system']);assert.equal(first.timers.size,1);
 assert.equal([...first.timers.values()][0].ms,20000);
 const restarted=boot();
 await restarted.send(2,'other',0);
 assert.deepEqual(events,['system']);
 now+=61000;boot().onAlarm();await flush();
 assert.deepEqual(events,['system','release']);assert.equal(alarms.size,0);
});
test('最后一次发送收尾期间保留防休眠，完成后释放，不再触发下一次',async()=>{
 const env=setup({enabled:true,minSeconds:3,maxSeconds:3,maxAttempts:1,maxMinutes:1});
 await flush();env.setTrigger(()=>{env.state.settling=true;return true;});
 env.controller.start();env.advance(3000);
 assert.equal(env.controller.isFinishing(),true);
 assert.equal(env.wake.at(-1).until,1800000063000);
 env.advance(5000);env.state.settling=false;env.controller.refresh();
 assert.equal(env.wake.at(-1).until,0);assert.equal(env.controller.isFinishing(),false);
 assert.equal(env.timers.size,0);
});
test('触发失败不重试；同一目标未进入下一条时不重复发送',async()=>{
 const failed=setup();await flush();failed.setTrigger(()=>false);failed.controller.start();failed.advance(60000);assert.equal(failed.timers.size,0);
 const same=setup();await flush();same.setTrigger(s=>{same.calls.push(s.id);return true;});same.controller.start();same.advance(59000);assert.equal(same.calls.length,1);assert.equal(same.timers.size,1);same.advance(1000);assert.equal(same.timers.size,0);
});
test('随机等待包含上界，初始读取不覆盖较新的设置',async()=>{
 const env=setup();env.scope.Math.random=()=>1-Number.EPSILON;await flush();env.controller.start();env.advance(19999);assert.equal(env.calls.length,0);env.advance(1);assert.equal(env.calls.length,1);
 const raced=setup();raced.change({enabled:false});await flush();raced.controller.start();assert.equal(raced.timers.size,0);
});


test('跨两次自动换批保留次数与原截止时间，恢复后仍等待最少5秒',async()=>{
 const config={enabled:true,minSeconds:5,maxSeconds:5,maxAttempts:3,maxMinutes:1};
 const first=setup(config);await flush();first.controller.start();first.advance(5000);
 const ticket1=first.controller.prepareRefresh('refresh-a');assert.equal(ticket1.attempts,1);
 assert.equal(first.controller.commitRefresh('refresh-a'),true);first.events.get('pagehide')();assert.equal(first.timers.size,0);
 const second=setup(config,ticket1.capturedAt+2000);await flush();second.state.id='2';
 assert.equal(second.controller.previewResume(ticket1,'refresh-a'),true);second.controller.restore(ticket1,'refresh-a');
 second.advance(4999);assert.equal(second.calls.length,0);second.advance(1);assert.equal(second.calls.length,1);
 const ticket2=second.controller.prepareRefresh('refresh-b');assert.equal(ticket2.attempts,2);assert.equal(ticket2.expiresAt,ticket1.expiresAt);assert.ok(ticket2.remainingMs<ticket1.remainingMs);
 const third=setup(config,ticket2.capturedAt+2000);await flush();third.state.id='3';third.controller.previewResume(ticket2,'refresh-b');third.controller.restore(ticket2,'refresh-b');third.advance(5000);
 assert.equal(third.calls.length,1);assert.equal(third.timers.size,0);assert.equal(third.interrupts.length,0,'次数上限允许已触发本条收尾');
 third.state.id='4';third.state.ready=true;third.controller.refresh();third.advance(60000);assert.equal(third.calls.length,1);
});
test('手动停止取消本条后续动作和换批登记；远端取消不反向发CANCEL',async()=>{
 const env=setup();await flush();env.controller.start();env.advance(10000);
 const ticket=env.controller.prepareRefresh('refresh-a');env.controller.stop();
 assert.equal(env.interrupts.length,1);assert.deepEqual(env.cancellations,['refresh-a']);assert.equal(env.controller.validRefresh('refresh-a'),false);assert.equal(env.controller.commitRefresh('refresh-a'),false);
 const next=setup(undefined,ticket.capturedAt+100);await flush();next.state.id='2';next.controller.previewResume(ticket,'refresh-a');next.controller.restore(ticket,'refresh-a');next.controller.cancelFromRefresh('refresh-a');
 assert.equal(next.interrupts.length,1);assert.equal(next.cancellations.length,0);assert.equal(next.timers.size,0);
});
test('过期、设置变化、未来时间戳、预算耗尽的续接票拒绝；旧票不覆盖新轮',async()=>{
 const env=setup();await flush();env.controller.start();env.advance(10000);const ticket=env.controller.prepareRefresh('refresh-a');
 const next=setup(undefined,ticket.capturedAt+100);await flush();
 for(const bad of [{...ticket,attempts:2},{...ticket,expiresAt:ticket.capturedAt},{...ticket,capturedAt:ticket.capturedAt+1000},{...ticket,settings:{...ticket.settings,minSeconds:6}}])assert.equal(next.controller.previewResume(bad,'refresh-a'),false);
 next.controller.start();assert.equal(next.controller.previewResume(ticket,'refresh-a'),false);next.advance(10000);assert.equal(next.calls.length,1);
});


test('TAKE返回前的失焦或开关反复变化仍拒绝旧票，手动刷新/历史恢复不续跑',async()=>{
 const old=setup();await flush();old.controller.start();old.advance(10000);const ticket=old.controller.prepareRefresh('a');
 const early=setup(undefined,ticket.capturedAt+100);early.events.get('blur')();await flush();assert.equal(early.controller.previewResume(ticket,'a'),false);
 const toggled=setup(undefined,ticket.capturedAt+100);await flush();toggled.change({enabled:false});toggled.change(ticket.settings);assert.equal(toggled.controller.previewResume(ticket,'a'),false);
 const reload=setup(undefined,ticket.capturedAt+100);reload.scope.performance.getEntriesByType=()=>[{type:'reload'}];await flush();assert.equal(reload.controller.previewResume(ticket,'a'),false);
 old.controller.commitRefresh('a');old.events.get('pagehide')();old.events.get('pageshow')({persisted:true});assert.equal(old.controller.validRefresh('a'),false);assert.equal(old.timers.size,0);
});


test('等待按毫秒随机，可产生小数秒，包含上下界且同一草稿不重复抽样',async()=>{
 for(const [random,expected] of [[0,3000],[0.12345,3864],[1-Number.EPSILON,10000]]){
  const env=setup({enabled:true,minSeconds:3,maxSeconds:10,maxAttempts:2,maxMinutes:1});await flush();
  let samples=0;env.scope.Math.random=()=>{samples++;return random;};
  env.controller.start();for(let i=0;i<10;i++)env.controller.refresh();
  assert.equal(samples,1);assert.equal([...env.timers.values()][0].at,expected);
  env.advance(expected-1);assert.equal(env.calls.length,0);env.advance(1);assert.equal(env.calls[0].at,expected);
 }
 const fixed=setup({enabled:true,minSeconds:3,maxSeconds:3,maxAttempts:1,maxMinutes:1});await flush();
 fixed.scope.Math.random=()=>1-Number.EPSILON;fixed.controller.start();
 assert.equal([...fixed.timers.values()][0].at,3000);
});


test('手动暂停清除计时器；继续保留次数和原截止时间，重新等待且不补发',async()=>{
 const env=setup({enabled:true,minSeconds:3,maxSeconds:3,maxAttempts:3,maxMinutes:1});await flush();
 env.controller.start();env.advance(3000);env.state.id='2';env.state.ready=true;env.controller.refresh();env.advance(1000);
 env.controller.pause();assert.equal(env.controller.isPaused(),true);assert.equal(env.timers.size,0);assert.equal(env.interrupts.length,1);
 env.advance(10000);env.controller.refresh();assert.equal(env.calls.length,1);assert.equal(env.timers.size,0);
 env.controller.start();assert.equal(env.timers.size,0,'暂停中不能用开始重置预算');
 env.controller.continueRun();env.advance(2999);assert.equal(env.calls.length,1);env.advance(1);assert.equal(env.calls.length,2);
 const ticket=env.controller.prepareRefresh('after-pause');assert.equal(ticket.attempts,2);assert.equal(ticket.runId,'run-1');assert.equal(ticket.expiresAt,1800000060000);
});
test('失焦和后台事件重复出现只暂停一次，返回前台不自动恢复',async()=>{
 const env=setup();await flush();env.controller.start();env.advance(1000);
 env.document.hidden=true;env.events.get('blur')();env.events.get('visibilitychange')();
 assert.equal(env.controller.isPaused(),true);assert.equal(env.interrupts.length,1);assert.equal(env.timers.size,0);
 env.controller.continueRun();assert.equal(env.timers.size,0);
 env.document.hidden=false;env.events.get('visibilitychange')();env.events.get('focus')();env.advance(15000);
 assert.equal(env.calls.length,0);assert.equal(env.timers.size,0);
 env.controller.continueRun();env.advance(9999);assert.equal(env.calls.length,0);env.advance(1);assert.equal(env.calls.length,1);
});
test('调度先于失焦事件时仍识别可继续暂停；异常原因优先停止',async()=>{
 const env=setup();await flush();env.controller.start();env.state.pauseable=true;env.state.reason='foreground';env.advance(10000);
 assert.equal(env.controller.isPaused(),true);assert.equal(env.calls.length,0);assert.equal(env.timers.size,0);
 env.state.pauseable=false;env.state.reason='rate limited';env.controller.refresh();assert.equal(env.controller.isPaused(),false);
 env.state.reason='';env.controller.continueRun();env.advance(20000);assert.equal(env.calls.length,0);
});
test('发送途中暂停不能继续；成功后须核对并进入下一条，旧目标不重发',async()=>{
 const env=setup({enabled:true,minSeconds:3,maxSeconds:3,maxAttempts:3,maxMinutes:1});await flush();
 env.controller.start();env.advance(3000);env.state.resumeReady=false;env.controller.pause();
 env.controller.continueRun();assert.equal(env.controller.isPaused(),true);assert.equal(env.timers.size,0);
 env.state.reason='sent: review';env.state.awaitingReview=true;env.controller.refresh();env.controller.continueRun();
 assert.equal(env.controller.isPaused(),true);assert.equal(env.calls.length,1);
 env.controller.stop('manual next',{preservePaused:true});assert.equal(env.controller.isPaused(),true);
 env.state.reason='';env.state.awaitingReview=false;env.state.resumeReady=true;env.state.ready=true;
 env.controller.continueRun();env.advance(10000);assert.equal(env.calls.length,1,'同一已触发目标不重发');
 env.state.id='2';env.controller.refresh();env.advance(3000);assert.equal(env.calls.length,2);
});
test('暂停期间超时、换账号/会话、离页、设置变更和异常均销毁继续资格',async()=>{
 for(const action of ['expired','account','session','pagehide','settings','alert','failed']){
  const env=setup();await flush();env.controller.start();env.controller.pause();
  if(action==='expired')env.advance(60000);
  if(action==='account')env.state.account='other';
  if(action==='session')env.state.session={};
  if(action==='pagehide')env.events.get('pagehide')();
  if(action==='settings')env.change({enabled:true,minSeconds:3,maxSeconds:10,maxAttempts:2,maxMinutes:1});
  if(action==='alert')env.controller.stop('rate limited');
  if(action==='failed')env.state.reason='failed';
  env.controller.refresh();assert.equal(env.controller.isPaused(),false,action);
  env.state.reason='';env.controller.continueRun();env.advance(20000);assert.equal(env.calls.length,0,action);
 }
});
test('换批票登记期间暂停仍终止续接，不把半完成换批当作可继续暂停',async()=>{
 const env=setup();await flush();env.controller.start();env.advance(10000);env.controller.prepareRefresh('partial');env.controller.pause();
 assert.equal(env.controller.isPaused(),false);assert.equal(env.controller.validRefresh('partial'),false);
 assert.deepEqual(env.cancellations,['partial']);env.controller.continueRun();assert.equal(env.timers.size,0);
});


test('触发期间恰好失焦但发送未确认，异常优先终止可继续状态',async()=>{
 const env=setup();await flush();env.setTrigger(()=>{env.controller.pause();return false;});
 env.controller.start();env.advance(10000);assert.equal(env.controller.isPaused(),false);
 env.controller.continueRun();env.advance(20000);assert.equal(env.timers.size,0);
});


test('点赞请求已经发出尚未确认时终止本轮，不保留可继续的预算',async()=>{
 const env=setup();await flush();env.controller.start();env.state.likePending=true;env.controller.pause();
 assert.equal(env.controller.isPaused(),false);assert.equal(env.timers.size,0);
 env.state.likePending=false;env.controller.continueRun();env.advance(20000);assert.equal(env.calls.length,0);
});
