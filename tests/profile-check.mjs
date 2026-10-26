// Local-only native controls and receipts. Never calls public X endpoints.
export async function checkProfile() {
  const output=document.querySelector('#profile-status'),results=[];
  const check=(name,ok)=>{results.push({name,ok:Boolean(ok)});if(!ok)throw new Error(name);};
  const wait=async condition=>{
    const until=Date.now()+5000;
    while(!condition()) {if(Date.now()>until)throw new Error('等待个人主页回复超时');await new Promise(r=>setTimeout(r,25));}
  };
  const dialog=()=>document.querySelector('.demo-composer');
  const evidence=()=>document.querySelector('#composer-evidence').dataset;
  const record=id=>JSON.parse(evidence().homeRecords||'[]').find(row=>row.id===id);
  const reply=id=>document.querySelector(`[data-demo-id="${id}"] [data-testid="reply"]`).click();
  const close=()=>dialog()?.querySelector('[data-testid="app-bar-close"]').click();
  const carol='2112500000000050001',bob='2112500000000050002';
  const tabs=Array.from(document.querySelectorAll('.tabs [role="tab"]'));
  const fill=text=>{const editor=dialog().querySelector('[contenteditable]');editor.textContent=text;editor.dispatchEvent(new InputEvent('input',{bubbles:true}));};
  output.dataset.result='running';
  try {
    if(location.pathname!=='/carol')throw new Error('从 /carol 本地页开始');
    reply(carol);
    await wait(()=>document.querySelector('.xrc-flow-profile')?.href==='https://x.com/carol');
    check('帖子入口复用快捷短语、AI、红心和连续按钮',
      dialog().querySelectorAll('.xrc-quick-reply').length===6 && dialog().querySelector('.xrc-ai-recommend') &&
      dialog().querySelector('.xrc-flow-heart') && dialog().querySelector('.xrc-flow-send'));
    const query=Element.prototype.querySelectorAll;let scans=0;
    Element.prototype.querySelectorAll=function(selector){if(selector==='article[data-testid="tweet"]')scans++;return Reflect.apply(query,this,[selector]);};
    try {for(let i=0;i<100;i++)fill('保留草稿');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}
    finally{Element.prototype.querySelectorAll=query;}
    check('输入100次不扫描整个帖子列表',scans===0);
    document.querySelector('.xrc-flow-skip').click();
    await wait(()=>dialog()?.dataset.targetId===bob && document.querySelector('.xrc-flow-profile')?.href==='https://x.com/bob');
    check('跳过保留完整草稿，不发送',JSON.parse(evidence().drafts).some(row=>row.id===carol && row.text==='保留草稿') && evidence().requests==='0');
    check('下一条只选当前卡片，主页链接按实际作者',!record(carol)?.evidenceId);
    fill('本地个人主页评论');
    await wait(()=>!document.querySelector('.xrc-flow-send')?.disabled);
    document.querySelector('.xrc-flow-send').click();
    await wait(()=>evidence().sent==='1' && record(bob)?.evidenceId && dialog()?.dataset.targetId==='2112500000000000009');
    check('回复成功保存一次，下一条略过自己和已回帖子',record(bob).personStats.myCommentedPosts===1 &&
      Object.values(JSON.parse(evidence().replyWrites)).every(n=>n===1));
    close();tabs[1].click();reply(bob);
    await wait(()=>document.querySelector('.xrc-flow-status')?.textContent.includes('个人主页'));
    check('回复页签也接入原工具栏',Boolean(document.querySelector('.xrc-flow-send')));
    tabs[0].click();
    await wait(()=>!document.querySelector('.xrc-continuous'));
    check('切换个人主页页签停止旧会话，保留原生回复框',Boolean(dialog()));
    close();tabs[0].click();reply(bob);
    await wait(()=>document.querySelector('.xrc-continuous'));
    // Owner changes while compose route stays the same; no cross-profile continuation.
    tabs[0].setAttribute('href','/alice');tabs[1].setAttribute('href','/alice/with_replies');
    await wait(()=>!document.querySelector('.xrc-continuous'));
    check('背景换成另一个人主页时立即停用旧会话',Boolean(dialog()));
    close();tabs[0].setAttribute('href','/carol');tabs[1].setAttribute('href','/carol/with_replies');
    tabs[2].click();reply(bob);
    await new Promise(r=>setTimeout(r,150));
    check('未支持的媒体入口不错误开启连续回复',!document.querySelector('.xrc-continuous'));
  } catch(error){results.push({name:error.message,ok:false});}
  finally{close();}
  output.dataset.result=results.every(r=>r.ok)?'passed':'failed';
  output.textContent=JSON.stringify(results,null,2);
}
