import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/content.js',import.meta.url),'utf8');

function setup(savedSettings = {}) {
  const events = new Map(); const tasks = new Map(); const body = [];
  const state = { uiRenders:0,requests:[],posts:[],stopped:0,reloads:0,calls:0,editor:false,fail:false,delays:[] };
  let taskId = 0; let mutation; let storageChanged;
  const frames = new Map();
  class Node {
    children = []; dataset = {}; listeners = {}; hidden = false;
    constructor(tag) { this.tagName = tag; }
    setAttribute() {}
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(name,callback) { this.listeners[name] = callback; }
    querySelector(tag) { return this.children.find(node => tag.startsWith(".") ? node.className === tag.slice(1) : node.tagName === tag); }
  }
  const controls = [new Node('button'),new Node('button'),new Node('button')];
  const document = {
    hidden:false,body:{ append:node => body.push(node) },createElement:tag => new Node(tag),
    querySelector:selector => selector.includes('AppTabBar_Profile_Link') ? { getAttribute:() => '/me' } :
      selector.includes('contenteditable') && state.editor ? new Node('div') : null,
    querySelectorAll:selector => selector.includes('xrc-notification-controls') ? controls : [],
    addEventListener:(name,callback) => events.set(`document:${name}`,callback)
  };
  const window = { postMessage:message => state.posts.push(message),dispatchEvent() {},addEventListener:(name,callback) => events.set(name,callback) };
  const runtime = { id:'extension-id',onMessage:{ addListener() {} },async sendMessage(payload) {
    state.calls++; state.requests.push(payload);
    if (state.fail) throw new Error('Extension context invalidated.');
    if (state.gate) await state.gate;
    return { ok:true,rows:[] };
  } };
  const filter = () => ({ reset() {},invalidate() {},syncKnown() {},async refresh() {},hiddenSummary:() => state.summary || ({total:0,hidden:0}),restoreHidden() { state.summary = {total:2,hidden:0}; return true; },applying:() => false });
  const scope = vm.createContext({ document,window,location:{ pathname:'/notifications',origin:'https://x.com',reload:() => state.reloads++ },
    chrome:{ runtime,storage:{ onChanged:{ addListener:callback => { storageChanged = callback; } },local:{ get:async () => savedSettings } } },
    XReplyHomeFilter:{ create:filter },XReplyNotificationFilter:{ create:options => { state.notificationOptions = options; return filter(); } },
    XReplyContinuous:{ create:options => { state.connected = options.connected; state.message = options.message; return {
      refresh() { state.uiRenders++; },stop() { state.stopped++; },invalidateContext() {},receiveReply() { state.received = true; },receiveLike(data,saved) { state.likeReceipt=data;state.likeSaved=saved; }
    }; } },
    MutationObserver:class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} },
    setTimeout:(callback,delay) => { state.delays.push(delay); const id = ++taskId; tasks.set(id,callback); return id; },clearTimeout:id => tasks.delete(id),
    requestAnimationFrame:callback => { const id = ++taskId; frames.set(id,callback); return id; },
    Event,console:{ warn() {} }
  });
  vm.runInContext(source,scope);
  const flush = async () => {
    for (const [id,callback] of [...tasks]) { tasks.delete(id); callback(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  const message = data => events.get('message')({ source:window,origin:'https://x.com',data:{ channel:'x-reply-context-v1',...data } });
  return { state,runtime,body,controls,flush,message,
    changed:revision => storageChanged({ replyContextRevision:{ newValue:revision } },"local"),
    frame:() => { for (const [id,fn] of frames) { frames.delete(id); fn(); } },
    mutation:() => mutation([{ target:{ closest:selector => selector.includes("primaryColumn") ? {} : null } }]) };
}

test('运行时失效后结束旧连续流程，只显示一次刷新提示，不自动刷新或处理回复结果',async () => {
  const { state,runtime,body,controls,flush,message,mutation } = setup();
  await flush(); runtime.id = undefined; mutation(); await flush();
  assert.equal(state.stopped,1,'失效会话必须结束，不能残留发送中');
  const notices = body.filter(node => node.className === 'xrc-runtime-notice');
  assert.equal(notices.length,1);
  assert.match(notices[0].querySelector('span').textContent,/刷新/);
  assert.equal(state.reloads,0,'不能自动刷新或丢弃草稿');
  assert.ok(controls.every(button => button.disabled));
  const calls = state.calls;
  mutation(); message({ type:'REPLY_RESULT',status:'sent',account:'me',batch:{} }); await flush();
  assert.equal(state.calls,calls); assert.equal(state.received,undefined);
  assert.equal(state.stopped,1);
  state.editor = true;
  notices[0].querySelector('button').listeners.click();
  assert.equal(state.reloads,0,'回复框仍在时不能丢弃草稿');
});

test('sendMessage明确返回运行时失效时也进入同一个停用分支',async () => {
  const { state,body,flush,message } = setup();
  await flush(); state.fail = true;
  message({ type:'OBSERVED',batch:{} }); await flush();
  assert.equal(state.stopped,1);
  assert.equal(body.filter(node => node.className === 'xrc-runtime-notice').length,1);
  assert.equal(state.reloads,0);
});

test('已确认互动立即保存，保存完成后不再等250ms才刷新标签',async () => {
  const { state,flush,message } = setup();
  await flush(); state.delays.length = 0;
  let saved;
  state.gate = new Promise(resolve => { saved = resolve; });
  message({ type:'OBSERVED',interaction:true,account:'me',batch:{ likes:[{ id:'1',liked:true }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls,1,'成功互动不进入普通观察的250ms队列');
  assert.equal(state.delays.length,0,'持久化未完成前不宣称标签已更新');
  saved(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.delays.at(-1),0);
});


test('普通观察合批不丢第11批，超过500条分段保存且部分字段不覆盖已知值',async () => {
  const { state,flush,message } = setup(); await flush();
  let release; state.gate = new Promise(resolve => { release = resolve; });
  message({ type:'OBSERVED',batch:{ tweets:[{ id:'1',authorId:'2',conversationId:'1',text:'原文' }] } });
  for (let i=2;i<=601;i++) message({ type:'OBSERVED',batch:{ tweets:[{ id:String(i),authorId:'2',text:'原文' }] } });
  message({ type:'OBSERVED',batch:{ tweets:[{ id:'2',authorId:'2',text:'',conversationId:'2' }] } });
  for (const [liked,source] of [[false,'mutation'],[true,'mutation'],[false,'snapshot']]) {
    message({type:'OBSERVED',batch:{likes:[{id:'2',account:'me',liked,source,observedAt:123}]}});
  }
  release(); await new Promise(resolve => setImmediate(resolve));
  const batches = state.requests.filter(item => item.type === 'INGEST').map(item => item.batch);
  const tweets = batches.flatMap(batch => batch.tweets);
  assert.equal(new Set(tweets.map(tweet => tweet.id)).size,601);
  assert.ok(batches.every(batch => batch.tweets.length <= 500));
  assert.equal(batches.length,3,'一个在途批次，剩余600条应合并为500+100');
  assert.equal(batches.flatMap(batch=>batch.likes).find(like=>like.id==='2').liked,true,'同时间成功回执依次更新，快照不能覆盖');
  assert.equal(tweets.find(tweet => tweet.id === '2').text,'原文');
  assert.equal(tweets.find(tweet => tweet.id === '2').conversationId,'2');
});

test('普通保存暂时失败保留数据，下一次事件可补齐且不自动循环重试',async () => {
  const { state,runtime,flush,message } = setup(); await flush();
  runtime.sendMessage = async payload => { state.requests.push(payload); throw new Error('temporary storage failure'); };
  message({ type:'OBSERVED',batch:{ tweets:[{ id:'1',authorId:'2' }] } });
  await flush(); assert.equal(state.requests.length,1);
  const saved=[]; runtime.sendMessage = async payload => { saved.push(...payload.batch.tweets); return {ok:true}; };
  message({ type:'OBSERVED',batch:{ tweets:[{ id:'2',authorId:'2' }] } });
  await flush(); assert.deepEqual(saved.map(tweet => tweet.id),['1','2']);
});

test('分类在同一数据版本复用，正文请求隔离，更新通知后重新读取',async () => {
  const { state,runtime,flush,changed } = setup(); await flush();
  const calls=[]; runtime.sendMessage = async payload => { calls.push(payload); return {ok:true,rows:payload.ids.map(id=>({id,rootId:id}))}; };
  const query={type:'CLASSIFY',account:'me',ids:['1','2']};
  await state.message(query); await state.message({...query,ids:['2']});
  assert.equal(calls.length,1);
  await state.message({...query,ids:['1'],includeRootText:true}); assert.equal(calls.length,2);
  changed('new'); await state.message(query); assert.equal(calls.length,3);
  changed('new'); await state.message(query); assert.equal(calls.length,3,'同一保存回执与storage通知不能重复失效');
});

test('原生控件变化在下一帧刷新，不等待250ms列表任务',async () => {
  const { state,flush,mutation,frame }=setup(); await flush();
  const before=state.uiRenders;
  mutation(); mutation(); assert.equal(state.uiRenders,before);
  frame(); assert.equal(state.uiRenders,before+1,'同一帧只更新一次工具栏');
});


test('通知新模式优先，旧的已回且已点设置兼容且不增加读取请求',async()=>{
  for(const [settings,expected] of [
    [{hideCompletedNotifications:true},'completed'],
    [{hideCompletedNotifications:false},'off'],
    [{hideCompletedNotifications:true,notificationHideMode:'replied'},'replied'],
    [{hideCompletedNotifications:true,notificationHideMode:'off'},'off']
  ]) {
    const {state,flush}=setup(settings); await flush();
    assert.equal(state.notificationOptions.mode(),expected);
    assert.equal(state.notificationOptions.enabled(),expected!=='off');
    assert.equal(state.calls,0,'加载筛选设置不新增后台分类或接口请求');
  }
});


test('全隐藏恢复与网络暂停共用提示，恢复不放行分页，继续按钮只发一次授权',async()=>{
  const {state,flush,message,body}=setup({notificationHideMode:'replied'});
  state.summary={total:2,hidden:2};await flush();
  let notice=body.find(node=>node.className==='xrc-network-notice');
  assert.ok(notice && !notice.hidden);
  assert.equal(notice.querySelector('.xrc-network-continue').hidden,true);
  const restore=notice.querySelector('.xrc-empty-restore');assert.equal(restore.hidden,false);
  message({type:'NOTIFICATION_FILTER_STATUS',account:'me',key:'me:All',paused:true,empty:false,loading:false,pending:true});await flush();
  assert.equal(body.filter(node=>node.className==='xrc-network-notice').length,1);
  assert.equal(notice.querySelector('.xrc-network-continue').hidden,false);
  restore.listeners.click();
  assert.equal(notice.hidden,false,'恢复后网络暂停提示仍保留');
  assert.equal(restore.hidden,true);
  assert.equal(state.posts.filter(post=>post.type==='NOTIFICATION_FILTER_CONTINUE').length,0);
  notice.querySelector('.xrc-network-continue').listeners.click();
  assert.equal(state.posts.filter(post=>post.type==='NOTIFICATION_FILTER_CONTINUE').length,1);
});

test('组合点赞接收同一成功保存Promise和请求开始时间，不重复入库',async()=>{
 const env=setup();await env.flush();
 env.message({type:'OBSERVED',interaction:true,account:'me',requestStartedAt:123,batch:{likes:[{id:'2',liked:true,source:'mutation',observedAt:456}]}});
 await env.state.likeSaved;
 assert.equal(env.state.likeReceipt.requestStartedAt,123);
 assert.equal(env.state.requests.filter(r=>r.type==='INGEST').length,1);
 const previous=env.state.likeReceipt;
 env.message({type:'OBSERVED',interaction:true,account:'other',requestStartedAt:789,batch:{likes:[]}});
 assert.equal(env.state.likeReceipt,previous);
});
