import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const timedSource=await readFile(new URL('../extension/timed-replies.js',import.meta.url),'utf8');
const source=await readFile(new URL('../extension/refresh-cycle.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(config={enabled:true,min:10,max:20},resume=null,options={}) {
 let settings=config,listener,account='me',outcome='opened';const timers=new Map(),requests=[],navigations=[],notices=[],resumeCalls=[];
 const dom={hidden:false,activeElement:null,editors:[],dialogs:[],attachment:null,
  querySelectorAll(selector){return selector.includes('role="dialog"')?this.dialogs:this.editors;},querySelector(){return this.attachment;}};
 const location={pathname:'/home',assign:url=>navigations.push(url)};
 let arm,save;
 const storage={local:{get:async()=>({replyRefreshCycle:settings}),set:async value=>{await save?.();settings=value.replyRefreshCycle;await options.afterSet?.();}},onChanged:{addListener:fn=>{listener=fn;}}};
 const scope=vm.createContext({document:dom,location,URL,crypto:{randomUUID:()=>"refresh-test"},Math:Object.assign(Object.create(Math),{random:()=>0}),
  setTimeout:fn=>{const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(timedSource,scope);vm.runInContext(source,scope);
 const cycle=scope.XReplyRefreshCycle.create({storage,getTimed:()=>options.timed,accountHandle:()=>account,requestRefresh(){},notify:t=>notices.push(t),
  message:async message=>{requests.push(message);if(message.type==='REFRESH_TAKE'){if(options.take)await options.take;return {ok:true,resume:resume?{refreshId:'test-refresh',...resume}:null};}if(message.type==='REFRESH_ARM'&&arm)await arm;return {ok:true};},
  resume:async(intent,valid)=>{resumeCalls.push(intent);options.beforeOpen?.();return valid()?outcome:'paused';}});
 return {cycle,scope,dom,location,requests,navigations,notices,timers,resumeCalls,outcome:value=>{outcome=value;},setArm:p=>{arm=p;},account:value=>{account=value;},
  setSave:fn=>{save=fn;},change:value=>{settings=value;listener({replyRefreshCycle:{newValue:value}},'local');}};
}
const notice={feed:'notifications',account:'me'},home={feed:'home',homeTabIndex:0,account:'me'};
test('默认关闭；仅为你推荐计数，通知不显示、不计数、不触发换批',async()=>{
 const env=setup(null);await flush();
 env.cycle.record(home,"off");assert.equal(env.cycle.due(home),false);env.change({enabled:true,min:10,max:20});
 for(let i=0;i<20;i++)env.cycle.record(notice,'notice-'+i);
 assert.equal(env.cycle.due(home),false);
 env.cycle.render(notice,{querySelector(){throw Error('通知不应创建配置');}});
 for(let i=0;i<9;i++)env.cycle.record(home,String(i));
 env.cycle.record(home,'0');env.cycle.record({...home,homeTabIndex:1},'follow');env.cycle.record({feed:'search',account:'me'},'search');
 assert.equal(env.cycle.due(home),false);env.cycle.record(home,'9');assert.equal(env.cycle.due(home),true);
 assert.equal(env.cycle.due(notice),false);assert.equal(await env.cycle.refresh(notice,()=>true),'continue');assert.equal(env.navigations.length,0);
 env.change({enabled:false,min:10,max:20});assert.equal(env.cycle.due(home),false);
});

function controls(env) {
 const element=()=>({append(){},setAttribute(){},addEventListener(name,fn){this[name]=fn;}});
 const nodes=Array.from({length:6},element);
 const [row,,toggle,min,max,status]=nodes;
 row.querySelector=selector=>({'.xrc-cycle-enabled':toggle,'.xrc-cycle-min':min,'.xrc-cycle-max':max,'.xrc-cycle-progress':status})[selector];
 let attached=false;
 const bar={querySelector:()=>attached?row:null,append(){attached=true;}};
 env.dom.createElement=()=>nodes.shift();
 env.dom.createTextNode=String;
 return {row,toggle,min,max,status,render:()=>env.cycle.render(home,bar)};

}
test('自动换批开关保存中显示保存状态，失败后恢复原值',async()=>{
 const sourceConfig={enabled:false,min:5,max:15},env=setup(sourceConfig);
 const {row,toggle,status,render}=controls(env);
 let resolveSave,rejectSave;
 env.setSave(()=>new Promise((resolve,reject)=>{resolveSave=resolve;rejectSave=reject;}));
 await flush();
 render();assert.equal(toggle.checked,false);assert.equal(status.textContent,'换批：已关闭');
 toggle.checked=true;let saving=row.change();render();
 assert.equal(toggle.checked,true);assert.equal(status.textContent,'保存中…');
 rejectSave(Error('模拟保存失败'));await saving;render();
 assert.equal(toggle.checked,false);assert.equal(status.textContent,'设置未保存');
 toggle.checked=true;saving=row.change();resolveSave();await saving;render();
 assert.equal(toggle.checked,true);assert.equal(status.textContent,'换批 0/5');
});
test('到达次数仅导航一次为你推荐，不请求X接口；未达到不刷新',async()=>{
 const env=setup({enabled:true,min:1,max:1});await flush();
 assert.equal(await env.cycle.refresh(home,()=>true),'continue');env.cycle.record(home,'reply');
 assert.equal(await env.cycle.refresh(home,()=>true),'navigating');assert.deepEqual(env.navigations,['/home']);
 assert.equal(env.requests.filter(r=>r.type==='REFRESH_ARM').length,1);
 assert.equal(await env.cycle.refresh(home,()=>true),'paused');assert.equal(env.navigations.length,1);
});
test('非空草稿、弹窗、后台和无效当前会话均阻止刷新',async()=>{
 const env=setup({enabled:true,min:1,max:1});await flush();env.cycle.record(home,'reply');
 env.dom.editors=[{innerText:'草稿',contains:()=>false}];assert.equal(await env.cycle.refresh(home,()=>true),'paused');
 assert.match(env.cycle.pauseMessage(),/未发送文字/);
 env.dom.editors=[];env.dom.dialogs=[{getBoundingClientRect:()=>({width:1,height:1})}];assert.equal(await env.cycle.refresh(home,()=>true),'paused');
 env.dom.dialogs=[];env.dom.hidden=true;assert.equal(await env.cycle.refresh(home,()=>true),'paused');
 assert.match(env.cycle.pauseMessage(),/前台/);
 env.dom.hidden=false;assert.equal(await env.cycle.refresh(home,()=>false),'paused');
 assert.equal(env.requests.filter(r=>r.type==='REFRESH_ARM').length,0);assert.equal(env.navigations.length,0);
});
test('保存续接标记期间用户输入或关闭设置，取消标记且不导航',async()=>{
 const env=setup({enabled:true,min:1,max:1});await flush();env.cycle.record(home,'reply');
 let release;env.setArm(new Promise(r=>{release=r;}));const pending=env.cycle.refresh(home,()=>true);
 await flush();env.dom.editors=[{innerText:'新草稿',contains:()=>false}];release();
 assert.equal(await pending,'paused');assert.equal(env.navigations.length,0);assert.equal(env.requests.at(-1).type,'REFRESH_CANCEL');
});
test('新账号和设置区间变化重新计数，不混用原轮进度',async()=>{
 const env=setup({enabled:true,min:2,max:2});await flush();env.cycle.record(home,'1');env.cycle.record({...home,account:'other'},'2');
 assert.equal(env.cycle.due({...home,account:'other'}),false);env.cycle.record({...home,account:'other'},'3');assert.equal(env.cycle.due({...home,account:'other'}),true);
 env.change({enabled:true,min:3,max:3});assert.equal(env.cycle.due({...home,account:'other'}),false);
});
test('续接只尝试打开一次；无标记不触发，账号变化也不打开',async()=>{
 const env=setup({enabled:true,min:1,max:1},{account:'me',min:1,max:1});await flush();
 await env.cycle.tick();assert.equal(env.timers.size,0);await env.cycle.tick();assert.equal(env.navigations.length,0);assert.equal(env.resumeCalls.length,1);
 const other=setup({enabled:true,min:1,max:1},{account:'other',min:1,max:1});await flush();await other.cycle.tick();assert.match(other.notices[0],/账号/);assert.equal(other.timers.size,0);
});
test('换批选帖期间定时预算不足时，在开框前取消恢复',async()=>{
 let allowed=true,restores=0;
 const timed={previewResume:()=>true,canResume:()=>allowed,restore:()=>{restores++;},cancelFromRefresh(){}};
 const env=setup({enabled:true,min:1,max:1},{account:'me',min:1,max:1,timed:{expiresAt:Date.now()+10000}},
  {timed,beforeOpen:()=>{allowed=false;}});
 await flush();await env.cycle.tick();
 assert.equal(env.resumeCalls.length,1);assert.equal(restores,0);assert.match(env.notices.at(-1),/预算不足/);
});
test('后台标记按标签隔离、一次消费、过期拒绝、关闭清理',async()=>{
 const records={};const local={get:async()=>({replyRefreshCycle:{enabled:true,min:10,max:20}})};
 const api={storage:{local,session:{get:async key=>({[key]:records[key]}),set:async data=>Object.assign(records,data),remove:async key=>{delete records[key];}}}};
 const env=setup();const backend=env.scope.XReplyRefreshCycle.createBackground(api);
 const sender={frameId:0,tab:{id:1},url:'https://x.com/home'};
 assert.equal((await backend.handle({type:'REFRESH_ARM',account:'me',refreshId:'test-refresh',currentPath:'/notifications'},{...sender,url:'https://x.com/notifications'})).ok,false);
 assert.equal(Object.keys(records).length,0);
 await backend.handle({type:'REFRESH_ARM',account:'me',refreshId:'test-refresh',currentPath:'/home'},sender);
 assert.equal((await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},{...sender,tab:{id:2},url:'https://x.com/home'})).resume,null);
 assert.equal((await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},{...sender,url:'https://x.com/home'})).resume.account,'me');
 assert.equal((await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},{...sender,url:'https://x.com/home'})).resume,null);
 await backend.handle({type:'REFRESH_ARM',account:'me',refreshId:'test-refresh',currentPath:'/home'},sender);records['replyRefreshResume:1'].at=0;
 assert.equal((await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},{...sender,url:'https://x.com/home'})).resume,null);
 await backend.handle({type:'REFRESH_ARM',account:'me',refreshId:'test-refresh',currentPath:'/home'},sender);await backend.removed(1);assert.equal(Object.keys(records).length,0);
});

test('随机次数包含区间上界，未达到上界不会提前换批',async()=>{
 const env=setup();env.scope.Math.random=()=>1-Number.EPSILON;await flush();
 for(let i=0;i<19;i++)env.cycle.record(home,String(i));assert.equal(env.cycle.due(home),false);
 env.cycle.record(home,'19');assert.equal(env.cycle.due(home),true);
});
test('续接无候选或加载超时只提示一次，停止重试和刷新',async()=>{
 const intent={account:'me',min:1,max:1};
 const empty=setup({enabled:true,min:1,max:1},intent);empty.outcome('empty');await flush();
 await empty.cycle.tick();await empty.cycle.tick();assert.equal(empty.resumeCalls.length,1);assert.match(empty.notices[0],/暂无/);assert.equal(empty.timers.size,0);
 const slow=setup({enabled:true,min:1,max:1},intent);slow.outcome('waiting');await flush();await slow.cycle.tick();
 for(const fn of [...slow.timers.values()])fn();await slow.cycle.tick();
 assert.equal(slow.resumeCalls.length,1);assert.match(slow.notices[0],/未能/);assert.equal(slow.navigations.length,0);
});

test('SPA从通知/评论地址进入主页，后台按当前路由登记，不按文档旧地址拒绝',async()=>{
 const records={};const env=setup();
 const backend=env.scope.XReplyRefreshCycle.createBackground({storage:{
  local:{get:async()=>({replyRefreshCycle:{enabled:true,min:1,max:1}})},
  session:{get:async key=>({[key]:records[key]}),set:async value=>Object.assign(records,value),remove:async key=>{delete records[key];}}
 }});
 for(const originalPath of ['/notifications','/compose/post']){
  const sender={frameId:0,tab:{id:1},url:'https://x.com'+originalPath};
  assert.equal((await backend.handle({type:'REFRESH_ARM',account:'me',refreshId:'test-refresh',currentPath:'/home'},sender)).ok,true);
  assert.ok(records['replyRefreshResume:1']);
  await backend.handle({type:'REFRESH_CANCEL',refreshId:'test-refresh'},sender);
 }
 const sender={frameId:0,tab:{id:1},url:'https://x.com/home'};
 assert.equal((await backend.handle({type:'REFRESH_ARM',account:'me',refreshId:'test-refresh',currentPath:'/notifications'},sender)).ok,false);
 assert.equal(Object.keys(records).length,0);
 assert.equal((await backend.handle({type:'REFRESH_ARM',account:'me',refreshId:'test-refresh',currentPath:'/home'},{...sender,url:'https://example.com/home'})).ok,false);
});


test('后台登记失败显示真实原因，不再误报草稿，且不刷新',async()=>{
 const env=setup({enabled:true,min:1,max:1});await flush();env.cycle.record(home,'reply');
 env.setArm(Promise.reject(new Error('当前页面不是主页，未登记换批。')));
 assert.equal(await env.cycle.refresh(home,()=>true),'paused');
 assert.match(env.cycle.pauseMessage(),/当前页面不是主页/);assert.doesNotMatch(env.cycle.pauseMessage(),/草稿/);
 assert.equal(env.navigations.length,0);
});


test('停止发生在ARM等待期间，迟到登记不得刷新，并清理同编号票',async()=>{
 const env=setup({enabled:true,min:1,max:1});await flush();env.cycle.record(home,'1');
 let release;env.setArm(new Promise(r=>{release=r;}));const pending=env.cycle.refresh(home,()=>true);await flush();env.cycle.cancel('refresh-test');release();
 assert.equal(await pending,'paused');assert.equal(env.navigations.length,0);
 const cancels=env.requests.filter(r=>r.type==='REFRESH_CANCEL');assert.equal(cancels.length,2);assert.ok(cancels.every(r=>r.refreshId==='refresh-test'));
});
test('手动取消或远端取消早于TAKE返回，不恢复旧轮，远端取消不反向发消息',async()=>{
 for(const remote of [false,true]){
  let release,previews=0;const gate=new Promise(r=>{release=r;});
  const env=setup({enabled:true,min:1,max:1},{account:'me',min:1,max:1,refreshId:'delayed',timed:{}},
   {take:gate,timed:{previewResume(){previews++;return true;},cancelFromRefresh(){}}});
  await flush();if(remote)env.cycle.cancelled('delayed');else env.cycle.cancel();release();await flush();await env.cycle.tick();
  assert.equal(previews,0);assert.equal(env.resumeCalls.length,0);
  assert.equal(env.requests.filter(r=>r.type==='REFRESH_CANCEL').length,remote?0:1);
 }
});
test('旧CANCEL不删除新票；已消费的票仍广播取消一次；缺少ID拒绝',async()=>{
 const records={},broadcasts=[];const api={storage:{local:{get:async()=>({replyRefreshCycle:{enabled:true,min:1,max:1}})},session:{
  get:async key=>({[key]:records[key]}),set:async data=>Object.assign(records,data),remove:async key=>{delete records[key];}}},tabs:{sendMessage:async(_id,data)=>broadcasts.push(data)}};
 const env=setup();const backend=env.scope.XReplyRefreshCycle.createBackground(api),sender={frameId:0,tab:{id:1},url:'https://x.com/home'};
 const arm=id=>backend.handle({type:'REFRESH_ARM',refreshId:id,currentPath:'/home',account:'me'},sender);
 await arm('a');const taken=await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},sender);assert.equal(taken.resume.refreshId,'a');
 await arm('b');await backend.handle({type:'REFRESH_CANCEL',refreshId:'a'},sender);
 assert.equal(records['replyRefreshResume:1'].refreshId,'b');assert.equal(broadcasts.length,1);assert.equal(broadcasts[0].refreshId,'a');
 assert.equal((await backend.handle({type:'REFRESH_CANCEL'},sender)).ok,false);assert.equal(broadcasts.length,1);
});


test('点击换批开关后同步显示保存中，不等待页面扫描而保留已关闭旧提示',async()=>{
 const env=setup({enabled:false,min:10,max:20});await flush();
 const {row,toggle,status,render}=controls(env);render();
 let release;env.setSave(()=>new Promise(resolve=>{release=resolve;}));
 toggle.checked=true;const saving=row.change();
 assert.equal(status.textContent,'保存中…');assert.equal(toggle.disabled,true);
 release();await saving;
 assert.equal(toggle.checked,true);assert.match(status.textContent,/0\/10/);
});
test('保存已写入后收到更新的跨窗口关闭事件，旧保存回调不得重新开启换批',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const env=setup({enabled:false,min:1,max:1},null,{afterSet:()=>gate});await flush();
 const {row,toggle,status,render}=controls(env);render();
 toggle.checked=true;const saving=row.change();await flush();
 env.change({enabled:true,min:1,max:1});
 env.change({enabled:false,min:1,max:1});
 release();await saving;render();
 assert.equal(toggle.checked,false);assert.match(status.textContent,/关闭/);
 env.cycle.record(home,'sent');assert.equal(env.cycle.due(home),false);
});


test('可见失焦时定时换批前后统一放行；未开启、手动换批、隐藏与草稿仍拦截',async()=>{
 for(const allow of [false,true]){
  const timed={allowsUnfocused:()=>allow,prepareRefresh:()=>null};
  const env=setup({enabled:true,min:1,max:1},null,{timed});await flush();env.dom.hasFocus=()=>false;
  env.dom.editors=[{innerText:'',contains:()=>true}]; // Old DOM focus is not active typing in another app.
  env.cycle.record(home,'1');assert.equal(await env.cycle.refresh(home,()=>true),allow?'navigating':'paused');
  const previews=[];const next=setup({enabled:true,min:1,max:1},{account:'me',min:1,max:1,timed:{settings:{allowVisibleUnfocused:allow}}},
   {timed:{previewResume:()=>{previews.push(true);return true;},canResume:()=>true,restore(){}}});
  next.dom.hasFocus=()=>false;await flush();await next.cycle.tick();
  assert.equal(next.resumeCalls.length,allow?1:0);assert.equal(previews.length,allow?1:0);
 }
 for(const cause of ['hidden','draft','manual']){
  const env=setup({enabled:true,min:1,max:1},null,{timed:cause==='manual'?undefined:{allowsUnfocused:()=>true}});await flush();env.dom.hasFocus=()=>false;
  if(cause==='hidden')env.dom.hidden=true;
  if(cause==='draft')env.dom.editors=[{innerText:'尚未发送',contains:()=>false}];
  env.cycle.record(home,'1');assert.equal(await env.cycle.refresh(home,()=>true),'paused');assert.equal(env.navigations.length,0);
 }
});
