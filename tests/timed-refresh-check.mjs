// Production content/refresh/timer modules with fake X receipts and real localhost page reloads.
export function installTimedRefreshCheck(){
 const KEY='demoTimedRefreshCheck',output=document.querySelector('#timed-refresh-status');
 const result=JSON.parse(sessionStorage.getItem(KEY)||'{"stage":0,"checks":[]}');
 const wait=async fn=>{const end=Date.now()+25000;while(!fn()){if(Date.now()>end)throw Error('跨刷新检查等待超时');await new Promise(r=>setTimeout(r,25));}};
 const check=(name,ok)=>{result.checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 const save=()=>sessionStorage.setItem(KEY,JSON.stringify(result));
 const editor=()=>document.querySelector('.demo-composer [contenteditable]');
 const fill=()=>{editor().textContent='本地模拟，不发送到X';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));};
 const done=async error=>{
  if(error)result.checks.push({name:error.message,ok:false});
  document.querySelector('.xrc-timed-badge button')?.click();
  await chrome.storage.local.set({timedReplies:{enabled:false},replyRefreshCycle:{enabled:false,min:10,max:20}});
  for(const key of [KEY,'demoTimedRecords','demoTimedSnapshots','demoTimedSettings','demoRefreshSettings'])sessionStorage.removeItem(key);
  output.dataset.result=result.checks.every(item=>item.ok)?'passed':'failed';output.textContent=JSON.stringify(result.checks,null,2);
  document.querySelector('#check-timed-refresh').disabled=false;
 };
 const run=async()=>{
  output.dataset.result='running';document.querySelector('#check-timed-refresh').disabled=true;
  try{
   if(result.stage===0){
    if(location.pathname!=='/home')throw Error('请从新主页演示页开始');
    result.stage=1;save();
    await chrome.storage.local.set({timedReplies:{enabled:true,minSeconds:5,maxSeconds:5,maxAttempts:3,maxMinutes:1},replyRefreshCycle:{enabled:true,min:1,max:1}});
    document.querySelector('[data-demo-id="2112500000000050001"] [data-testid="reply"]').click();
    await wait(()=>document.querySelector('.xrc-timed-replies button')&&!document.querySelector('.xrc-timed-replies button').disabled);
    fill();await wait(()=>!document.querySelector('.xrc-flow-send').disabled);
    document.querySelector('.xrc-timed-replies button').click();
    check('开始后存在独立固定运行标记和暂停按钮',document.querySelector('.xrc-timed-badge').dataset.state==='running'&&!document.querySelector('.xrc-timed-badge button').disabled);
    save();
   } else if(result.stage===1){
    await wait(()=>document.querySelector('.xrc-timed-badge')?.dataset.state==='running'&&document.querySelector('.xrc-timed-replies span')?.textContent.includes('1/3')&&editor());
    check('location.assign自动换批使用navigate类型',performance.getEntriesByType('navigation')[0]?.type==='navigate');
    check('刷新后恢复1/3进度，未自动发送空草稿',editor().innerText===''&&document.querySelector('#composer-evidence').dataset.requests==='0');
    check('本轮刷新标记已消费，不依赖反复分页',!sessionStorage.getItem('demoSession:replyRefreshResume:1'));
    result.stage=2;save();fill();
   } else if(result.stage===2){
    await wait(()=>document.querySelector('.xrc-timed-badge')?.dataset.state==='running'&&document.querySelector('.xrc-timed-replies span')?.textContent.includes('2/3')&&editor());
    const snapshots=JSON.parse(sessionStorage.getItem('demoTimedSnapshots')||'[]');
    check('跨两次刷新沿用同一runId和原截止时间，剩余时间递减',snapshots.length===2&&snapshots[0].runId===snapshots[1].runId&&snapshots[0].expiresAt===snapshots[1].expiresAt&&snapshots[1].remainingMs<snapshots[0].remainingMs&&snapshots[1].attempts===2);
    document.querySelector('.xrc-timed-badge button').click();
    await wait(()=>document.querySelector('.xrc-timed-badge')?.dataset.state==='paused');
    check('固定标记暂停可用，暂停后保留空草稿且不继续请求',editor().innerText===''&&document.querySelector('#composer-evidence').dataset.requests==='0');
    result.stage=3;save();location.assign('/home');
   }else{
    await wait(()=>document.querySelector('#refresh-cycle-status').dataset.taken==='true');
    await new Promise(r=>setTimeout(r,500));
    check('手动刷新没有续接票，不重新启动或打开回复框',!editor()&&document.querySelector('.xrc-timed-badge')?.dataset.state==='idle');
    await done();
   }
  }catch(error){await done(error);}
 };
 document.querySelector('#check-timed-refresh').addEventListener('click',run);
 if(result.stage>0)void run();
}
