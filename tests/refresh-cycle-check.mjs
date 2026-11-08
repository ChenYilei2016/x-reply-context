// Real page reloads on localhost; simulated X receipts, production cycle controller/background marker code.
export function installRefreshCycleCheck() {
 const output=document.querySelector('#refresh-cycle-status');
 const KEY='demoRefreshCheck';
 const wait=async predicate=>{const end=Date.now()+18000;while(!predicate()){
  if(Date.now()>end)throw Error('等待换批或续接超时');await new Promise(r=>setTimeout(r,25));
 }};
 const results=JSON.parse(sessionStorage.getItem(KEY)||'{"stage":0,"checks":[]}');
 const check=(name,ok)=>{results.checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
 const save=()=>sessionStorage.setItem(KEY,JSON.stringify(results));
 const finish=async error=>{
  if(error)results.checks.push({name:error.message,ok:false});
  await chrome.storage.local.set({replyRefreshCycle:{enabled:false,min:10,max:20}});
  sessionStorage.removeItem(KEY);sessionStorage.removeItem('demoRefreshSettings');
  output.dataset.result=results.checks.every(r=>r.ok)?'passed':'failed';output.textContent=JSON.stringify(results.checks,null,2);
  document.querySelector('#check-refresh-cycle').disabled=false;
 };
 const editor=()=>document.querySelector('.demo-composer [contenteditable]');
 const run=async()=>{
  output.dataset.result='running';document.querySelector('#check-refresh-cycle').disabled=true;
  try {
   if(results.stage===0) {
    if(location.pathname!=='/home')throw Error('从新的主页演示页开始');
    document.querySelector('[data-demo-id="2112500000000050001"] [data-testid="reply"]').click();
    await wait(()=>document.querySelector('.xrc-cycle-enabled') && !document.querySelector('.xrc-cycle-enabled').disabled);
    check('默认关闭，区间为10～20且放在底部固定行',!document.querySelector('.xrc-cycle-enabled').checked &&
     document.querySelector('.xrc-cycle-min').value==='10' && document.querySelector('.xrc-cycle-max').value==='20' &&
     document.querySelector('.xrc-refresh-cycle').nextElementSibling?.classList.contains('xrc-timed-replies'));
    const height=document.querySelector('.xrc-refresh-cycle').getBoundingClientRect().height;
    document.querySelector('.xrc-cycle-min').value='1';document.querySelector('.xrc-cycle-max').value='1';
    document.querySelector('.xrc-cycle-enabled').click();
    await wait(()=>document.querySelector('.xrc-cycle-progress')?.textContent==='换批 0/1' && !document.querySelector('.xrc-cycle-enabled').disabled);
    check('修改区间并开启，配置行高度不变',document.querySelector('.xrc-refresh-cycle').getBoundingClientRect().height===height);
    editor().textContent='本地换批测试，未连接X';editor().dispatchEvent(new InputEvent('input',{bubbles:true}));
    await wait(()=>!document.querySelector('.xrc-flow-send').disabled);
    results.stage=1;save();document.querySelector('.xrc-flow-send').click();
   } else if(results.stage===1) {
    await wait(()=>document.querySelector('.xrc-flow-profile')?.getAttribute('href')==='https://x.com/carol' && document.querySelector('.xrc-cycle-progress')?.textContent==='换批 0/1');
    check('消息来源仍是旧评论地址时，为你推荐到数仍刷新并只打开一条',document.querySelector('.demo-composer').dataset.targetId==='2112500000000050001' && document.querySelector('.xrc-flow-status').textContent.includes('为你推荐'));
    check('续接标记一次消费，新回复仍需人工发送',!sessionStorage.getItem('demoSession:replyRefreshResume:1') && document.querySelector('#composer-evidence').dataset.requests==='0' && editor().innerText==='');
    check('来源草稿不会传到刷新后的帖子',document.querySelector('.demo-composer [contenteditable]').innerText==='');
    document.querySelector('.demo-composer [data-testid="app-bar-close"]').click();
    results.stage=2;save();location.assign('/home');
   } else {
    await wait(()=>output.dataset.taken==='true');
    await new Promise(r=>setTimeout(r,500));
    check('再次手动刷新没有标记，不续开也不循环刷新',!document.querySelector('.demo-composer') && !sessionStorage.getItem('demoSession:replyRefreshResume:1'));
    await finish();
   }
  }catch(error){await finish(error);}
 };
 document.querySelector('#check-refresh-cycle').addEventListener('click',run);
 if(results.stage>0)void run();
}
