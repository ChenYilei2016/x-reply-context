// Production reply controls; all sends and receipts are local fixtures.
export async function checkSearch() {
  const output=document.querySelector('#search-status'),results=[];
  const wait=async fn=>{const until=Date.now()+4500;while(!fn()){
    if(Date.now()>until)throw Error('搜索回复工具栏或状态未出现');await new Promise(r=>setTimeout(r,25));
  }};
  const check=(name,ok)=>{results.push({name,ok:Boolean(ok)});if(!ok)throw Error(name);};
  const dialog=()=>document.querySelector('.demo-composer');
  const close=()=>dialog()?.querySelector('[data-testid="app-bar-close"]').click();
  const reply=id=>document.querySelector(`[data-demo-id="${id}"] [data-testid="reply"]`).click();
  const fill=text=>{const editor=dialog().querySelector('[contenteditable]');editor.textContent=text;editor.dispatchEvent(new InputEvent('input',{bubbles:true}));};
  const evidence=()=>document.querySelector('#composer-evidence').dataset;
  const record=id=>JSON.parse(evidence().homeRecords||'[]').find(r=>r.id===id);
  const carol='2112500000000050001',bob='2112500000000050002';
  const tabs=Array.from(document.querySelectorAll('.tabs [role="tab"]'));
  const hashtag=location.pathname.startsWith('/hashtag/');
  const changeQuery=changed=>tabs.forEach(tab=>{
    const url=new URL(tab.href);
    if(hashtag)url.pathname='/hashtag/'+(changed?'另一个标签':'浇朋友');
    else url.searchParams.set('q',changed?'changed':'test');
    tab.href=url.pathname+url.search;
  });
  output.dataset.result='running';
  try {
    if(location.pathname!=='/search' && !hashtag)throw Error('从新的搜索演示页开始');
    reply(carol);
    await wait(()=>dialog()?.querySelector('.xrc-flow-profile')?.href==='https://x.com/carol');
    check('热门搜索的小评论按钮复用六组短语、AI、点赞、跳过与下一条',dialog().querySelectorAll('.xrc-quick-reply').length===6 && dialog().querySelector('.xrc-ai-recommend') && dialog().querySelector('.xrc-flow-send'));
    const rects=()=>Array.from(document.querySelectorAll('#timeline article')).map(a=>[a.getBoundingClientRect().top,a.getBoundingClientRect().height]);
    const before=JSON.stringify(rects()),query=Element.prototype.querySelectorAll;let scans=0;
    Element.prototype.querySelectorAll=function(selector){if(selector==='article[data-testid="tweet"]')scans++;return Reflect.apply(query,this,[selector]);};
    try {for(let i=0;i<100;i++)fill('搜索页保留草稿');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}
    finally{Element.prototype.querySelectorAll=query;}
    check('输入100次不扫描整页卡片、不改变背景位置',scans===0 && before===JSON.stringify(rects()));
    dialog().querySelector('.xrc-flow-skip').click();
    await wait(()=>dialog()?.dataset.targetId===bob && dialog().querySelector('.xrc-flow-send'));
    check('跳过保存草稿，不误记已回',JSON.parse(evidence().drafts).some(d=>d.id===carol && d.text==='搜索页保留草稿') && evidence().requests==='0');
    fill('本地搜索回复，仅模拟');await wait(()=>!dialog().querySelector('.xrc-flow-send').disabled);
    dialog().querySelector('.xrc-flow-send').click();
    await wait(()=>record(bob)?.evidenceId && dialog()?.dataset.targetId==='2112500000000000009' && dialog().querySelector('.xrc-flow-send'));
    check('成功回执入库一次，下一条排除自己与已回原帖',record(bob).personStats.myCommentedPosts===1 && Object.values(JSON.parse(evidence().replyWrites)).every(n=>n===1));
    close();reply(carol);await wait(()=>dialog()?.querySelector('.xrc-flow-send'));
    fill('搜索原帖先评论再点赞，仅模拟');await wait(()=>!dialog().querySelector('.xrc-flow-send').disabled);
    dialog().querySelector('.xrc-flow-send').click();
    await wait(()=>record(carol)?.evidenceId && JSON.parse(evidence().likeRecords || '{}')['101:'+carol]?.liked && dialog()?.dataset.targetId==='2112500000000000009');
    check('观察器与后台链路保存先发评论及随后新点赞，记录只写一次',record(carol).personStats.myCommentedPosts===1 && Object.values(JSON.parse(evidence().replyWrites)).every(n=>n===1));
    close();tabs[1].click();reply(bob);
    await wait(()=>dialog()?.querySelector('.xrc-flow-status')?.textContent.includes('搜索'));
    check('最新页签可启动',Boolean(dialog().querySelector('.xrc-flow-send')));
    tabs[0].click();await wait(()=>!document.querySelector('.xrc-continuous'));
    check('切换搜索页签立即停止旧会话',Boolean(dialog()));
    close();tabs[0].click();reply(bob);await wait(()=>dialog()?.querySelector('.xrc-flow-send'));
    tabs.forEach(tab=>{const url=new URL(tab.href);url.searchParams.set('src','different_source');url.searchParams.sort();tab.setAttribute('href',url.pathname+url.search);});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    check('仅追踪来源或参数顺序变化不打断回复',Boolean(dialog().querySelector('.xrc-flow-send')));
    changeQuery(true);
    await wait(()=>!document.querySelector('.xrc-continuous'));
    check('compose路由下搜索词变化也停止旧会话',Boolean(dialog()));
    close();changeQuery(false);
    tabs[2].click();reply(bob);await new Promise(r=>setTimeout(r,150));
    check('用户搜索不误启动帖子连续回复',!document.querySelector('.xrc-continuous'));
  } catch(error){results.push({name:error.message,ok:false});}
  finally{close();}
  output.dataset.result=results.every(r=>r.ok)?'passed':'failed';output.textContent=JSON.stringify(results,null,2);
}
