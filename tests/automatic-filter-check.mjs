// One real 10-second idle cycle in the local browser fixture; production timers are unchanged.
export async function checkAutomaticFilter(prepare) {
  const output = document.querySelector('#automatic-filter-status');
  const results = [];
  const wait = async (condition,timeout = 4000) => {
    const until = Date.now()+timeout;
    while (!condition()) {
      if (Date.now()>until) throw new Error('等待自动整理超时');
      await new Promise(resolve => setTimeout(resolve,25));
    }
  };
  const check = (name,ok,details = {}) => { results.push({ name,ok:Boolean(ok),...details }); if (!ok) throw new Error(name); };
  const toggle = () => document.querySelector('.xrc-notification-filter');
  const auto = () => document.querySelector('.xrc-filter-auto');
  const hidden = card => card.hasAttribute('data-xrc-notification-hidden');
  const geometry = () => JSON.stringify([...document.querySelectorAll('.xrc-notification-controls button')]
    .map(el => { const b=el.getBoundingClientRect(); return [b.left,b.top,b.width,b.height]; }));
  output.dataset.result = 'running';
  try {
    await wait(() => toggle() && !toggle().disabled && auto() && !auto().disabled);
    check('默认自动关闭，开关固定显示',auto().getAttribute('aria-pressed') === 'false' && !auto().hidden);
    toggle().click(); await wait(() => toggle().getAttribute('aria-pressed') === 'true' && !toggle().disabled);
    const { above,reading,below,late } = prepare();
    reading.scrollIntoView({ block:'center',behavior:'instant' });
    await wait(() => [above,reading,below].every(card => card.querySelector('.xrc-status')));
    const beforeTop = reading.getBoundingClientRect().top;
    const beforeHeight = reading.getBoundingClientRect().height;
    const beforeButtons = geometry();
    auto().click(); await wait(() => auto().getAttribute('aria-pressed') === 'true' && !auto().disabled);
    late();
    await wait(() => below.querySelector('.xrc-status')?.dataset.confirmed === 'true');
    const started = Date.now();
    check('晚到记录已确认，但阅读区和上方暂不收起',!hidden(above) && !hidden(reading) && !hidden(below));
    await wait(() => hidden(below),14000);
    check('空闲10秒后仅收起下方，当前阅读位置不变',!hidden(above) && !hidden(reading) &&
      Math.abs(reading.getBoundingClientRect().top-beforeTop)<1 && reading.getBoundingClientRect().height === beforeHeight,
      { elapsedMs:Date.now()-started,beforeTop,afterTop:reading.getBoundingClientRect().top });
    check('自动开关和整理过程不改变按钮位置',geometry() === beforeButtons && !auto().hidden);
    check('自动整理不会清理点赞通知',Array.from(document.querySelectorAll('article[data-testid="notification"]'))
      .every(node => !node.hasAttribute('data-xrc-like-notification-hidden')));
    auto().click(); await wait(() => auto().getAttribute('aria-pressed') === 'false');
    check('可关闭并保存本次选择',!auto().hidden && auto().getAttribute('aria-pressed') === 'false');
  } catch (error) { results.push({ name:error.message,ok:false }); }
  finally {
    if (auto()?.getAttribute('aria-pressed') === 'true' && !auto().disabled) auto().click();
  }
  output.dataset.result = results.every(row => row.ok) ? 'passed' : 'failed';
  output.dataset.evidence = JSON.stringify(results);
  output.textContent = `${results.filter(row => row.ok).length}/${results.length} 通过\n`+
    results.map(row => `${row.ok ? '✓' : '✗'} ${row.name}`).join('\n');
}
