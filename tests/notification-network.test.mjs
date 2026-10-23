import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/notification-network.js',import.meta.url),'utf8');
const cursor = (type,value) => ({ content:{ entryType:'TimelineTimelineCursor',cursorType:type,value } });
const notice = icon => ({ content:{ entryType:'TimelineTimelineItem',itemContent:{ itemType:'TimelineNotification',notification_icon:icon } } });
const tweet = () => ({ content:{ entryType:'TimelineTimelineItem',itemContent:{ itemType:'TimelineTweet',tweet_results:{ result:{ text:'comment fixture' } } } } });
const payload = items => ({ data:{ viewer_v2:{ user_results:{ result:{ notification_timeline:{ timeline:{ instructions:[
  { type:'TimelineClearCache' },{ type:'TimelineAddEntries',entries:[cursor('Top','top-1'),...items,cursor('Bottom','bottom-1')] }
] } } } } } } });
const entries = data => data.data.viewer_v2.user_results.result.notification_timeline.timeline.instructions[1].entries;

function setup() {
  const messages = []; const listeners = [];
  const env = { account:'me',requests:0 };
  const location = { origin:'https://x.com',href:'https://x.com/notifications',pathname:'/notifications' };
  class Xhr extends EventTarget {
    readyState = 0; status = 0; responseType = ''; raw = '';
    open() { this.readyState = 1; }
    send() { env.requests++; }
    abort() { this.readyState = 0; }
    get responseText() { return this.raw; }
    get response() { return this.responseType === 'json' ? JSON.parse(this.raw) : this.raw; }
    complete(data,type = '') {
      this.raw = JSON.stringify(data); this.responseType = type; this.status = 200; this.readyState = 4;
      this.dispatchEvent(new Event('readystatechange')); this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend'));
    }
  }
  const window = { postMessage:message => messages.push(message),addEventListener:(name,fn) => {
    if (name === 'message') listeners.push(fn);
  } };
  const scope = vm.createContext({ window,location,XMLHttpRequest:Xhr,URL,Response,Headers,DOMException,Event,
    queueMicrotask,setTimeout,clearTimeout });
  vm.runInContext(source,scope);
  const controller = scope.XReplyNotificationNetwork.create({ accountHandle:() => env.account,
    readPayload:async response => response.ok ? response.clone().json() : null,
    observe:data => { env.observed = JSON.parse(JSON.stringify(data)); } });
  const message = data => listeners.forEach(fn => fn({ source:window,origin:location.origin,
    data:{ channel:'x-reply-context-v1',...data } }));
  message({ type:'NOTIFICATION_FILTER_SETTINGS',likes:true,follows:true });
  const url = cursorValue => `https://x.com/i/api/graphql/hash/NotificationsTimeline?variables=${encodeURIComponent(JSON.stringify({ timeline_type:'All',cursor:cursorValue }))}`;
  const context = { operation:'NotificationsTimeline',account:'me' };
  function xhr(cursorValue) {
    const req = new Xhr(); controller.prepareXHR(req,context,url(cursorValue)); req.open();
    controller.sendXHR(req,() => req.send()); return req;
  }
  return { controller,rewrite:scope.XReplyNotificationNetwork.rewrite,env,message,messages,url,context,xhr,location };
}

test('网络过滤按真实字段覆盖所有点赞与关注文案，保留评论、未知类型、游标及关闭选择',() => {
  const { rewrite } = setup();
  const data = payload([notice('heart_icon'),notice('heart_icon'),notice('person_icon'),tweet(),notice('retweet_icon')]);
  const result = rewrite(data,{ likes:true,follows:true });
  assert.equal(result.removed,3); assert.equal(result.remaining,2); assert.equal(entries(data).length,4);
  assert.equal(entries(data)[0].content.cursorType,'Top');
  const off = payload([notice('heart_icon'),notice('person_icon')]);
  rewrite(off,{ likes:false,follows:true }); assert.equal(entries(off).length,3);
  assert.equal(entries(off)[1].content.itemContent.notification_icon,'heart_icon');
  const legacy = { globalObjects:{ notifications:{ n1:{ icon:{ id:'heart_icon' } } } },timeline:{ instructions:[
    { addEntries:{ entries:[{ content:{ item:{ content:{ notification:{ id:'n1' } } } } },{ content:{ item:{ content:{ tweet:{ id:'123' } } } } }] } }
  ] } };
  assert.equal(rewrite(legacy,{ likes:true }).removed,1);
  assert.equal(legacy.timeline.instructions[0].addEntries.entries.length,1);
  assert.equal(rewrite({ data:{ changed:true } },{ likes:true }),null);
  const replaced = payload([]);
  const instructions = replaced.data.viewer_v2.user_results.result.notification_timeline.timeline.instructions;
  instructions.push({ type:'TimelineReplaceEntry',entry:notice('heart_icon') });
  assert.equal(rewrite(replaced,{ likes:true }).removed,1);
  assert.equal(instructions.length,3);
  assert.equal(replaced.data.viewer_v2.user_results.result.notification_timeline.timeline.instructions.length,2);
});

test('fetch 返回前过滤，先观察原始内容；空页仅暂停底部翻页，点击后放行一批',async () => {
  const { controller,env,message,url,context,messages } = setup();
  const data = payload([notice('heart_icon')]);
  const send = async () => { env.requests++; return new Response(JSON.stringify(data),{ headers:{ 'content-type':'application/json' } }); };
  const first = await controller.fetch([url('')],context,send);
  assert.equal(entries(await first.clone().json()).length,2);
  assert.equal(entries(env.observed).length,3,'本地记录链路仍收到原始内容');
  const next = controller.fetch([url('bottom-1')],context,send);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(env.requests,1);
  await controller.fetch([url('top-1')],context,send); assert.equal(env.requests,2,'顶部增量不被历史分页暂停卡住');
  message({ type:'NOTIFICATION_FILTER_CONTINUE',key:'me:All' });
  await next; assert.equal(env.requests,3);
  assert.equal(messages.at(-1).paused,true,'下一批仍全是过滤消息时再次停下');
  const abort = new AbortController();
  const pending = controller.fetch([url('bottom-1'),{ signal:abort.signal }],context,send);
  abort.abort(); await assert.rejects(pending,{ name:'AbortError' });
});

test('XHR 文本及JSON在原生读取时过滤，保留原始接收数据，暂停期间不发接口',async () => {
  const { controller,env,message,xhr } = setup();
  const first = xhr(''); first.complete(payload([notice('person_icon')]));
  assert.equal(entries(JSON.parse(first.responseText)).length,2);
  assert.equal(entries(JSON.parse(controller.originalXHR(first,'responseText'))).length,3);
  const next = xhr('bottom-1'); assert.equal(env.requests,1);
  message({ type:'NOTIFICATION_FILTER_CONTINUE',key:'me:All' }); assert.equal(env.requests,2);
  next.complete(payload([tweet(),notice('heart_icon')]),'json');
  assert.equal(entries(next.response).length,3); assert.equal(entries(controller.originalXHR(next,'response')).length,4);
  const after = xhr('bottom-1'); assert.equal(env.requests,3,'有保留内容后恢复原生滚动加载');
  after.complete(payload([notice('heart_icon')])); void after.responseText;
  const cancelled = xhr('bottom-1'); let aborted = 0; cancelled.addEventListener('abort',() => aborted++);
  cancelled.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted,1); assert.equal(env.requests,3);
  controller.prepareXHR(first,{ operation:'FavoriteTweet',account:'me' },'https://x.com/i/api/graphql/hash/FavoriteTweet','POST');
  first.open(); controller.sendXHR(first,()=>first.send());
  first.complete(payload([notice('heart_icon')]));
  assert.equal(entries(JSON.parse(first.responseText)).length,3,'复用XHR发送其他操作时移除旧过滤器');
});

test('换账号及离页取消等待请求，未知响应和非通知入口不改写',async () => {
  const { controller,env,message,context,url,location } = setup();
  const send = async () => new Response(JSON.stringify(payload([notice('heart_icon')])));
  await controller.fetch([url('')],context,send);
  const pending = controller.fetch([url('bottom-1')],context,send);
  location.pathname = '/home'; message({ type:'NOTIFICATION_FILTER_CONTEXT' });
  await assert.rejects(pending,{ name:'AbortError' });
  assert.equal(controller.handles({ operation:'FavoriteTweet' }),false);
  location.pathname = '/notifications'; env.account = 'other';
  const original = new Response(JSON.stringify(payload([notice('heart_icon')])));
  const result = await controller.fetch([url('')],context,async () => original);
  assert.equal(result,original);
});
