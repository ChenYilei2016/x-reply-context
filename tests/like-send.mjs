history.replaceState(null,'','/home');
let flow,frame,run,sequence=0,account='me',randomSkipLike=false;
const output=document.querySelector('#result');
const schedule=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;flow.refresh();timed?.refresh();});};
const dialog=()=>document.querySelector('.dialog');
const editor=()=>dialog()?.querySelector('[contenteditable]');
const wait=async(predicate,timeout=4000)=>{const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('等待组合流程超时');await new Promise(r=>setTimeout(r,20));}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let timedSettingChanged, holdNext;
const timed=XReplyTimedReplies.create({storage:{local:{get:async()=>({})},onChanged:{addListener:fn=>{timedSettingChanged=fn;}}},
 readState:()=>flow?.timedState(),trigger:state=>flow?.timedSend(state),requestRefresh:schedule,onInterrupt:reason=>flow?.cancelTimedFollowup(reason)});
const guard=XReplyInteractionAlert.create({accountHandle:()=>account,onPause:()=>flow?.pauseForAlert(),onRelease:()=>flow?.stop()});
flow=XReplyContinuous.create({timedReplies:timed,randomSkipLikeEnabled:()=>randomSkipLike,interactionBlocked:()=>guard.blocked(),accountHandle:()=>account,connected:()=>true,tweetId:a=>a.dataset.id,columnSelector:'main',requestRefresh:schedule,
 message:async m=>{
  if(holdNext && !m.includeRootText && m.ids.includes('200'))await holdNext();
  return {ok:true,rows:m.ids.map(id=>({id,origin:'others',status:'not-reply',authorHandle:'peer',evidenceId:run.replied.has(id)?'saved':'',likeEvidenceId:run.liked.has(id)?id:''}))};
 },renderLabels:(node)=>{node.textContent='本地数据';}});
function open(target,current){
 if(dialog())return;
 const modal=document.createElement('div');modal.className='dialog';modal.role='dialog';modal.dataset.target=target;
 modal.innerHTML='<button data-testid="app-bar-close">关闭</button><p>本地原帖 '+target+'</p><div contenteditable="true" data-testid="tweetTextarea_0"></div><div data-testid="toolBar"><button data-testid="tweetButton">回复（仅计数）</button></div>';
 modal.querySelector('[data-testid=app-bar-close]').onclick=()=>{modal.remove();history.replaceState(null,'','/home');schedule();};
 modal.querySelector('[data-testid=tweetButton]').disabled=true;
 modal.querySelector('[contenteditable]').addEventListener('input',()=>{modal.querySelector('[data-testid=tweetButton]').disabled=!modal.querySelector('[contenteditable]').innerText.trim();});
 modal.querySelector('[data-testid=tweetButton]').onclick=()=>{
  current.events.push({kind:'send',id:target,at:performance.now()});
  const startedAt=Date.now(),requestId='test-'+(++sequence);void flow.receiveReply({type:'REPLY_STARTED',account:'me',parentId:target,startedAt,requestId});
  setTimeout(()=>{
   if(current.replyMode==='failed' || current.replyMode==='unknown') {
    void flow.receiveReply({type:'REPLY_RESULT',account:'me',parentId:target,startedAt,requestId,status:current.replyMode},null);return;
   }
   const saved=new Promise((resolve,reject)=>setTimeout(()=>{
    if(current.replyMode==='save-failed'){reject(new Error('reply save failed'));return;}
    current.replied.add(target);current.events.push({kind:'reply-saved',id:target,at:performance.now()});resolve();
   },current.replySaveDelay));
   modal.remove();history.replaceState(null,'','/home');schedule();
   void flow.receiveReply({type:'REPLY_RESULT',account:'me',parentId:target,startedAt,requestId,status:'sent',batch:{users:[{id:'1',handle:'me'}],tweets:[{id:'999',authorId:'1',parentId:target}]}},saved);
  },current.replyDelay);

 };
 document.body.append(modal);history.replaceState(null,'','/compose/post');editor().focus();schedule();
}
async function reset(options={}){
 flow.stop();dialog()?.remove();account='me';randomSkipLike=options.randomSkipLike===true;history.replaceState(null,'','/home');
 const current=run={events:[],liked:new Set(options.liked?['100']:[]),replied:new Set(),mode:options.mode||'success',saveDelay:options.saveDelay||0,replyMode:options.replyMode||'success',replySaveDelay:options.replySaveDelay||0,replyDelay:options.replyDelay||30};
 document.querySelector('#cards').replaceChildren();
 for(const id of ['100','200']){
  const article=document.createElement('article');article.dataset.testid='tweet';article.dataset.id=id;
  article.innerHTML='<a href="/peer/status/'+id+'"><time>帖子 '+id+'</time></a><p data-testid="tweetText">虚构帖子</p><button data-testid="reply">打开 '+id+'</button><button data-testid="'+(current.liked.has(id)?'unlike':'like')+'">红心（仅计数）</button>';
  article.querySelector('[data-testid=reply]').onclick=()=>open(id,current);
  article.querySelector('[data-testid=like],[data-testid=unlike]').onclick=event=>{
   const button=event.currentTarget,startedAt=Date.now();
   current.events.push({kind:'like',id,at:performance.now()});button.dataset.testid='unlike';
   setTimeout(()=>{
    if(current.mode==='failed'){button.dataset.testid='like';return;}
    current.events.push({kind:'like-success',id,at:performance.now()});
    const saved=new Promise((resolve,reject)=>setTimeout(()=>{
     if(current.mode==='save-failed'){reject(new Error('模拟保存失败'));return;}
     current.liked.add(id);current.events.push({kind:'like-saved',id,at:performance.now()});resolve({ok:true});
    },current.saveDelay));
    void flow.receiveLike({account:'me',requestStartedAt:startedAt,batch:{likes:[{id,liked:true,source:'mutation'}]}},saved);
   },80);
  };
  document.querySelector('#cards').append(article);
 }
 document.querySelector('[data-testid=reply]').click();await wait(()=>dialog()?.querySelector('.xrc-flow-send'));
 editor().textContent='只用于本地检查';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));schedule();await sleep(40);
 return current;
}
document.querySelector('#run').onclick=async event=>{
 event.target.disabled=true;output.dataset.result='running';const checks=[];
 const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw new Error(name);};
 const send=()=>document.querySelector('.xrc-flow-send').click();
 const notice=()=>document.querySelector('.xrc-flow-notice')?.textContent || '';
 try{
  let current=await reset({replySaveDelay:160,saveDelay:160});
  const skip=document.querySelector('.xrc-flow-skip'),primary=document.querySelector('.xrc-flow-send');
  check('保留同一行紧凑布局且文案为评论点赞下条',primary.textContent==='评论点赞下条'&&skip.parentElement===primary.parentElement&&Math.abs(skip.getBoundingClientRect().top-primary.getBoundingClientRect().top)<1&&primary.getBoundingClientRect().width<150);
  send();send();await wait(()=>dialog()?.dataset.target==='200');
  const actions=current.events,replySaved=actions.find(e=>e.kind==='reply-saved'),liked=actions.find(e=>e.kind==='like'),likeSaved=actions.find(e=>e.kind==='like-saved');
  check('评论成功保存后至少等待300ms才点赞，点赞保存后进入下一条，连点不重复',
   actions.filter(e=>e.kind==='send').length===1&&actions.filter(e=>e.kind==='like').length===1&&
   actions[0].kind==='send'&&liked.at-replySaved.at>=290&&likeSaved.at>=liked.at&&current.liked.has('100'));
  current=await reset({liked:true});send();await wait(()=>dialog()?.dataset.target==='200');
  check('已点赞不重复点击，更不取消点赞',current.events.every(e=>e.kind!=='like')&&current.events.filter(e=>e.kind==='send').length===1);
  current=await reset({replyMode:'failed'});send();await wait(()=>document.querySelector('.xrc-flow-status')?.textContent.includes('发送失败'));await sleep(800);
  check('评论失败不点赞不跳转，原草稿保留',current.events.length===1&&editor().innerText==='只用于本地检查');
  current=await reset({replyMode:'unknown'});send();await wait(()=>document.querySelector('.xrc-flow-status')?.textContent.includes('未确认'));await sleep(800);
  check('评论结果不明不点赞不重发',current.events.length===1&&dialog()?.dataset.target==='100');
  current=await reset({replyMode:'save-failed'});send();await wait(()=>notice().includes('本地记录未保存'));await sleep(800);
  check('评论已发但保存失败不点赞，也不自动重发',current.events.length===1&&!dialog());
  current=await reset({replyDelay:250});send();dialog().querySelector('[data-testid=app-bar-close]').click();await sleep(1100);
  check('手动关闭后晚到评论回执不点赞或续开',current.events.filter(e=>e.kind==='send').length===1&&!current.events.some(e=>e.kind==='like')&&!dialog());
  current=await reset();send();await wait(()=>notice().includes('稍候点赞'));account='other';schedule();await sleep(800);
  check('发送后换账号不点赞新账号或打开下一条',current.events.filter(e=>e.kind==='send').length===1&&!current.events.some(e=>e.kind==='like')&&!dialog());
  current=await reset();send();await wait(()=>notice().includes('稍候点赞'));
  document.querySelector('article[data-id="100"]').remove();await wait(()=>dialog()?.dataset.target==='200');
  check('原卡片移出列表时略过点赞进入下一条，不误点其他帖也不补造红心',current.replied.has('100')&&!current.liked.has('100')&&!current.events.some(e=>e.kind==='like')&&current.events.filter(e=>e.kind==='send').length===1);
  for(const unavailable of ['disabled','missing']) {
    current=await reset();send();await wait(()=>notice().includes('稍候点赞'));
    const heart=document.querySelector('article[data-id="100"] [data-testid=like]');
    if(unavailable==='disabled')heart.disabled=true;else heart.remove();
    await wait(()=>dialog()?.dataset.target==='200');
    check('点赞按钮'+unavailable+'时不重试，只打开下一条',!current.events.some(e=>e.kind==='like')&&current.replied.has('100')&&current.events.filter(e=>e.kind==='send').length===1);
  }
  current=await reset({mode:'failed'});document.querySelector('.xrc-flow-heart').click();send();await wait(()=>notice().includes('稍候点赞'));
  document.querySelector('article[data-id="100"]').remove();await sleep(800);
  check('按钮不可用但之前点赞尚未确认时仍暂停',!dialog()&&notice().includes('尚未确认')&&current.events.filter(e=>e.kind==='like').length===1);
  current=await reset();send();await wait(()=>notice().includes('稍候点赞'));document.querySelector('article[data-id="100"]').remove();
  guard.show({account:'me',operation:'FavoriteTweet',httpStatus:429});await sleep(800);
  check('卡片消失同时出现红字，不越过暂停进入下一条',guard.blocked()&&!dialog()&&!current.events.some(e=>e.kind==='like'));
  document.querySelector('.xrc-interaction-alert button').click();
  current=await reset({saveDelay:700});send();await wait(()=>current.events.some(e=>e.kind==='like'));
  await flow.receiveLike({account:'me',requestStartedAt:0,batch:{likes:[{id:'100',liked:true,source:'mutation'}]}},Promise.resolve());await sleep(120);
  check('旧点赞回执不能跳过本次保存确认',!dialog()&&!current.events.some(e=>e.kind==='like-saved'));
  await wait(()=>dialog()?.dataset.target==='200');
  check('本次点赞确认后进入下一条，评论仍只发一次',current.events.filter(e=>e.kind==='send').length===1);
  current=await reset({mode:'save-failed'});send();await wait(()=>notice().includes('记录未保存'));
  check('点赞保存失败只提示评论已发，不启用重发评论',current.replied.has('100')&&current.events.filter(e=>e.kind==='send').length===1&&notice().includes('下一条'));
  document.querySelector('.xrc-flow-notice button').click();await wait(()=>dialog()?.dataset.target==='200');
  check('失败后手动继续只打开下一条，不重发或重赞',current.events.filter(e=>e.kind==='send').length===1&&current.events.filter(e=>e.kind==='like').length===1);
  current=await reset({mode:'failed'});send();await wait(()=>notice().includes('点赞结果未确认'),12000);
  check('点赞无回执超时保留评论成功，不自动重试或跳转',current.events.filter(e=>e.kind==='like').length===1&&current.events.filter(e=>e.kind==='send').length===1&&current.replied.has('100')&&!dialog());
  current=await reset();dialog().querySelector('[data-testid=tweetButton]').click();await sleep(900);
  check('原生回复按钮仍只发当前评论，不附带点赞或下一条',current.events.filter(e=>e.kind==='send').length===1&&!current.events.some(e=>e.kind==='like')&&!dialog());
  current=await reset();editor().textContent='';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('.xrc-flow-skip').click();await wait(()=>dialog()?.dataset.target==='200');
  check('跳过仍不点赞或发送',current.events.length===0);
 }catch(error){checks.push({name:error.message,ok:false});}
 finally{flow.stop();dialog()?.remove();history.replaceState(null,'','/home');event.target.disabled=false;}
 output.dataset.result=checks.every(c=>c.ok)?'passed':'failed';output.textContent=JSON.stringify({fixture:true,checks},null,2);
};

// Focused keyboard checks use local counters only; no X requests.
document.querySelector('#shortcut-run').onclick=async event=>{
 event.target.disabled=true;const result=document.querySelector('#shortcut-result'),checks=[];
 const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 const key=(options={},target=editor())=>{
  const event=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',altKey:true,bubbles:true,cancelable:true,...options});
  target.dispatchEvent(event);return event.defaultPrevented;
 };
 result.dataset.result='running';
 try{
  const current=await reset();
  key({isComposing:true});key({keyCode:229});key({repeat:true});
  key({ctrlKey:true});key({metaKey:true});key({shiftKey:true});key({},document.body);
  check('组字、长按、额外修饰键及输入框外不触发',current.events.length===0);
  const button=document.querySelector('.xrc-flow-send');button.disabled=true;
  const blocked=key();
  check('按钮禁用时不发送，同时阻止按键落到原生操作',blocked&&current.events.length===0);
  schedule();await wait(()=>!button.disabled);
  editor().textContent='';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));schedule();
  await wait(()=>button.disabled);key();
  check('空草稿不会触发组合操作',current.events.length===0);
  editor().textContent='只用于快捷键本地验证';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));schedule();
  await wait(()=>!button.disabled);
  check('按钮提示并声明 Option Alt Enter',button.title.includes('Option/Alt+Enter')&&button.getAttribute('aria-keyshortcuts')==='Alt+Enter');
  const prevented=key();key({repeat:true});key();
  await wait(()=>dialog()?.dataset.target==='200');
  check('Option Enter只触发一次现有先评论后点赞流程并进入下一条',prevented&&current.events[0].kind==='send'&&
    current.events.filter(e=>e.kind==='send').length===1&&current.events.filter(e=>e.kind==='like').length===1);
  for(const trigger of ['按钮','Option Enter']){
   const next=await reset({replySaveDelay:160});
   if(trigger==='按钮')document.querySelector('.xrc-flow-send').click();else key();
   await wait(()=>!dialog());
   // Simulate a native timeline listener reopening the last active post.
   const reopen=event=>{if(!event.defaultPrevented)open('100',next);};
   document.addEventListener('keydown',reopen,{capture:true,once:true});
   const blocked=key({},document.body);
   document.removeEventListener('keydown',reopen,true);
   check(trigger+'发送后，空档按键被拦截，旧帖回复框不会重开',blocked&&!dialog());
   await wait(()=>dialog()?.dataset.target==='200');
  }
 }catch(error){checks.push({name:error.message,ok:false});}
 finally{flow.stop();dialog()?.remove();history.replaceState(null,'','/home');event.target.disabled=false;}
 result.dataset.result=checks.every(c=>c.ok)?'passed':'failed';result.textContent=JSON.stringify({fixture:true,checks},null,2);
};


// Persistent warning gate, using native fixture controls and the actual continuous-flow module.
document.querySelector('#alert-run').onclick=async event=>{
 event.target.disabled=true;const result=document.querySelector('#alert-result'),checks=[];
 const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 const alert={account:'me',operation:'FavoriteTweet',targetId:'100',httpStatus:429,reason:'failed',code:'88',message:'Rate limit exceeded <b>test</b>',retryAfter:'60'};
 const acknowledge=()=>document.querySelector('.xrc-interaction-alert button')?.click();
 result.dataset.result='running';
 try {
  let current=await reset();
  const position=editor().getBoundingClientRect().top,scroll=scrollY;
  guard.show(alert);
  const panel=document.querySelector('.xrc-interaction-alert');
  check('红色持久提示包含操作、HTTP、错误码、原文及Retry-After，按文本显示',panel.textContent.includes('HTTP 429')&&panel.textContent.includes('错误码 88')&&panel.textContent.includes('60')&&panel.textContent.includes('<b>test</b>')&&!panel.querySelector('b')&&panel.getAttribute('role')==='alert');
  check('提示固定覆盖，不移动编辑框或列表，原草稿保留',getComputedStyle(panel).position==='fixed'&&editor().getBoundingClientRect().top===position&&scrollY===scroll&&editor().innerText==='只用于本地检查');
  for(let i=0;i<5;i++){
   document.querySelector('[data-testid=tweetButton]').click();document.querySelector('[data-testid=like]').click();
   editor().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true}));
   editor().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
  }
  check('连续点原生发送/点赞及快捷键被拦截，组合按钮禁用',current.events.length===0&&document.querySelector('.xrc-flow-send').disabled&&document.querySelector('.xrc-flow-heart').disabled);
  const watcher=new MutationObserver(()=>{});watcher.observe(panel,{subtree:true,childList:true,attributes:true,characterData:true});
  for(let i=0;i<100;i++)guard.show(alert);
  check('相同异常100次不重复写DOM或累积提示',watcher.takeRecords().length===0&&document.querySelectorAll('.xrc-interaction-alert').length===1);watcher.disconnect();
  acknowledge();check('解除暂停本身不提交、不点赞、不换页，草稿仍在',!guard.blocked()&&current.events.length===0&&editor().innerText==='只用于本地检查');
  current=await reset();document.querySelector('.xrc-flow-send').click();await wait(()=>document.querySelector('.xrc-flow-notice')?.textContent.includes('稍候点赞'));
  guard.show(alert);await sleep(850);
  check('发送已成功后收到异常，取消延迟点赞和下一条但保留成功记录',current.replied.has('100')&&current.events.filter(e=>e.kind==='send').length===1&&!current.events.some(e=>e.kind==='like')&&!dialog());
  acknowledge();current=await reset({replyDelay:250});document.querySelector('.xrc-flow-send').click();guard.show(alert);await sleep(1000);
  check('暂停前已在途的成功回执仍保存，但不再点赞/续开',current.replied.has('100')&&current.events.filter(e=>e.kind==='send').length===1&&!current.events.some(e=>e.kind==='like')&&!dialog());
  acknowledge();guard.show({...alert,account:'other'});check('旧账号异常不在当前账号弹出或暂停',!guard.blocked()&&!document.querySelector('.xrc-interaction-alert'));
  await reset();guard.show(alert); // Leave an example visible for visual inspection; fixture only.
 }catch(error){checks.push({name:error.message,ok:false});}
 finally{event.target.disabled=false;}
 result.dataset.result=checks.every(c=>c.ok)?'passed':'failed';result.textContent=JSON.stringify({fixture:true,checks},null,2);
};


// Deterministic choices around the 50% boundary; all actions are local fixture counters.
document.querySelector('#random-like-run').onclick=async event=>{
 event.target.disabled=true;const result=document.querySelector('#random-like-result'),checks=[];
 const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 const choose=value=>{
  const original=Math.random;let draws=0;Math.random=()=>{draws++;return value;};
  try {document.querySelector('.xrc-flow-send').click();document.querySelector('.xrc-flow-send')?.click();for(let i=0;i<20;i++)flow.refresh();}
  finally {Math.random=original;}
  return draws;
 };
 result.dataset.result='running';
 try {
  let current=await reset({randomSkipLike:true});
  check('点击和重复渲染只做一次50%选择',choose(0.49)===1);
  randomSkipLike=false;await wait(()=>dialog()?.dataset.target==='200');
  let saved=current.events.find(e=>e.kind==='reply-saved');
  check('命中不点赞仍停顿后进入下一条，评论记录保留且无红心记录',performance.now()-saved.at>=290&&current.replied.has('100')&&!current.liked.has('100')&&!current.events.some(e=>e.kind==='like'));
  check('中途关闭开关不改变已选分支，连点不重复发',current.events.filter(e=>e.kind==='send').length===1);
  current=await reset({randomSkipLike:true});choose(0.5);await wait(()=>dialog()?.dataset.target==='200');
  saved=current.events.find(e=>e.kind==='reply-saved');const liked=current.events.find(e=>e.kind==='like');
  check('另一半分支按原流程停顿、点赞并保存后进入下一条',liked.at-saved.at>=290&&current.liked.has('100')&&current.events.filter(e=>e.kind==='like').length===1);
  current=await reset();check('关闭开关不进行概率选择',choose(0.1)===0);await wait(()=>dialog()?.dataset.target==='200');check('默认关闭仍执行原点赞流程',current.liked.has('100'));
  current=await reset({randomSkipLike:true,liked:true});choose(0.1);await wait(()=>dialog()?.dataset.target==='200');check('跳过点赞不会取消已有红心',current.liked.has('100')&&!current.events.some(e=>e.kind==='like'));
  current=await reset({randomSkipLike:true,replyMode:'failed'});choose(0.1);await wait(()=>document.querySelector('.xrc-flow-status')?.textContent.includes('发送失败'));await sleep(800);
  check('评论失败不点赞、不跳转、不写成功记录',dialog()?.dataset.target==='100'&&!current.replied.has('100')&&!current.events.some(e=>e.kind==='like'));
  current=await reset({randomSkipLike:true,replyDelay:200});choose(0.1);dialog().querySelector('[data-testid=app-bar-close]').click();await sleep(1000);
  check('随机不点赞分支也遵守关闭取消，不续开下一条',!dialog()&&!current.events.some(e=>e.kind==='like'));
 }catch(error){checks.push({name:error.message,ok:false});}
 finally{flow.stop();dialog()?.remove();randomSkipLike=false;history.replaceState(null,'','/home');event.target.disabled=false;}
 result.dataset.result=checks.every(c=>c.ok)?'passed':'failed';result.textContent=JSON.stringify({fixture:true,checks},null,2);
};


// Real 10-second browser timer; only native fixture counters are touched.
document.querySelector('#timed-run').onclick=async event=>{
 event.target.disabled=true;const result=document.querySelector('#timed-result'),checks=[];
 const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 result.dataset.result='running';
 try {
  const current=await reset();
  check('配置默认关闭，不会自行开始',document.querySelector('.xrc-timed-replies button').disabled&&current.events.length===0);
  timedSettingChanged({timedReplies:{newValue:{enabled:true,minSeconds:10,maxSeconds:10,maxAttempts:1,maxMinutes:1}}},'local');
  await wait(()=>!document.querySelector('.xrc-timed-replies button').disabled);
  const height=document.querySelector('.xrc-timed-replies').getBoundingClientRect().height;
  const start=performance.now();document.querySelector('.xrc-timed-replies button').click();
  await wait(()=>document.querySelector('.xrc-timed-replies span').textContent.includes('等待10秒'));
  check('手动开始仅计时，控件行高固定',current.events.length===0&&document.querySelector('.xrc-timed-replies').getBoundingClientRect().height===height);
  await wait(()=>dialog()?.dataset.target==='200',16000);
  const sends=current.events.filter(e=>e.kind==='send');
  check('实际等待至少10秒才复用评论点赞流程，并只触发一次',sends.length===1&&sends[0].at-start>=9900&&current.replied.has('100')&&current.liked.has('100'));
  check('达到次数停止，下一条仍为空，不自动生成草稿',document.querySelector('.xrc-timed-replies span').textContent.includes('次数上限')&&editor().innerText==='');
  await reset();document.querySelector('.xrc-timed-replies button').click();editor().textContent='手动修改的草稿';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));schedule();
  await wait(()=>document.querySelector('.xrc-timed-replies span').textContent.includes('草稿或回复状态变化'));
  check('倒计时中草稿变化停止，不发送新内容',run.events.length===0&&editor().innerText==='手动修改的草稿');
 }catch(error){checks.push({name:error.message,ok:false});}
 finally{timed.stop();flow.stop();dialog()?.remove();timedSettingChanged({timedReplies:{newValue:{enabled:false}}},'local');history.replaceState(null,'','/home');event.target.disabled=false;}
 result.dataset.result=checks.every(c=>c.ok)?'passed':'failed';result.textContent=JSON.stringify({fixture:true,checks},null,2);
};


document.querySelector('#timed-stop-run').onclick=async event=>{
 const result=document.querySelector('#timed-stop-result'),checks=[];event.target.disabled=true;result.dataset.result='running';
 const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 try{
  const current=await reset({replyDelay:400});
  timedSettingChanged({timedReplies:{newValue:{enabled:true,minSeconds:5,maxSeconds:5,maxAttempts:3,maxMinutes:1}}},'local');
  await wait(()=>!document.querySelector('.xrc-timed-replies button').disabled);
  document.querySelector('.xrc-timed-replies button').click();
  await wait(()=>current.events.some(item=>item.kind==='send'),8000);
  const stop=document.querySelector('.xrc-timed-badge button');
  check('发送过程中固定标记仍显示且暂停按钮可用',!stop.disabled&&document.querySelector('.xrc-timed-badge').dataset.state==='running');
  stop.click();await sleep(1300);
  check('手动暂停取消本条后续点赞/下一条，已发回复仍保存',current.replied.has('100')&&current.events.filter(item=>item.kind==='send').length===1&&!current.events.some(item=>item.kind==='like')&&!dialog());
  check('回复框关闭后标明已暂停，当前结果需核对不能直接继续',document.querySelector('.xrc-timed-badge').dataset.state==='paused'&&document.querySelector('.xrc-timed-badge button').disabled);
  document.querySelector('.xrc-flow-notice button').click();
  await wait(()=>dialog()?.dataset.target==='200');
  check('手动进入下一条保留原进度，不自行恢复',timed.isPaused()&&document.querySelector('.xrc-timed-replies span').textContent.includes('1/3')&&document.querySelector('.xrc-timed-replies button').textContent==='继续本轮');
  editor().textContent='暂停后新草稿';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));await sleep(80);
  const continuedAt=performance.now();document.querySelector('.xrc-timed-replies button').click();await sleep(250);
  check('继续后不立即发送，重新等待完整间隔',current.events.filter(item=>item.kind==='send').length===1);
  await wait(()=>current.events.filter(item=>item.kind==='send').length===2,7000);
  const sends=current.events.filter(item=>item.kind==='send');
  check('下一次只发新对象，继续次数为2/3且不补点旧对象',sends[1].id==='200'&&sends[1].at-continuedAt>=4900&&document.querySelector('.xrc-timed-replies span').textContent.includes('2/3')&&!current.events.some(item=>item.kind==='like'&&item.id==='100'));
  timed.pause();
  const selecting=await reset({liked:true});
  timedSettingChanged({timedReplies:{newValue:{enabled:true,minSeconds:3,maxSeconds:3,maxAttempts:3,maxMinutes:1}}},'local');
  let resolveNext;
  holdNext=()=>new Promise(resolve=>{resolveNext=resolve;});
  timed.start();await wait(()=>resolveNext,7000);
  timed.pause();holdNext=null;resolveNext();await sleep(120);
  check('暂停后迟到的查找结果不滚动或打开下一条',timed.isPaused()&&!dialog()&&selecting.events.filter(item=>item.kind==='send').length===1);
  const media=await reset();
  timed.start();
  const poll=document.createElement('div');poll.dataset.testid='pollOption_1';dialog().append(poll);
  schedule();await wait(()=>document.querySelector('.xrc-timed-badge').dataset.state==='stopped');
  check('倒计时中新增投票会取消定时发送',media.events.length===0&&dialog().contains(poll));
 }catch(error){checks.push({name:error.message,ok:false});}
 finally{holdNext=null;timed.stop();flow.stop();event.target.disabled=false;}
 result.dataset.result=checks.every(item=>item.ok)?'passed':'failed';result.textContent=JSON.stringify({fixture:true,checks},null,2);
};


// Controlled local visibility inputs; no real account requests or window activation.
document.querySelector('#visible-run').onclick=async event=>{
 const output=document.querySelector('#visible-result'),checks=[];
 const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 const focusDescriptor=Object.getOwnPropertyDescriptor(document,'hasFocus');
 const hiddenDescriptor=Object.getOwnPropertyDescriptor(document,'hidden');
 let hidden=false;event.target.disabled=true;output.dataset.result='running';
 try{
  const current=await reset();
  Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
  timedSettingChanged({timedReplies:{newValue:{enabled:true,allowVisibleUnfocused:true,minSeconds:3,maxSeconds:3,maxAttempts:3,maxMinutes:1}}},'local');
  await wait(()=>!document.querySelector('.xrc-timed-replies button').disabled);
  document.querySelector('.xrc-timed-replies button').click();window.dispatchEvent(new Event('blur'));
  check('开启后可见失焦仍保持运行',!timed.isPaused()&&document.querySelector('.xrc-timed-badge').dataset.state==='running');
  await wait(()=>dialog()?.dataset.target==='200',7000);
  check('失焦下评论、点赞和下一条按原回执保存，不多发',current.replied.has('100')&&current.liked.has('100')&&current.events.filter(item=>item.kind==='send').length===1);
  hidden=true;document.dispatchEvent(new Event('visibilitychange'));
  check('隐藏立即暂停，不能因开关开启而继续',timed.isPaused()&&!timed.pageAllowed());
  hidden=false;document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));await sleep(100);
  check('重新可见不自动恢复',timed.isPaused()&&current.events.filter(item=>item.kind==='send').length===1);
  guard.show({account:'me',operation:'CreateTweet',httpStatus:429});
  check('限流仍终止本轮并禁用继续',guard.blocked()&&!timed.isPaused());
 }catch(error){checks.push({name:error.message,ok:false});}
 finally{
  timed.stop();flow.stop();dialog()?.remove();
  if(focusDescriptor)Object.defineProperty(document,'hasFocus',focusDescriptor);else delete document.hasFocus;
  if(hiddenDescriptor)Object.defineProperty(document,'hidden',hiddenDescriptor);else delete document.hidden;
  document.querySelector('.xrc-interaction-alert button')?.click();
  timedSettingChanged({timedReplies:{newValue:{enabled:false}}},'local');event.target.disabled=false;
 }
 output.dataset.result=checks.every(item=>item.ok)?'passed':'failed';output.textContent=JSON.stringify({fixture:true,checks},null,2);
};
