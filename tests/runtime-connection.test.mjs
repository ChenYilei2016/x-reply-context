import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/content.js',import.meta.url),'utf8');

function setup() {
  const events = new Map(); const tasks = new Map(); const body = [];
  const state = { stopped:0,reloads:0,calls:0,editor:false,fail:false,delays:[] };
  let taskId = 0; let mutation;
  class Node {
    children = []; dataset = {}; listeners = {}; hidden = false;
    constructor(tag) { this.tagName = tag; }
    setAttribute() {}
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(name,callback) { this.listeners[name] = callback; }
    querySelector(tag) { return this.children.find(node => node.tagName === tag); }
  }
  const controls = [new Node('button'),new Node('button'),new Node('button')];
  const document = {
    hidden:false,body:{ append:node => body.push(node) },createElement:tag => new Node(tag),
    querySelector:selector => selector.includes('AppTabBar_Profile_Link') ? { getAttribute:() => '/me' } :
      selector.includes('contenteditable') && state.editor ? new Node('div') : null,
    querySelectorAll:selector => selector.includes('xrc-notification-controls') ? controls : [],
    addEventListener:(name,callback) => events.set(`document:${name}`,callback)
  };
  const window = { postMessage() {},dispatchEvent() {},addEventListener:(name,callback) => events.set(name,callback) };
  const runtime = { id:'extension-id',onMessage:{ addListener() {} },async sendMessage() {
    state.calls++;
    if (state.fail) throw new Error('Extension context invalidated.');
    if (state.gate) await state.gate;
    return { ok:true,rows:[] };
  } };
  const filter = () => ({ reset() {},invalidate() {},syncKnown() {},async refresh() {} });
  const scope = vm.createContext({ document,window,location:{ pathname:'/notifications',origin:'https://x.com',reload:() => state.reloads++ },
    chrome:{ runtime,storage:{ onChanged:{ addListener() {} },local:{ get:async () => ({}) } } },
    XReplyHomeFilter:{ create:filter },XReplyNotificationFilter:{ create:filter },
    XReplyContinuous:{ create:options => { state.connected = options.connected; return {
      refresh() {},stop() { state.stopped++; },invalidateContext() {},receiveReply() { state.received = true; }
    }; } },
    MutationObserver:class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} },
    setTimeout:(callback,delay) => { state.delays.push(delay); const id = ++taskId; tasks.set(id,callback); return id; },clearTimeout:id => tasks.delete(id),
    Event,console:{ warn() {} }
  });
  vm.runInContext(source,scope);
  const flush = async () => {
    for (const [id,callback] of [...tasks]) { tasks.delete(id); callback(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  const message = data => events.get('message')({ source:window,origin:'https://x.com',data:{ channel:'x-reply-context-v1',...data } });
  return { state,runtime,body,controls,flush,message,mutation:() => mutation([{ target:{} }]) };
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
