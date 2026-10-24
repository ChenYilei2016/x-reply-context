import {performanceState,fixtureRootId} from '/tests/diagnostics/performance-fixture.mjs';
history.replaceState(null,'','/notifications?audit');
const core=globalThis.XReplyContext, output=document.querySelector('#result'),run=document.querySelector('#run');
const legacy=performanceState(core), root=fixtureRootId(0), id='audit-extension';
const settings={replyContext:legacy,hideCompletedNotifications:true,autoOrganizeNotifications:false,autoHideLikeNotifications:false,autoHideFollowNotifications:false};
const listeners=[];let backgroundListener;const calls=[];
const connections=[], originalOpen=indexedDB.open.bind(indexedDB);
indexedDB.open=(...args)=>{const r=originalOpen(...args);r.addEventListener('success',()=>connections.push(r.result));return r;};
globalThis.chrome={runtime:{id,getURL:p=>`chrome-extension://${id}${p}`,onMessage:{addListener:f=>{backgroundListener ||=f;}},sendMessage:m=>new Promise(resolve=>{const log={type:m.type,rows:m.ids?.length||0,start:performance.now()};calls.push(log);backgroundListener(m,{id,url:'https://x.com/notifications'},r=>{log.end=performance.now();resolve(r);});})},storage:{onChanged:{addListener:f=>listeners.push(f)},local:{get:async keys=>typeof keys==='string'?{[keys]:structuredClone(settings[keys])}:Object.fromEntries(keys.map(k=>[k,settings[k]])),set:async next=>{Object.assign(settings,next);listeners.forEach(f=>f(Object.fromEntries(Object.entries(next).map(([k,v])=>[k,{newValue:v}])),'local'));}}}};
globalThis.importScripts=()=>{};await import('/extension/background.js');
let responseAt=0, deferred=false;
window.fetch=async url=>{await new Promise(r=>setTimeout(r,800));responseAt=performance.now();return new Response(JSON.stringify({data:{[String(url).includes('Unfavorite')?'unfavorite_tweet':'favorite_tweet']:'Done'}}),{headers:{'content-type':'application/json'}});};
const article=document.createElement('article');article.dataset.testid='tweet';
article.innerHTML=`<a href="/u0/status/${root}"><time>今天</time></a><div><div data-testid="tweetText">虚构原帖</div></div><div role="group"><button data-testid="reply">打开空回复框</button><button data-testid="like">♡</button></div>`;
document.querySelector('#timeline').append(article);
const native=article.querySelector('[data-testid="like"]');
native.addEventListener('click',async()=>{const liked=native.dataset.testid==='unlike';native.disabled=true;const display=()=>{native.dataset.testid=liked?'like':'unlike';native.textContent=liked?'♡':'♥';};if(deferred)requestAnimationFrame(display);else display();await window.fetch(`/i/api/graphql/test/${liked?'UnfavoriteTweet':'FavoriteTweet'}`,{method:'POST',body:JSON.stringify({variables:{tweet_id:root}})});native.disabled=false;});
article.querySelector('[data-testid="reply"]').addEventListener('click',()=>{const d=document.createElement('div');d.className='dialog';d.setAttribute('role','dialog');d.innerHTML='<button data-testid="app-bar-close">关闭</button><div contenteditable="true" data-testid="tweetTextarea_0"></div><div data-testid="toolBar"><button data-testid="tweetButton" disabled>回复</button></div>';d.querySelector('[data-testid="app-bar-close"]').addEventListener('click',()=>{d.remove();history.replaceState(null,'','/notifications');window.dispatchEvent(new PopStateEvent('popstate'));});document.body.append(d);history.replaceState(null,'','/compose/post');});
await import('/extension/observe.js');await import('/extension/card-filter.js');await import('/extension/home-filter.js');await import('/extension/notification-filter.js');await import('/extension/editor.js');await import('/extension/continuous.js');await import('/extension/content.js');
const wait=async condition=>{const until=performance.now()+15000;while(!condition()){if(performance.now()>until)throw Error('timeout');await new Promise(r=>setTimeout(r,5));}};
await wait(()=>article.querySelector('.xrc-labels'));
run.disabled=false;output.textContent='已就绪';
run.addEventListener('click',async()=>{run.disabled=true;const results=[];try{
 const readingTop=article.getBoundingClientRect().top; const openStart=performance.now();article.querySelector('[data-testid="reply"]').click();const nativeDialogMs=performance.now()-openStart;await wait(()=>document.querySelector('.xrc-flow-heart')?.getAttribute('aria-pressed')==='false');results.push({mode:'composer-open',nativeDialogMs,pluginReadyMs:performance.now()-openStart});
 for(const mode of ['synchronous-native','next-frame-native']){
 deferred=mode==='next-frame-native';await wait(()=>!document.querySelector('.xrc-flow-heart').disabled);calls.length=0;
 const start=performance.now();responseAt=0;let nativeAt=0,buttonAt=0,labelAt=0;
 const watch=new MutationObserver(()=>{const now=performance.now();if(!nativeAt&&native.dataset.testid==='unlike')nativeAt=now;if(!buttonAt&&document.querySelector('.xrc-flow-heart')?.getAttribute('aria-pressed')==='true')buttonAt=now;if(!labelAt&&document.querySelector('.xrc-flow-context .xrc-heart')?.dataset.confirmed==='true')labelAt=now;});watch.observe(document.body,{subtree:true,attributes:true,childList:true,characterData:true});
 document.querySelector('.xrc-flow-heart').click();await wait(()=>labelAt&&buttonAt&&responseAt);watch.disconnect();
 results.push({mode,visibility:document.visibilityState,nativeFromClick:nativeAt-start,buttonAfterNative:buttonAt-nativeAt,labelAfterResponse:labelAt-responseAt,networkMs:responseAt-start,buttonWithin100ms:buttonAt-nativeAt<100,calls:calls.map(c=>({...c,start:c.start-start,end:c.end?c.end-start:null}))});
 deferred=false;document.querySelector('.xrc-flow-heart').click();await wait(()=>document.querySelector('.xrc-flow-context .xrc-heart')?.dataset.confirmed==='false'&&!native.disabled);
 }
 document.querySelector('[data-testid="app-bar-close"]').click();
 await new Promise(r=>setTimeout(r,350));
 results.push({mode:'close-empty-composer',beforeTop:readingTop,afterTop:article.getBoundingClientRect().top,stable:Math.abs(article.getBoundingClientRect().top-readingTop)<1});
 for(let i=1;i<=20;i++){const a=article.cloneNode(true);a.querySelector('time').closest('a').href='/u'+i+'/status/'+fixtureRootId(i);delete a.dataset.xrcId;document.querySelector('#timeline').append(a);}
 await wait(()=>[...document.querySelectorAll('article')].every(a=>a.dataset.xrcId===a.querySelector('time').closest('a').getAttribute('href').split('/').at(-1)));
 const side=document.createElement('aside');document.body.append(side);await new Promise(r=>setTimeout(r,300));
 const originalQuery=Element.prototype.querySelectorAll;let scans=0;Element.prototype.querySelectorAll=function(selector){if(selector==='article[data-testid="tweet"]')scans++;return Reflect.apply(originalQuery,this,[selector]);};
 const scanStart=performance.now();for(let i=0;i<100;i++){side.textContent='unrelated sidebar '+i;await Promise.resolve();}await Promise.resolve();
 Element.prototype.querySelectorAll=originalQuery;results.push({mode:'unrelated-sidebar-mutations',mutations:100,mountedCards:21,timelineScans:scans,elapsedMs:performance.now()-scanStart});
 output.dataset.result='done';output.dataset.evidence=JSON.stringify(results);output.textContent=JSON.stringify(results,null,2);
}catch(e){output.dataset.result='failed';output.textContent=e.stack;} });
window.addEventListener('pagehide',()=>{connections.forEach(d=>d.close());indexedDB.deleteDatabase('x-reply-context-records');});
