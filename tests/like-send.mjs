history.replaceState(null,'','/home');
let flow,frame,run,sequence=0,account='me';
const output=document.querySelector('#result');
const schedule=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;flow.refresh();});};
const dialog=()=>document.querySelector('.dialog');
const editor=()=>dialog()?.querySelector('[contenteditable]');
const wait=async(predicate,timeout=4000)=>{const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('等待组合流程超时');await new Promise(r=>setTimeout(r,20));}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
flow=XReplyContinuous.create({accountHandle:()=>account,connected:()=>true,tweetId:a=>a.dataset.id,columnSelector:'main',requestRefresh:schedule,
 message:async m=>({ok:true,rows:m.ids.map(id=>({id,origin:'others',status:'not-reply',authorHandle:'peer',evidenceId:run.replied.has(id)?'saved':'',likeEvidenceId:run.liked.has(id)?id:''}))}),renderLabels:(node)=>{node.textContent='本地数据';}});
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
   const saved=Promise.resolve().then(()=>{current.replied.add(target);current.events.push({kind:'reply-saved',id:target,at:performance.now()});});
   modal.remove();history.replaceState(null,'','/home');schedule();
   void flow.receiveReply({type:'REPLY_RESULT',account:'me',parentId:target,startedAt,requestId,status:'sent',batch:{users:[{id:'1',handle:'me'}],tweets:[{id:'999',authorId:'1',parentId:target}]}},saved);
  },30);
 };
 document.body.append(modal);history.replaceState(null,'','/compose/post');editor().focus();schedule();
}
async function reset(options={}){
 flow.stop();dialog()?.remove();account='me';history.replaceState(null,'','/home');
 const current=run={events:[],liked:new Set(options.liked?['100']:[]),replied:new Set(),mode:options.mode||'success',saveDelay:options.saveDelay||0};
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
 try{
  let current=await reset({saveDelay:160});
  const skip=document.querySelector('.xrc-flow-skip'),primary=document.querySelector('.xrc-flow-send');
  check('保留原来同一行紧凑布局',skip.parentElement===primary.parentElement&&Math.abs(skip.getBoundingClientRect().top-primary.getBoundingClientRect().top)<1&&primary.getBoundingClientRect().width<150);
  send();send();await wait(()=>dialog()?.dataset.target==='200');
  const actions=current.events,like=actions.find(e=>e.kind==='like-saved'),sent=actions.find(e=>e.kind==='send');
  check('先点赞成功保存，再至少等待200ms发送，连点不重复',actions.filter(e=>e.kind==='like').length===1&&actions.filter(e=>e.kind==='send').length===1&&sent.at-like.at>=190&&current.replied.has('100'));
  current=await reset({liked:true});send();await wait(()=>dialog()?.dataset.target==='200');
  check('已点过不再点击红心，更不取消点赞',current.events.every(e=>e.kind!=='like')&&current.events.filter(e=>e.kind==='send').length===1);
  current=await reset();send();await wait(()=>document.querySelector('.xrc-flow-send')?.textContent==='等待发送…');
  editor().textContent='我改了内容';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));await sleep(600);
  check('延迟期间编辑立即取消发送并保留新草稿',!current.events.some(e=>e.kind==='send')&&editor().innerText==='我改了内容');
  current=await reset();send();dialog().querySelector('[data-testid=app-bar-close]').click();await sleep(700);
  check('关闭回复框后晚到点赞成功不发送',!current.events.some(e=>e.kind==='send')&&!dialog());
  current=await reset();send();await wait(()=>document.querySelector('.xrc-flow-send')?.textContent==='等待发送…');account='other';schedule();await sleep(600);
  check('切换账号停止后续发送',!current.events.some(e=>e.kind==='send'));
  current=await reset({saveDelay:1000});send();await sleep(100);
  await flow.receiveLike({account:'me',requestStartedAt:0,batch:{likes:[{id:'100',liked:true,source:'mutation'}]}},Promise.resolve());await sleep(550);
  check('旧请求回执不能抢在本次点赞保存前发送',!current.events.some(e=>e.kind==='send'));dialog().querySelector('[data-testid=app-bar-close]').click();
  current=await reset({saveDelay:700});send();await sleep(100);
  editor().textContent='再次确认的内容';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));send();await sleep(450);
  check('取消后再点不把尚未保存的红心当作已确认',!current.events.some(e=>e.kind==='send')&&current.events.filter(e=>e.kind==='like').length===1);
  await wait(()=>current.events.some(e=>e.kind==='like-saved'));await sleep(40);send();await wait(()=>dialog()?.dataset.target==='200');
  check('上一笔点赞确认后可继续且不重复点红心',current.events.filter(e=>e.kind==='like').length===1&&current.events.filter(e=>e.kind==='send').length===1);
  current=await reset({mode:'save-failed'});send();await wait(()=>document.querySelector('.xrc-flow-status')?.textContent.includes('记录未保存'));
  check('点赞保存失败暂停，原文保留',!current.events.some(e=>e.kind==='send')&&editor().innerText==='只用于本地检查');
  current=await reset({mode:'failed'});send();await wait(()=>document.querySelector('.xrc-flow-status')?.textContent.includes('点赞结果未确认'),11500);
  check('点赞失败／无回执超时不发送，也不自动重试',current.events.filter(e=>e.kind==='like').length===1&&!current.events.some(e=>e.kind==='send')&&editor().innerText==='只用于本地检查');
  current=await reset();editor().textContent='';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('.xrc-flow-skip').click();await wait(()=>dialog()?.dataset.target==='200');
  check('跳过仍不点赞或发送',current.events.length===0);
 }catch(error){checks.push({name:error.message,ok:false});}
 finally{flow.stop();dialog()?.remove();history.replaceState(null,'','/home');event.target.disabled=false;}
 output.dataset.result=checks.every(c=>c.ok)?'passed':'failed';output.textContent=JSON.stringify({fixture:true,checks},null,2);
};
