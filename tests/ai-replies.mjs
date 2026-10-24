history.replaceState(null,'','/notifications');
const output=document.querySelector('#result');
const listeners=[],calls=[],pending=new Map(),generations=new Map();
let enabled=true,ai,flow,frame,delay=30,rewritten='改写后的短句',sent=0,likes=0;
const requestRefresh=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;flow?.refresh();ai?.refresh();});};
globalThis.chrome={storage:{onChanged:{addListener:fn=>listeners.push(fn)}}};
const accountHandle=()=> 'me';
const tweetId=article=>article.querySelector('time')?.closest('a')?.getAttribute('href').split('/').pop()||'';
const message=async message=>{
  if(message.type==='AI_STATUS')return {ok:true,enabled};
  if(message.type==='AI_CANCEL'){
    for(const id of message.ids){const job=pending.get(id);if(job){clearTimeout(job.timer);pending.delete(id);job.resolve({ok:false,cancelled:true});}}
    return {ok:true};
  }
  if(message.type==='AI_REQUEST'){
    calls.push(message);
    return new Promise(resolve=>{
      const same=(generations.get(message.post)||0)+1; if(message.kind==='generate')generations.set(message.post,same);
      const text=message.kind==='rewrite'?rewritten:(message.post.includes('第二')?'第二条':'第一条')+['候选甲','候选乙','候选丙'][((same-1)%3)];
      const timer=setTimeout(()=>{pending.delete(message.id);resolve({ok:true,text});},delay);
      pending.set(message.id,{timer,resolve});
    });
  }
  if(message.type==='CLASSIFY')return {ok:true,rows:message.ids.map(id=>({id,status:'unknown',origin:'others',authorHandle:id==='100'?'alice':'bob',rootId:id,rootText:'原帖'}))};
  return {ok:true};
};
ai=XReplyAIReplies.create({accountHandle,connected:()=>true,message,requestRefresh});
flow=XReplyContinuous.create({accountHandle,tweetId,columnSelector:'[data-testid="primaryColumn"]',message,requestRefresh,aiBusy:editor=>ai.busy(editor),
  renderLabels:(node,row)=>{node.textContent=row.origin;}});
function DraftEditor(){
  const [state,setState]=React.useState(()=>Draft.EditorState.createEmpty());
  return React.createElement(Draft.Editor,{editorState:state,onChange:setState,ariaLabel:'本地AI草稿'});
}
function close(){
  const mount=document.querySelector('#editor-mount');
  if(mount)ReactDOM.unmountComponentAtNode(mount);
  document.querySelector('.dialog')?.remove();history.replaceState(null,'','/notifications');requestRefresh();
}
for(const article of document.querySelectorAll('article')){
  article.querySelector('[data-testid=like]').addEventListener('click',()=>{likes++;});
  article.querySelector('[data-testid=reply]').addEventListener('click',()=>{
    if(document.querySelector('.dialog'))return;
    generations.set(article.querySelector('[data-testid=tweetText]').textContent,0);
    const dialog=document.createElement('div');dialog.className='dialog';dialog.setAttribute('role','dialog');
    dialog.innerHTML='<button data-testid="app-bar-close">关闭</button><div data-testid="tweetText"></div><div id="editor-mount"></div><div data-testid="toolBar"><button data-testid="tweetButton">发送（仅计数）</button></div>';
    dialog.querySelector('[data-testid=tweetText]').textContent=article.querySelector('[data-testid=tweetText]').textContent;
    dialog.querySelector('[data-testid=app-bar-close]').addEventListener('click',close);
    dialog.querySelector('[data-testid=tweetButton]').addEventListener('click',()=>sent++);
    document.body.append(dialog);history.replaceState(null,'','/compose/post');
    ReactDOM.render(React.createElement(DraftEditor),document.querySelector('#editor-mount'));
    const editor=document.querySelector('.public-DraftEditor-content');editor.dataset.testid='tweetTextarea_0';editor.focus();requestRefresh();
  });
}
const wait=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('AI 检查等待超时');await new Promise(resolve=>setTimeout(resolve,20));}};
const editor=()=>document.querySelector('[data-testid=tweetTextarea_0]');
const key=(value,extra={})=>editor().dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra}));
const open=index=>document.querySelectorAll('article [data-testid=reply]')[index].click();
const closeUI=()=>document.querySelector('[data-testid=app-bar-close]')?.click();
const text=()=>XReplyEditor.read(editor());
const input=async value=>XReplyEditor.write(editor(),value,{expected:text()});
output.textContent='就绪';
document.querySelector('#run').addEventListener('click',async event=>{
  event.target.disabled=true;const checks=[];
  const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw new Error(name);};
  output.dataset.result='running';
  try{
    open(0);await wait(()=>document.querySelector('.xrc-ai-ghost')?.textContent==='第一条候选甲'&&pending.size===0);
    check('空回复框初始三条候选，灰字不写入草稿',calls.length===3&&text()==='');
    const before=calls.length, refreshStart=performance.now();for(let i=0;i<100;i++)ai.refresh();
    output.dataset.refreshMs=String(performance.now()-refreshStart);
    check('重复刷新不重复请求',calls.length===before);
    key('ArrowDown');check('上下键切换候选',document.querySelector('.xrc-ai-ghost').textContent==='第一条候选乙');
    key('ArrowDown');await wait(()=>calls.length===4&&pending.size===0);
    check('切到末尾只补一条',calls.length===4);
    key('ArrowUp');key('Tab');await wait(()=>ai.busy(editor()) && document.querySelector('.xrc-flow-send').disabled && document.querySelector('.xrc-flow-skip').disabled);
    check('采用期间暂停连续发送与跳过',document.querySelector('.xrc-flow-send').disabled&&document.querySelector('.xrc-flow-skip').disabled);
    document.querySelector('[data-testid=tweetButton]').click();key('Enter',{metaKey:true});
    check('填入中原生发送也被保护',sent===0);
    await wait(()=>!ai.busy(editor()));check('Tab只采用当前候选且不重复',text()==='第一条候选乙');
    delay=150;rewritten='更短的回复';key('Tab',{altKey:true});await wait(()=>ai.busy(editor()));
    await wait(()=>!ai.busy(editor()));check('Option Tab改写替换一次',text()==='更短的回复');
    delay=300;key('Tab',{altKey:true});await wait(()=>ai.busy(editor()));
    await input(' 保留新输入');const manual=text();await wait(()=>!ai.busy(editor()));
    check('改写期间的新草稿不被覆盖',text()===manual);
    closeUI();await wait(()=>!editor());
    delay=1000;open(0);await wait(()=>pending.size===3);
    document.querySelector('.xrc-flow-skip').click();
    await wait(()=>editor()&&document.querySelector('.dialog [data-testid=tweetText]').textContent==='第二条原帖');
    await wait(()=>document.querySelector('.xrc-ai-ghost')?.textContent==='第二条候选甲');
    check('跳过取消旧候选并绑定新对象',[...pending.keys()].every(id=>calls.find(call=>call.id===id).post==='第二条原帖'));
    key('Tab');await wait(()=>ai.busy(editor()));closeUI();await wait(()=>!editor());
    delay=20;open(0);await wait(()=>document.querySelector('.xrc-ai-ghost')?.textContent==='第一条候选甲');
    await new Promise(resolve=>setTimeout(resolve,200));check('关闭时停止逐字填入，不写进新回复框',text()==='');
    const insertion=input('手动短句');key('Tab');await insertion;
    check('一次草稿写入中不并行采用AI候选',text()==='手动短句'&&!ai.busy(editor()));
    check('整个检查没有发送或点赞',sent===0&&likes===0);
    closeUI();await wait(()=>!editor());enabled=false;listeners.forEach(fn=>fn({aiConfig:{newValue:{enabled:false}}},'local'));await new Promise(resolve=>setTimeout(resolve,30));
    const count=calls.length;open(0);await new Promise(resolve=>setTimeout(resolve,120));
    check('关闭AI后没有模型请求或灰字',calls.length===count&&!document.querySelector('.xrc-ai-ghost'));
  }catch(error){checks.push({name:error.message,ok:false});}
  finally{closeUI();event.target.disabled=false;}
  output.dataset.result=checks.every(row=>row.ok)?'passed':'failed';output.dataset.evidence=JSON.stringify({fixture:true,cases:checks,modelRequests:calls.length,sent,likes});
  output.textContent=JSON.stringify({checks,modelRequests:calls.length,sent,likes},null,2);
});
