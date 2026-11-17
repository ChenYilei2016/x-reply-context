// Real production controls with fixture-only X requests, never a public send.
export async function checkFollowing() {
  const output = document.querySelector('#following-status');
  const results = [];
  const wait = async condition => {
    const until = Date.now()+4500;
    while (!condition()) {
      if (Date.now()>until) throw new Error('等待正在关注连续回复超时');
      await new Promise(resolve => setTimeout(resolve,25));
    }
  };
  const check = (name,ok) => { results.push({ name,ok:Boolean(ok) }); if (!ok) throw new Error(name); };
  const dialog = () => document.querySelector('.demo-composer');
  const current = () => dialog()?.dataset.targetId;
  const evidence = () => document.querySelector('#composer-evidence').dataset;
  const record = id => JSON.parse(evidence().homeRecords || '[]').find(row => row.id === id);
  const reply = id => document.querySelector(`[data-demo-id="${id}"] [data-testid="reply"]`).click();
  const fill = text => {
    const editor = dialog().querySelector('[data-testid="tweetTextarea_0"]');
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent('input',{ bubbles:true }));
  };
  const carol = '2112500000000050001';
  const bob = '2112500000000050002';
  const customTabs = [];
  output.dataset.result = 'running';
  try {
    if (location.pathname !== '/home') throw new Error('请从新的主页演示运行');
    await wait(() => document.querySelector('[data-demo-id="'+carol+'"]'));
    const tabs = document.querySelectorAll('.tabs [role="tab"]');
    const tablist=document.querySelector('.tabs');tablist.setAttribute('role','tablist');
    tabs[0].click();
    for (const label of ['科技','科学']) {
      const tab=document.createElement('div');tab.setAttribute('role','tab');tab.setAttribute('aria-selected','false');tab.textContent=label;
      tab.addEventListener('click',()=>tablist.querySelectorAll('[role="tab"]').forEach(item=>item.setAttribute('aria-selected',String(item===tab))));
      tablist.append(tab);customTabs.push(tab);
    }
    customTabs[0].click();reply(carol);
    await wait(()=>document.querySelector('.xrc-flow-status')?.textContent.includes('科技'));
    check('自定义科技标签复用快捷回复、AI推荐、点赞和下一条',
      dialog().querySelectorAll('.xrc-quick-reply').length===6 && dialog().querySelector('.xrc-ai-recommend') &&
      dialog().querySelector('.xrc-flow-heart') && dialog().querySelector('.xrc-flow-send'));
    document.querySelector('.xrc-flow-skip').click();
    await wait(()=>current()===bob && document.querySelector('.xrc-flow-status')?.textContent.includes('科技'));
    check('自定义标签从当前帖子向下跳过，不回到首条或其他标签',evidence().requests==='0');
    customTabs[1].click();
    await wait(()=>!document.querySelector('.xrc-continuous'));
    check('自定义标签互切立即结束旧会话，草稿框仍保留',Boolean(dialog()));
    dialog().querySelector('[data-testid="app-bar-close"]').click();
    customTabs[1].click();reply(carol);
    await wait(()=>document.querySelector('.xrc-flow-status')?.textContent.includes('科学'));
    customTabs[1].textContent='新人蓝朋友';
    await wait(()=>!document.querySelector('.xrc-continuous'));
    check('同一位置的标签身份被替换后，不误用旧会话',evidence().requests==='0');
    dialog().querySelector('[data-testid="app-bar-close"]').click();
    tabs[1].click(); reply(bob);
    await wait(() => document.querySelector('.xrc-flow-status')?.textContent.includes('正在关注'));
    check('正在关注入口显示完整连续操作',dialog().querySelector('.xrc-flow-heart') &&
      dialog().querySelector('.xrc-flow-skip') && dialog().querySelector('.xrc-flow-send'));
    await new Promise(resolve => setTimeout(resolve,350));
    const originalQuery = Element.prototype.querySelectorAll;
    let timelineScans = 0;
    Element.prototype.querySelectorAll = function(selector) {
      if (selector === 'article[data-testid="tweet"]') timelineScans++;
      return Reflect.apply(originalQuery,this,[selector]);
    };
    try {
      const editor = dialog().querySelector('[data-testid="tweetTextarea_0"]');
      for (let i=0;i<100;i++) editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } finally { Element.prototype.querySelectorAll = originalQuery; }
    output.dataset.performance = JSON.stringify({inputEvents:100,timelineScans});
    check('连续输入100次不重新扫描整页卡片',timelineScans === 0);
    await wait(() => dialog()?.querySelector('.xrc-flow-profile')?.getAttribute('href') === 'https://x.com/bob');
    check('正在关注显示当前作者主页，另开标签且不添加通知标签或摘要',
      dialog().querySelector('.xrc-flow-profile').target === '_blank' &&
      !dialog().querySelector('.xrc-labels,.xrc-flow-root'));
    const activeCard = document.querySelector(`[data-demo-id="${bob}"]`);
    const permalink = activeCard.querySelector('time').closest('a');
    const originalHref = permalink.getAttribute('href');
    permalink.setAttribute('href',`/carol/status/${carol}`);
    await wait(() => document.querySelector('.xrc-flow-heart').disabled);
    check('虚拟卡片换成其他帖子时不使用旧缓存误点赞',document.querySelector('.xrc-flow-heart').disabled);
    permalink.setAttribute('href',originalHref);
    await wait(() => !document.querySelector('.xrc-flow-heart').disabled);
    document.querySelector('.xrc-flow-heart').click();
    await wait(() => JSON.parse(evidence().likeRecords || '{}')['101:'+bob]?.liked === false);
    document.querySelector('.xrc-flow-skip').click();
    await wait(() => current() === carol && document.querySelector('.xrc-flow-send'));
    await wait(() => dialog()?.querySelector('.xrc-flow-profile')?.getAttribute('href') === 'https://x.com/carol');
    check('手动红心保存，跳过不误记评论，下一条仍属于正在关注',
      evidence().requests === '0' && !record(bob)?.evidenceId &&
      document.querySelector('.xrc-flow-status').textContent.includes('正在关注'));
    fill('正在关注普通评论，仅本地模拟');
    await wait(() => !document.querySelector('.xrc-flow-send')?.disabled);
    document.querySelector('.xrc-flow-send').click();
    await wait(() => evidence().sent === '1' && record(carol)?.evidenceId && current() === '2112500000000000009' &&
      document.querySelector('.xrc-flow-send'));
    check('普通评论成功后保存一次，我评他按原帖加1',record(carol).personStats.myCommentedPosts === 1 &&
      Object.values(JSON.parse(evidence().replyWrites)).every(count => count === 1));
    dialog().querySelector('[data-testid="app-bar-close"]').click();
    document.querySelector('#reply-result-mode').value = 'note';
    reply(bob);
    await wait(() => dialog()?.querySelector('.xrc-flow-send'));
    fill('正在关注长评论，仅本地模拟');
    await wait(() => !document.querySelector('.xrc-flow-send')?.disabled);
    document.querySelector('.xrc-flow-send').click();
    await wait(() => evidence().sent === '2' && record(bob)?.evidenceId && current() === '2112500000000000009' &&
      document.querySelector('.xrc-flow-send'));
    check('长评论也保存一次，未漏记另一篇原帖',record(bob).personStats.myCommentedPosts === 1 &&
      Object.values(JSON.parse(evidence().replyWrites)).every(count => count === 1));
    check('下一条略过自己和两篇已经评论的原帖',current() !== bob && current() !== carol &&
      current() !== '2112500000000000001');
    // A tab navigation must invalidate the session before its DOM and async candidates change.
    tabs[0].click();
    await wait(() => !document.querySelector('.xrc-continuous'));
    check('切换页签立即结束旧会话，不在另一列表续发',Boolean(dialog()) && evidence().sent === '2');
    dialog().querySelector('[data-testid="app-bar-close"]').click();
    tabs[0].click();
    reply(carol);
    await wait(() => document.querySelector('.xrc-flow-status')?.textContent.includes('为你推荐'));
    await wait(() => dialog()?.querySelector('.xrc-flow-profile')?.getAttribute('href') === 'https://x.com/carol');
    check('为你推荐入口与当前作者主页可正常启动',Boolean(document.querySelector('.xrc-flow-send')));
    dialog().querySelector('[data-testid="app-bar-close"]').click();
    tabs[1].click(); reply('2112500000000000009');
    await wait(() => document.querySelector('.xrc-flow-send'));
    document.querySelector('#reply-result-mode').value = 'delayed';
    fill('晚到回执，仅本地模拟');
    await wait(() => !document.querySelector('.xrc-flow-send')?.disabled);
    document.querySelector('.xrc-flow-send').click();
    await wait(() => evidence().requests === '3');
    tabs[0].click();
    await wait(() => evidence().sent === '3' && record('2112500000000000009')?.evidenceId);
    check('发送后切换页签，晚到回执仍保存且不续开另一列表',
      !document.querySelector('.xrc-continuous') && !dialog() &&
      Object.values(JSON.parse(evidence().replyWrites)).every(count => count === 1));
    tabs[0].click();
  } catch (error) { results.push({ name:error.message,ok:false }); }
  finally {
    document.querySelector('#reply-result-mode').value = 'success';
    dialog()?.querySelector('[data-testid="app-bar-close"]')?.click();
    customTabs.forEach(tab=>tab.remove());
  }
  output.dataset.result = results.every(row => row.ok) ? 'passed' : 'failed';
  output.dataset.evidence = JSON.stringify(results);
  output.textContent = `${results.filter(row => row.ok).length}/${results.length} 通过\n`+
    results.map(row => `${row.ok ? '✓' : '✗'} ${row.name}`).join('\n');
}
