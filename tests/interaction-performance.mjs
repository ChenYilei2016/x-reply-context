import { performanceState,fixtureRootId } from './diagnostics/performance-fixture.mjs';
history.replaceState(null,'','/notifications?interaction-performance');
const core = globalThis.XReplyContext;
const output = document.querySelector('#result');
const button = document.querySelector('#run');
const root = fixtureRootId(0);
const state = performanceState(core);
const extensionId = 'local-performance-fixture';
const local = { replyContext:state,hideCompletedNotifications:false,autoHideLikeNotifications:false,autoHideFollowNotifications:false };
const storageListeners = []; let backgroundListener;
const connections = []; const originalOpen = indexedDB.open.bind(indexedDB);
const waitRequest = request => new Promise((resolve,reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
await waitRequest(indexedDB.deleteDatabase('x-reply-context-records'));
indexedDB.open = (...args) => {
  const request = originalOpen(...args); request.addEventListener('success',() => connections.push(request.result)); return request;
};
let notificationBytes = 0;
globalThis.chrome = {
  runtime:{ id:extensionId,getURL:path => `chrome-extension://${extensionId}${path}`,
    onMessage:{ addListener:listener => { backgroundListener ||= listener; } },
    sendMessage:message => new Promise(resolve => backgroundListener(message,{ id:extensionId,url:'https://x.com/notifications' },resolve)) },
  storage:{ onChanged:{ addListener:listener => storageListeners.push(listener) },local:{
    get:async keys => typeof keys === 'string' ? { [keys]:structuredClone(local[keys]) } : Object.fromEntries(keys.map(key => [key,local[key]])),
    set:async values => {
      notificationBytes += JSON.stringify(values).length;
      Object.assign(local,values);
      storageListeners.forEach(listener => listener(Object.fromEntries(Object.entries(values).map(([key,value]) => [key,{ newValue:value }])),'local'));
    }
  } }
};
globalThis.importScripts = () => {};
await import('/extension/background.js');
let responseAt = 0; let requestAt = 0;
window.fetch = async () => {
  requestAt = performance.now(); await new Promise(resolve => setTimeout(resolve,150)); responseAt = performance.now();
  return new Response(JSON.stringify({ data:{ favorite_tweet:'Done' } }),{ headers:{ 'content-type':'application/json' } });
};
const article = document.createElement('article'); article.dataset.testid = 'tweet';
article.innerHTML = `<a href="/u0/status/${root}"><time>刚刚</time></a> @u0 · 引用转发
  <div><div data-testid="tweetText">这是我引用别人的内容后发表的新帖。</div></div>
  <div class="quoted" role="link"><strong>@me · 被引用的帖子</strong><div data-testid="tweetText">内嵌内容不会改变外层原帖的归属。</div></div>
  <div role="group"><button data-testid="reply">回复（不发送）</button><button data-testid="like">♡</button></div>`;
document.querySelector('#timeline').append(article);
const heart = article.querySelector('[data-testid="like"]');
heart.addEventListener('click',async () => {
  heart.disabled = true;
  await window.fetch('/i/api/graphql/fixture/FavoriteTweet',{ method:'POST',body:JSON.stringify({ variables:{ tweet_id:root } }) });
  heart.dataset.testid = 'unlike'; heart.textContent = '♥'; heart.disabled = false;
});
await import('/extension/observe.js');
await import('/extension/card-filter.js'); await import('/extension/home-filter.js');
await import('/extension/notification-filter.js'); await import('/extension/content.js');
const wait = async condition => {
  const until = performance.now()+15000;
  while (!condition()) { if (performance.now()>until) throw new Error('验证等待超时'); await new Promise(resolve => setTimeout(resolve,10)); }
};
await wait(() => article.querySelector('.xrc-heart'));
button.disabled = false; output.textContent = '已就绪：引用帖标签已显示，尚未点赞。';
button.addEventListener('click',async () => {
  button.disabled = true;
  try {
    const before = article.getBoundingClientRect().top;
    heart.click();
    await wait(() => article.querySelector('.xrc-heart')?.dataset.confirmed === 'true');
    const result = { fixture:true,networkMs:responseAt-requestAt,afterResponseMs:performance.now()-responseAt,
      totalMs:performance.now()-requestAt,notificationBytes,readingTop:[before,article.getBoundingClientRect().top],
      labels:article.querySelector('.xrc-labels').innerText };
    output.dataset.evidence = JSON.stringify(result); output.dataset.result = 'passed'; output.textContent = JSON.stringify(result,null,2);
  } catch(error) { output.dataset.result = 'failed'; output.textContent = error.message; }
});
window.addEventListener('pagehide',() => { connections.forEach(db => db.close()); indexedDB.deleteDatabase('x-reply-context-records'); });
