// Only the window operation is simulated. Uses production notification/composer controls.
export async function checkCompanion() {
  const output=document.querySelector('#companion-evidence'),results=[];
  const wait=async condition=>{const until=Date.now()+4000;while(!condition()){
    if(Date.now()>until)throw Error('等待伴随入口超时');await new Promise(r=>setTimeout(r,20));
  }};
  const check=(name,ok)=>{results.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
  const rects=()=>Array.from(document.querySelectorAll('#timeline article')).map(a=>[a.dataset.demoId,a.getBoundingClientRect().top,a.getBoundingClientRect().height]);
  output.dataset.result='running';
  try {
    if(location.pathname!=='/notifications')throw Error('从新的通知演示页开始');
    document.querySelector('[data-demo-id="2112500000000000005"] [data-testid="reply"]')?.click();
    // Fixture notifications use index 11,3,7,4,8,10; Bob's incoming reply is index 4.
    await wait(()=>document.querySelector('.xrc-flow-profile')?.getAttribute('href'));
    const dialog=document.querySelector('.demo-composer'),editor=dialog.querySelector('[contenteditable]');
    const draft='未发送的通知草稿：保持原样\n第二行也保留。';
    editor.textContent=draft;editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const before=JSON.stringify(rects()),target=dialog.dataset.targetId;
    const link=dialog.querySelector('.xrc-flow-profile');
    for(let i=0;i<20;i++)link.click();
    await wait(()=>!link.hasAttribute('aria-busy'));
    check('快速点击20次合并成一次伴随窗口请求',output.dataset.calls==='1');
    check('通知非空多行草稿保持不变',editor.innerText===draft);
    check('通知回复对象和原生编辑器节点保持不变',dialog.dataset.targetId===target && editor===dialog.querySelector('[contenteditable]'));
    check('背景通知卡片位置和高度保持不变',JSON.stringify(rects())===before);
    const evidence=document.querySelector('#composer-evidence').dataset;
    check('没有发送、点赞或保存为已回复',evidence.requests==='0' && evidence.heartRequests==='0');
    link.click();await wait(()=>!link.hasAttribute('aria-busy'));
    check('再次唤起仍保留草稿与位置',output.dataset.calls==='2' && editor.innerText===draft && JSON.stringify(rects())===before);
  } catch(error){results.push({name:error.message,ok:false});}
  output.dataset.result=results.every(r=>r.ok)?'passed':'failed';
  output.textContent=JSON.stringify(results,null,2);
}
