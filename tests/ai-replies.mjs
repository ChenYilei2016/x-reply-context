history.replaceState(null,'','/notifications');
const output=document.querySelector('#result');
const listeners=[],calls=[],pending=new Map(),generations=new Map();
let enabled=true,autoComplete=false,modelError=false,totalRequests=0,ai,flow,frame,delay=1500,rewritten='改写后的短句',sent=0,likes=0;
const requestRefresh=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;flow?.refresh();ai?.refresh();});};
globalThis.chrome={storage:{onChanged:{addListener:fn=>listeners.push(fn)}}};
const accountHandle=()=> 'me';
const tweetId=article=>article.querySelector('time')?.closest('a')?.getAttribute('href').split('/').pop()||'';
const message=async message=>{
  if(message.type==='AI_STATUS')return {ok:true,enabled,autoComplete};
  if(message.type==='AI_CANCEL'){
    for(const id of message.ids){const job=pending.get(id);if(job){clearTimeout(job.timer);pending.delete(id);job.resolve({ok:false,cancelled:true});}}
    return {ok:true};
  }
  if(message.type==='AI_REQUEST'){
    calls.push(message);totalRequests++;
    return new Promise(resolve=>{
      const same=(generations.get(message.post)||0)+1; if(message.kind==='generate')generations.set(message.post,same);
      const text=message.kind==='rewrite'?rewritten:(message.post.includes('第二')?'第二条':'第一条')+['候选甲','候选乙','候选丙'][((same-1)%3)];
      const timer=setTimeout(()=>{pending.delete(message.id);resolve(modelError?{ok:false,error:"模拟模型失败"}:{ok:true,text});},delay);
      pending.set(message.id,{timer,resolve});
    });
  }
  if(message.type==='CLASSIFY'){return {ok:true,rows:message.ids.map(id=>({id,status:'unknown',origin:'others',authorHandle:id==='100'?'alice':'bob',rootId:id,rootText:'原帖'}))};}
  return {ok:true};
};
ai=XReplyAIReplies.create({accountHandle,connected:()=>true,message,requestRefresh});
flow=XReplyContinuous.create({accountHandle,tweetId,columnSelector:'[data-testid="primaryColumn"]',message,requestRefresh,aiBusy:editor=>ai.busy(editor),aiRecommend:editor=>ai.recommend(editor),aiPhase:editor=>ai.phase(editor),
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
    open(0);await wait(()=>document.querySelector('.xrc-ai-recommend'));
    await new Promise(resolve=>setTimeout(resolve,80));
    for(let i=0;i<100;i++)ai.refresh();
    check('默认关闭自动补全，打开和刷新均不请求模型',calls.length===0&&!document.querySelector('.xrc-ai-ghost'));
    const quickButtons=[...document.querySelectorAll('.xrc-quick-reply')];
    check('六组词句与快捷键均显示',quickButtons.length===6&&quickButtons.every((b,i)=>b.getAttribute('aria-keyshortcuts')==='Alt+'+(i+1)&&b.textContent.endsWith(String(i+1))));
    for(let i=0;i<6;i++) {
      await wait(()=>!quickButtons[i].disabled);
      const before=text();key(['¡','™','£','¢','∞','§'][i],{altKey:true,code:'Digit'+(i+1)});
      key('x',{altKey:true,code:'Digit'+(i+1),repeat:true});
      await wait(()=>text()!==before&&!quickButtons[i].disabled);
      const phrases=quickButtons[i].title.match(/^随机填入：(.*?)，末尾随机/)[1].split(' / ');
      const suffix=text().slice(before.length+(before?1:0));
      check('Option '+(i+1)+'只填入对应词句一次',phrases.some(p=>['...','!','!!!','!!'].some(end=>suffix===p+end)));
    }
    const quickText=text();
    editor().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));key('6',{altKey:true,code:'Digit6'});
    editor().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'6',code:'Digit6',altKey:true,bubbles:true,cancelable:true}));
    check('词句快捷键忽略输入法及框外，不请求模型',text()===quickText&&calls.length===0);
    closeUI();await wait(()=>!editor());open(0);await wait(()=>document.querySelector('.xrc-ai-recommend')&&!document.querySelector('.xrc-ai-recommend').disabled);
    editor().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    key('q',{altKey:true,code:'KeyQ'});
    editor().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'q',code:'KeyQ',altKey:true,bubbles:true,cancelable:true}));
    key('q',{altKey:true,ctrlKey:true,code:'KeyQ'});key('q',{altKey:true,code:'KeyQ',repeat:true});
    check('推荐快捷键忽略输入法、框外、额外修饰键和长按重复',calls.length===0);
    await wait(()=>!document.querySelector('.xrc-ai-recommend').disabled);
    delay=150;
    const aiButton=document.querySelector('.xrc-ai-recommend'),tools=document.querySelector('.xrc-reply-tools');
    const idleBox=aiButton.getBoundingClientRect(),idleHeight=tools.getBoundingClientRect().height;
    const prevented=!key('œ',{altKey:true,code:'KeyQ'});
    key('1',{altKey:true,code:'Digit1'});
    await wait(()=>aiButton.getAttribute('aria-busy')==='true');
    const busyBox=aiButton.getBoundingClientRect();
    check('AI生成中显示转圈文字且按钮位置行高不变',aiButton.textContent.includes('生成中')&&getComputedStyle(aiButton,'::before').visibility==='visible'&&idleBox.x===busyBox.x&&idleBox.y===busyBox.y&&idleBox.width===busyBox.width&&idleHeight===tools.getBoundingClientRect().height);
    key('œ',{altKey:true,code:'KeyQ',repeat:true});key('q',{altKey:true,code:'KeyQ'});
    await wait(()=>!ai.busy(editor()));
    await wait(()=>aiButton.getAttribute('aria-busy')==='false');
    check('生成结束恢复按钮且不残留忙碌状态',aiButton.textContent.includes('推荐评论'));
    check('Option Alt Q复用推荐操作且连按仅一条，不发送',prevented&&calls.length===1&&text()==='第一条候选甲'&&sent===0);
    closeUI();await wait(()=>!editor());calls.length=0;open(0);
    await wait(()=>document.querySelector('.xrc-ai-recommend'));
    const recommend=async()=>{await wait(()=>!document.querySelector('.xrc-ai-recommend').disabled);document.querySelector('.xrc-ai-recommend').click();};
    delay=100;await recommend();document.querySelector('.xrc-ai-recommend').click();await wait(()=>!ai.busy(editor()));
    check('点击推荐只请求一条并填入一次，连点不重复',calls.length===1&&text()==='第一条候选甲');
    await recommend();await wait(()=>!ai.busy(editor()));
    check('推荐追加已有草稿，不替换原文（实际：'+text()+'）',text()==='第一条候选甲 第一条候选乙');
    delay=300;await recommend();await input(' 新内容');const kept=text();await wait(()=>!ai.busy(editor()));
    check('推荐等待期间的新草稿不被覆盖',text()===kept);
    modelError=true;await recommend();await wait(()=>!ai.busy(editor()));
    check('推荐失败不改变草稿，按钮恢复',text()===kept);
    modelError=false;delay=1000;await recommend();await wait(()=>pending.size===1);closeUI();await wait(()=>!editor());
    open(1);await new Promise(resolve=>setTimeout(resolve,100));
    check('关闭取消手动推荐，新对象不会自动请求或串写',pending.size===0&&text()===''&&!document.querySelector('.xrc-ai-ghost'));
    closeUI();await wait(()=>!editor());
    autoComplete=true;listeners.forEach(fn=>fn({aiAutoComplete:{newValue:true}},'local'));
    await new Promise(resolve=>setTimeout(resolve,30));calls.length=0;delay=30;
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
    await wait(()=>!ai.busy(editor()));check('Option Tab改写替换一次（实际：'+text()+'）',text()==='更短的回复');
    for(let i=0;i<10;i++) {
      const expected=text(),replacement='改写选区检查'+i;
      const replaced=await XReplyEditor.write(editor(),replacement,{replace:true,expected});
      if(!replaced||text()!==replacement)throw new Error('连续替换选区未同步：'+text());
    }
    check('连续10次替换保持Draft状态一致，不追加旧稿',true);
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
  output.dataset.result=checks.every(row=>row.ok)?'passed':'failed';output.dataset.evidence=JSON.stringify({fixture:true,cases:checks,modelRequests:totalRequests,sent,likes});
  output.textContent=JSON.stringify({checks,modelRequests:totalRequests,sent,likes},null,2);
});
