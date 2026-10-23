import { users,demoTweets,graphql } from './fixtures.mjs';
history.replaceState(null,'','/notifications?network-demo');
const core = globalThis.XReplyContext;
const state = core.createState(); core.ingest(state,{ users,tweets:demoTweets },'my_account');
const settings = { autoHideLikeNotifications:true,autoHideFollowNotifications:true };
const storageListeners = [];
globalThis.chrome = { runtime:{ id:'local-demo-extension',onMessage:{ addListener() {} },async sendMessage(message) {
  if (message.type === 'INGEST') { core.ingest(state,message.batch,message.account); evidence.ingests++; return { ok:true }; }
  return { ok:true,rows:core.classifyBatch(state,message.account,message.ids || []) };
} },storage:{ onChanged:{ addListener:fn => storageListeners.push(fn) },local:{
  get:async keys => Object.fromEntries(keys.map(key=>[key,settings[key]])),
  async set(next) { Object.assign(settings,next); storageListeners.forEach(fn=>fn(Object.fromEntries(Object.entries(next).map(([k,v])=>[k,{ newValue:v }])),'local')); }
} } };
const evidence = { requests:0,ingests:0,filteredEvents:0,renderedEvents:0,readingTop:null,afterTop:null };
const output = document.querySelector('#network-result');
const timeline = document.querySelector('#timeline');
const cursor = (type,value) => ({ content:{ entryType:'TimelineTimelineCursor',cursorType:type,value } });
const notice = icon => ({ content:{ entryType:'TimelineTimelineItem',itemContent:{ itemType:'TimelineNotification',notification_icon:icon } } });
const tweet = item => ({ content:{ entryType:'TimelineTimelineItem',itemContent:{ itemType:'TimelineTweet',tweet_results:{ result:graphql(item) } } } });
function payload(page) {
  const rows = page === 0 ? [...Array.from({ length:1000 },(_,i)=>notice(i%2 ? 'heart_icon' : 'person_icon')),tweet(demoTweets[11]),tweet(demoTweets[3])] :
    page === 1 ? Array.from({ length:20 },()=>notice('heart_icon')) : [tweet(demoTweets[7])];
  return { data:{ viewer_v2:{ user_results:{ result:{ notification_timeline:{ timeline:{ instructions:[{
    type:'TimelineAddEntries',entries:[cursor('Top',`top-${page}`),...rows,cursor('Bottom',`bottom-${page+1}`)]
  }] } } } } } } };
}
class FixtureXHR extends EventTarget {
  readyState = 0; status = 0; responseType = ''; raw = '';
  open(_method,url) { this.url = url; this.readyState = 1; }
  get responseText() { return this.raw; }
  get response() { return this.responseType === 'json' ? JSON.parse(this.raw) : this.raw; }
  abort() { this.readyState = 0; }
  send() {
    evidence.requests++;
    const variables = JSON.parse(new URL(this.url,location.href).searchParams.get('variables'));
    const page = Number(variables.cursor?.split('-')[1] || 0);
    setTimeout(()=> {
      this.raw = JSON.stringify(payload(page)); this.status = 200; this.readyState = 4;
      this.dispatchEvent(new Event('readystatechange')); this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend'));
    },30);
  }
}
globalThis.XMLHttpRequest = FixtureXHR;
await import('/extension/notification-network.js');
await import('/extension/observe.js');
await import('/extension/card-filter.js');
await import('/extension/home-filter.js');
await import('/extension/notification-filter.js');
await import('/extension/content.js');

let bottom = '';
function updateEvidence() {
  const reading = timeline.querySelector('article');
  evidence.afterTop = reading?.getBoundingClientRect().top;
  output.dataset.evidence = JSON.stringify(evidence);
  output.textContent = `原生请求 ${evidence.requests} 次 · 当前评论 ${timeline.children.length} 条\n初批1000条点赞/关注在接收时过滤，无隐藏占位。\n`+
    `阅读锚点 ${evidence.readingTop ?? '待记录'} → ${evidence.afterTop ?? '待记录'}px`;
}
function load() {
  const page = Number(bottom?.split('-')[1] || 0);
  const xhr = new XMLHttpRequest();
  xhr.open('GET',`/i/api/graphql/fixture/NotificationsTimeline?variables=${encodeURIComponent(JSON.stringify({ timeline_type:'All',cursor:bottom }))}`);
  xhr.addEventListener('readystatechange',()=> {
    if (xhr.readyState !== 4) return;
    const data = JSON.parse(xhr.responseText);
    const rows = data.data.viewer_v2.user_results.result.notification_timeline.timeline.instructions[0].entries;
    const received = rows.filter(row=>row.content.entryType !== 'TimelineTimelineCursor').length;
    evidence.filteredEvents += (page === 0 ? 1002 : page === 1 ? 20 : 1)-received;
    let count = 0;
    for (const entry of rows) {
      const content = entry.content;
      if (content.cursorType === 'Bottom') bottom = content.value;
      if (content.itemContent?.itemType === 'TimelineNotification') {
        const article = document.createElement('article'); article.dataset.testid = 'notification';
        article.textContent = '本应被接收过滤移除的点赞／关注通知'; timeline.append(article);
        evidence.renderedEvents++; count++; continue;
      }
      if (content.itemContent?.itemType !== 'TimelineTweet') continue;
      const item = content.itemContent.tweet_results.result;
      const article = document.createElement('article'); article.dataset.testid = 'tweet';
      article.innerHTML = `<div class="body"><a href="/alice/status/${item.rest_id}"><time datetime="2026-10-23T00:00:00Z">虚构评论</time></a><div data-testid="tweetText">${item.legacy.full_text}</div><div role="group" class="actions"><button>回复</button><button>红心</button></div></div>`;
      timeline.append(article); count++;
    }
    if (evidence.readingTop === null) evidence.readingTop = timeline.querySelector('article')?.getBoundingClientRect().top;
    updateEvidence();
    // Model both empty-page retries and one fill request after the first manual continuation.
    if ((!count || page === 2) && bottom) load();
  });
  xhr.send(); updateEvidence();
}
document.querySelector('#load-batch').addEventListener('click',load);
setTimeout(load,100);
