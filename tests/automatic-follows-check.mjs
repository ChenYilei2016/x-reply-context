export async function checkAutomaticFollows(prepare) {
  const output = document.querySelector('#automatic-follows-status');
  const results = [];
  const wait = async (condition,timeout = 4000) => {
    const until = Date.now()+timeout;
    while (!condition()) {
      if (Date.now()>until) throw new Error('等待关注通知隐藏超时');
      await new Promise(resolve => setTimeout(resolve,25));
    }
  };
  const check = (name,ok,details = {}) => {
    results.push({ name,ok:Boolean(ok),...details }); if (!ok) throw new Error(name);
  };
  const hidden = row => row.hasAttribute('data-xrc-auto-follow-hidden');
  const geometry = () => JSON.stringify([...document.querySelectorAll('.xrc-notification-controls button')]
    .map(b => { const r = b.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; }));
  output.dataset.result = 'running';
  try {
    await wait(() => document.querySelectorAll('.xrc-notification-controls button').length === 3 &&
      document.querySelector('#timeline .xrc-labels'));
    const { rows,like,arrive } = prepare();
    const reading = [...document.querySelectorAll('#timeline article[data-testid="tweet"]')]
      .find(row => { const box = row.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight; });
    if (!reading) throw new Error('当前画面需有完整可见评论');
    const beforeTop = reading.getBoundingClientRect().top;
    const beforeButtons = geometry();
    const started = Date.now();
    await chrome.storage.local.set({ autoHideFollowNotifications:true });
    await wait(() => rows.some(hidden),14000);
    check('关注独立开启，真实空闲10秒后仅隐藏一批100条',rows.filter(hidden).length === 100,
      { elapsedMs:Date.now()-started });
    const arrived = arrive();
    await new Promise(resolve => setTimeout(resolve,11000));
    check('补位新关注和余下50条保留，不连续清理',!hidden(arrived) && rows.filter(hidden).length === 100);
    check('评论和点赞保留、阅读锚点及三个按钮坐标不变',!hidden(like) && !hidden(reading) &&
      Math.abs(reading.getBoundingClientRect().top-beforeTop)<1 && geometry() === beforeButtons,
      { beforeTop,afterTop:reading.getBoundingClientRect().top });
    await chrome.storage.local.set({ autoHideFollowNotifications:false });
    await wait(() => rows.every(row => !hidden(row)));
    check('关闭恢复，没有发送、点赞或操作真实关注',document.querySelector('#composer-evidence').dataset.requests === '0' &&
      document.querySelector('#composer-evidence').dataset.heartRequests === '0');
  } catch (error) { results.push({ name:error.message,ok:false }); }
  finally { await chrome.storage.local.set({ autoHideFollowNotifications:false }); }
  output.dataset.result = results.every(row => row.ok) ? 'passed' : 'failed';
  output.dataset.evidence = JSON.stringify(results);
  output.textContent = results.map(row => `${row.ok ? '✓' : '✗'} ${row.name}`).join('\n');
}
