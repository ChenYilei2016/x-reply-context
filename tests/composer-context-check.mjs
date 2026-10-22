// Browser regression through production controls; all writes stay inside the local fixture.
export async function checkComposerContext() {
  const output = document.querySelector("#composer-context-status");
  const results = [];
  const wait = async condition => {
    const until = Date.now()+4000;
    while (!condition()) {
      if (Date.now()>until) throw new Error("等待回复框信息超时");
      await new Promise(resolve => setTimeout(resolve,25));
    }
  };
  const check = (name,ok) => { results.push({ name,ok:Boolean(ok) }); if (!ok) throw new Error(name); };
  const context = () => document.querySelector('.xrc-flow-context');
  const profile = () => context()?.querySelector('.xrc-flow-profile');
  const card = id => document.querySelector(`[data-demo-id="${id}"]`);
  output.dataset.result = "running";
  try {
    const carol = card("2112500000000000013");
    await wait(() => carol?.querySelector('.xrc-labels'));
    const height = carol.getBoundingClientRect().height;
    carol.querySelector('[data-testid="reply"]').click();
    await wait(() => profile()?.getAttribute('href') === 'https://x.com/carol');
    const labelText = el => el.innerText.replace(/\s+/g,'');
    check("回复框标签与列表一致，含次数及NEW",labelText(context().querySelector('.xrc-labels')) ===
      labelText(carol.querySelector('.xrc-labels')) && context().querySelector('.xrc-new-person'));
    check("主页链接保留当前回复框",profile().target === '_blank' && profile().rel.includes('noopener'));
    const rowHeight = context().getBoundingClientRect().height;
    document.querySelector('#simulate').click();
    await wait(() => context()?.querySelector('.xrc-status')?.dataset.confirmed === 'true');
    document.querySelector('.xrc-flow-heart').click();
    await wait(() => context()?.querySelector('.xrc-heart')?.dataset.confirmed === 'true');
    check("文字与红心更新同步到回复框，固定行高",context().getBoundingClientRect().height === rowHeight &&
      carol.getBoundingClientRect().height === height);
    document.querySelector('.xrc-flow-skip').click();
    await wait(() => profile()?.getAttribute('href') === 'https://x.com/bob');
    check("跳过切换对象后，标签和主页不沿用上一人",!context().querySelector('.xrc-status[data-confirmed="true"]') &&
      context().querySelector('.xrc-new-person') && profile().title.includes('@bob'));
    document.querySelector('[data-testid="app-bar-close"]').click();
    await wait(() => !context());
    // Bob's reply is under Alice's original: homepage must still point to Bob.
    card("2112500000000000009").querySelector('[data-testid="reply"]').click();
    await wait(() => profile()?.getAttribute('href') === 'https://x.com/bob');
    check("楼中楼主页指向评论者，原帖链接仍指向原帖",context().querySelector('[data-origin="others"]') &&
      context().querySelector('a[href="https://x.com/i/status/2112500000000000006"]'));
    check("查看信息和跳过未发送评论",document.querySelector('#composer-evidence').dataset.requests === '0');
    document.querySelector('[data-testid="app-bar-close"]').click();
    const mode = document.querySelector('#context-result-mode');
    mode.value = 'failed';
    carol.querySelector('[data-testid="reply"]').click();
    await wait(() => profile()?.title.includes('读取失败'));
    check("读取失败仍可跳过，固定占位保留",!document.querySelector('.xrc-flow-skip').disabled &&
      profile().getAttribute('aria-disabled') === 'true' && context().getBoundingClientRect().height === rowHeight);
    document.querySelector('[data-testid="app-bar-close"]').click();
    mode.value = 'missing-author';
    carol.querySelector('[data-testid="reply"]').click();
    await wait(() => profile()?.title.includes('尚未读取'));
    check("缺少作者时保留统计，主页入口不可用",context().querySelector('.xrc-person') && !profile().hasAttribute('href'));
    document.querySelector('[data-testid="app-bar-close"]').click();
    mode.value = 'delayed';
    card("2112500000000000004").querySelector('[data-testid="reply"]').click();
    await wait(() => context());
    document.querySelector('.xrc-flow-skip').click();
    await wait(() => profile()?.getAttribute('href') === 'https://x.com/bob');
    check("慢响应中快速跳过，不显示上一个人的资料",profile().title.includes('@bob'));
    const editor = document.querySelector('[data-testid="tweetTextarea_0"]');
    document.querySelector('.xrc-continuous').remove();
    editor.dispatchEvent(new InputEvent('input',{ bubbles:true }));
    await wait(() => profile()?.getAttribute('href') === 'https://x.com/bob');
    check("弹窗底栏重绘后恢复本人的信息，行高不变",context().getBoundingClientRect().height === rowHeight);
  } catch (error) { results.push({ name:error.message,ok:false }); }
  finally {
    document.querySelector('#context-result-mode').value = 'success';
    document.querySelector('.demo-composer [data-testid="app-bar-close"]')?.click();
  }
  output.dataset.result = results.every(row => row.ok) ? 'passed' : 'failed';
  output.dataset.evidence = JSON.stringify(results);
  output.textContent = `${results.filter(row => row.ok).length}/${results.length} 通过\n`+
    results.map(row => `${row.ok ? '✓' : '✗'} ${row.name}`).join('\n');
}
