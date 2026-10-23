export async function checkManualLikes(add) {
  const output = document.querySelector('#manual-likes-status');
  const results = [];
  const wait = async condition => {
    const until = Date.now()+4000;
    while (!condition()) { if (Date.now()>until) throw new Error('等待单次点赞整理超时'); await new Promise(resolve => setTimeout(resolve,25)); }
  };
  const check = (name,ok) => { results.push({ name,ok:Boolean(ok) }); if (!ok) throw new Error(name); };
  const hidden = node => node.hasAttribute('data-xrc-like-notification-hidden');
  const apply = () => document.querySelector('.xrc-filter-apply');
  const toggle = () => document.querySelector('.xrc-notification-filter');
  output.dataset.result = 'running';
  try {
    await wait(() => toggle() && !toggle().disabled);
    const old = document.querySelector('[data-demo-notice="8001"]');
    const follow = add('8002','follow');
    toggle().click(); await wait(() => !toggle().disabled && toggle().getAttribute('aria-pressed') === 'true');
    check('开启隐藏规则不会自动隐藏点赞或关注',!hidden(old) && !hidden(follow));
    apply().click();
    const arrived = add('8003');
    await wait(() => !toggle().disabled);
    check('一次手动只隐藏点击快照，补位新点赞仍保留',hidden(old) && !hidden(arrived) && !hidden(follow));
    old.querySelector('time').textContent = '2分钟';
    await new Promise(resolve => setTimeout(resolve,400));
    check('时间文案更新不恢复旧项，也不追着隐藏新项',hidden(old) && !hidden(arrived));
    old.querySelector('time').setAttribute('datetime','2026-10-22T00:00:00Z');
    await wait(() => !hidden(old));
    check('虚拟节点换成另一通知时清除旧隐藏标记',!hidden(old));
    apply().click(); await wait(() => !toggle().disabled);
    toggle().click(); await wait(() => toggle().getAttribute('aria-pressed') === 'false');
    await wait(() => !document.querySelector('[data-xrc-like-notification-hidden]'));
    check('关闭隐藏规则可恢复，未发送或点赞',!hidden(arrived) &&
      document.querySelector('#composer-evidence').dataset.requests === '0' &&
      document.querySelector('#composer-evidence').dataset.heartRequests === '0');
  } catch (error) { results.push({ name:error.message,ok:false }); }
  output.dataset.result = results.every(row => row.ok) ? 'passed' : 'failed';
  output.dataset.evidence = JSON.stringify(results);
  output.textContent = `${results.filter(row => row.ok).length}/${results.length} 通过\n`+results.map(row => `${row.ok ? '✓' : '✗'} ${row.name}`).join('\n');
}
