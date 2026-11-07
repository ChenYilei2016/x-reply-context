// Local-only regression using the production footer renderer and classification flow.
export async function checkPeopleFooter() {
 const output=document.querySelector('#people-footer-status'),results=[];
 const wait=async fn=>{const until=Date.now()+5000;while(!fn()){
  if(Date.now()>until)throw Error('等待互动统计超时');await new Promise(r=>setTimeout(r,25));
 }};
 const check=(name,ok)=>{results.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 const footer=()=>document.querySelector('.xrc-flow-people');
 const mode=document.querySelector('#context-result-mode');
 const change=value=>{mode.value=value;mode.dispatchEvent(new Event('change',{bubbles:true}));};
 const open=id=>document.querySelector(`[data-demo-id="${id}"] [data-testid="reply"]`).click();
 const close=()=>document.querySelector('.demo-composer [data-testid="app-bar-close"]')?.click();
 const notification=location.pathname==='/notifications';
 const alice=notification?'2112500000000000004':'2112500000000000006';
 output.dataset.result='running';
 try {
  change('delayed');open(alice);await wait(()=>footer());
  const height=footer().getBoundingClientRect().height;
  check('首次占位为待确认，位于底部配置行之前',footer().textContent==='我评他 待确认他评我 待确认' && (!footer().nextElementSibling || footer().nextElementSibling.classList.contains('xrc-refresh-cycle')));
  await wait(()=>footer().textContent==='我评他 1他评我 2');
  check('已有数据按两人各自评论对方原帖数显示，异步返回不增高',footer().getBoundingClientRect().height===height && height>0);
  check('回复框只显示一组计数，通知列表计数保留',document.querySelectorAll('.xrc-continuous .xrc-person').length===2 &&
    (!notification || document.querySelector('[data-demo-id="'+alice+'"] .xrc-person')));
  let writes=0,scans=0;const query=Element.prototype.querySelectorAll;
  const observer=new MutationObserver(records=>{writes+=records.length;});observer.observe(footer(),{childList:true,subtree:true,attributes:true,characterData:true});
  Element.prototype.querySelectorAll=function(selector){if(selector==='article[data-testid="tweet"]')scans++;return Reflect.apply(query,this,[selector]);};
  try {
   const editor=document.querySelector('.demo-composer [contenteditable]');
   for(let i=0;i<100;i++)editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  }finally{observer.disconnect();Element.prototype.querySelectorAll=query;}
  check('输入100次不重写计数、不扫描整页帖子',writes===0 && scans===0);
  change('missing-person');await wait(()=>footer().textContent==='我评他 待确认他评我 待确认');
  check('缺少互动数据不会显示0且保持高度',footer().getBoundingClientRect().height===height);
  change('normal');await wait(()=>footer().textContent==='我评他 1他评我 2');
  document.querySelector('.xrc-flow-skip').click();
  await wait(()=>document.querySelector('.xrc-flow-profile')?.getAttribute('href')==='https://x.com/carol' && footer()?.textContent==='我评他 0他评我 1');
  check('下一条绑定当前作者，不沿用上个人计数',(!footer().nextElementSibling || footer().nextElementSibling.classList.contains('xrc-refresh-cycle')));
  close();change('failed');open(alice);
  await wait(()=>document.querySelector('.xrc-flow-profile')?.title.includes('读取失败'));
  check('读取失败保留待确认占位，不阻塞跳过',footer().textContent==='我评他 待确认他评我 待确认' && footer().getBoundingClientRect().height===height && !document.querySelector('.xrc-flow-skip').disabled);
  check('统计展示不发送、不点赞',document.querySelector('#composer-evidence').dataset.requests==='0' && document.querySelector('#composer-evidence').dataset.heartRequests==='0');
 }catch(error){results.push({name:error.message,ok:false});}
 finally{close();change('normal');}
 output.dataset.result=results.every(row=>row.ok)?'passed':'failed';output.textContent=JSON.stringify(results,null,2);
}
