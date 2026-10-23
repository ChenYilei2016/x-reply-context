// Real browser timing, using the same production timer and settings-change listener.
export async function checkAutomaticLikes(prepare) {
  const output = document.querySelector('#automatic-likes-status');
  const results = [];
  const wait = async (condition,timeout = 4000) => {
    const until = Date.now()+timeout;
    while (!condition()) {
      if (Date.now()>until) throw new Error('等待自动点赞隐藏超时');
      await new Promise(resolve => setTimeout(resolve,25));
    }
  };
  const check = (name,ok,details = {}) => {
    results.push({ name,ok:Boolean(ok),...details }); if (!ok) throw new Error(name);
  };
  const hidden = row => row.hasAttribute('data-xrc-auto-like-hidden');
  const geometry = () => JSON.stringify([...document.querySelectorAll('.xrc-notification-controls button')]
    .map(b => { const r = b.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; }));
  output.dataset.result = 'running';
  try {
    await wait(() => document.querySelectorAll('.xrc-notification-controls button').length === 3 &&
      document.querySelector('#timeline .xrc-labels'));
    const { rows,follow,arrive } = prepare();
    const reading = [...document.querySelectorAll('#timeline article[data-testid="tweet"]')]
      .find(row => { const box = row.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight; });
    if (!reading) throw new Error('当前画面需有完整可见评论作为阅读锚点');
    const beforeTop = reading.getBoundingClientRect().top;
    const beforeButtons = geometry();
    const started = Date.now();
    await chrome.storage.local.set({ autoHideLikeNotifications:true });
    check('自动点赞独立开启，现有三个按钮不变',document.querySelectorAll('.xrc-notification-controls button').length === 3);
    await wait(() => rows.some(hidden),14000);
    check('真实空闲10秒后只处理一批，最多100条',rows.filter(hidden).length === 100,
      { elapsedMs:Date.now()-started,hidden:rows.filter(hidden).length });
    const arrived = arrive();
    await new Promise(resolve => setTimeout(resolve,11000));
    check('补位新消息不触发下一轮，余下50条也不继续隐藏',!hidden(arrived) && rows.filter(hidden).length === 100);
    check('评论、关注与当前阅读位置保留，按钮坐标不变',!hidden(follow) && !hidden(reading) &&
      Math.abs(reading.getBoundingClientRect().top-beforeTop)<1 && geometry() === beforeButtons,
      { beforeTop,afterTop:reading.getBoundingClientRect().top });
    await chrome.storage.local.set({ autoHideLikeNotifications:false });
    await wait(() => rows.every(row => !hidden(row)));
    check('关闭恢复，未发送评论或点赞',document.querySelector('#composer-evidence').dataset.requests === '0' &&
      document.querySelector('#composer-evidence').dataset.heartRequests === '0');
  } catch (error) { results.push({ name:error.message,ok:false }); }
  finally { await chrome.storage.local.set({ autoHideLikeNotifications:false }); }
  output.dataset.result = results.every(row => row.ok) ? 'passed' : 'failed';
  output.dataset.evidence = JSON.stringify(results);
  output.textContent = results.map(row => `${row.ok ? '✓' : '✗'} ${row.name}`).join('\n');
}
