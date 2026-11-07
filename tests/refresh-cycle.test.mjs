import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/refresh-cycle.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(config={enabled:true,min:10,max:20},resume=null) {
 let settings=config,listener,account='me',outcome='opened';const timers=new Map(),requests=[],navigations=[],notices=[],resumeCalls=[];
 const dom={hidden:false,activeElement:null,editors:[],dialogs:[],attachment:null,
  querySelectorAll(selector){return selector.includes('role="dialog"')?this.dialogs:this.editors;},querySelector(){return this.attachment;}};
 const location={pathname:'/home',assign:url=>navigations.push(url)};
 const storage={local:{get:async()=>({replyRefreshCycle:settings}),set:async value=>{settings=value.replyRefreshCycle;}},onChanged:{addListener:fn=>{listener=fn;}}};
 let arm;
 const scope=vm.createContext({document:dom,location,URL,Math:Object.assign(Object.create(Math),{random:()=>0}),
  setTimeout:fn=>{const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source,scope);
 const cycle=scope.XReplyRefreshCycle.create({storage,accountHandle:()=>account,requestRefresh(){},notify:t=>notices.push(t),
  message:async message=>{requests.push(message);if(message.type==='REFRESH_TAKE')return {ok:true,resume};if(message.type==='REFRESH_ARM'&&arm)await arm;return {ok:true};},
  resume:async(intent,valid)=>{resumeCalls.push(intent);return valid()?outcome:'paused';}});
 return {cycle,scope,dom,location,requests,navigations,notices,timers,resumeCalls,outcome:value=>{outcome=value;},setArm:p=>{arm=p;},account:value=>{account=value;},
  change:value=>{settings=value;listener({replyRefreshCycle:{newValue:value}},'local');}};
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
 assert.match(env.cycle.pauseMessage(),/后台/);
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
test('后台标记按标签隔离、一次消费、过期拒绝、关闭清理',async()=>{
 const records={};const local={get:async()=>({replyRefreshCycle:{enabled:true,min:10,max:20}})};
 const api={storage:{local,session:{get:async key=>({[key]:records[key]}),set:async data=>Object.assign(records,data),remove:async key=>{delete records[key];}}}};
 const env=setup();const backend=env.scope.XReplyRefreshCycle.createBackground(api);
 const sender={frameId:0,tab:{id:1},url:'https://x.com/home'};
 assert.equal((await backend.handle({type:'REFRESH_ARM',account:'me',currentPath:'/notifications'},{...sender,url:'https://x.com/notifications'})).ok,false);
 assert.equal(Object.keys(records).length,0);
 await backend.handle({type:'REFRESH_ARM',account:'me',currentPath:'/home'},sender);
 assert.equal((await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},{...sender,tab:{id:2},url:'https://x.com/home'})).resume,null);
 assert.equal((await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},{...sender,url:'https://x.com/home'})).resume.account,'me');
 assert.equal((await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},{...sender,url:'https://x.com/home'})).resume,null);
 await backend.handle({type:'REFRESH_ARM',account:'me',currentPath:'/home'},sender);records['replyRefreshResume:1'].at=0;
 assert.equal((await backend.handle({type:'REFRESH_TAKE',currentPath:'/home'},{...sender,url:'https://x.com/home'})).resume,null);
 await backend.handle({type:'REFRESH_ARM',account:'me',currentPath:'/home'},sender);await backend.removed(1);assert.equal(Object.keys(records).length,0);
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
  assert.equal((await backend.handle({type:'REFRESH_ARM',account:'me',currentPath:'/home'},sender)).ok,true);
  assert.ok(records['replyRefreshResume:1']);
  await backend.handle({type:'REFRESH_CANCEL'},sender);
 }
 const sender={frameId:0,tab:{id:1},url:'https://x.com/home'};
 assert.equal((await backend.handle({type:'REFRESH_ARM',account:'me',currentPath:'/notifications'},sender)).ok,false);
 assert.equal(Object.keys(records).length,0);
 assert.equal((await backend.handle({type:'REFRESH_ARM',account:'me',currentPath:'/home'},{...sender,url:'https://example.com/home'})).ok,false);
});


test('后台登记失败显示真实原因，不再误报草稿，且不刷新',async()=>{
 const env=setup({enabled:true,min:1,max:1});await flush();env.cycle.record(home,'reply');
 env.setArm(Promise.reject(new Error('当前页面不是主页，未登记换批。')));
 assert.equal(await env.cycle.refresh(home,()=>true),'paused');
 assert.match(env.cycle.pauseMessage(),/当前页面不是主页/);assert.doesNotMatch(env.cycle.pauseMessage(),/草稿/);
 assert.equal(env.navigations.length,0);
});
