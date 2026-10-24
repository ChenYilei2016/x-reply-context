export async function checkEmptyRecovery(prepare) {
  const output = document.querySelector('#empty-recovery-status');
  const checks = [];
  const check = (name,ok) => { checks.push({name,ok:Boolean(ok)}); if (!ok) throw new Error(name); };
  const wait = async predicate => {
    const until = Date.now()+3500;
    while (!predicate()) { if (Date.now()>until) throw new Error('全隐藏后没有可用的恢复入口'); await new Promise(resolve=>setTimeout(resolve,25)); }
  };
  const settle = () => new Promise(resolve=>setTimeout(resolve,350));
  const notice = () => document.querySelector('.xrc-network-notice:not([hidden])');
  output.dataset.result = 'running';
  try {
    const {add,hideLater} = prepare();
    await wait(()=>document.querySelector('.xrc-notification-replied:not(:disabled)'));
    const controls = [...document.querySelectorAll('.xrc-notification-controls button')];
    const positions = controls.map(button=>button.getBoundingClientRect().x);
    document.querySelector('.xrc-notification-replied').click();
    await wait(()=>document.querySelectorAll('[data-xrc-notification-hidden]').length===2);
    await wait(()=>notice()?.querySelector('.xrc-empty-restore:not([hidden])'));
    check('第一次整理全隐藏后显示明确提示和恢复入口',notice().textContent.includes('已隐藏'));
    const arriving = add(); await settle();
    check('新到达的未回复通知正常显示，不被旧的全隐藏状态吞掉',!arriving.hasAttribute('data-xrc-notification-hidden') && !notice());
    hideLater(); await wait(()=>!document.querySelector('.xrc-filter-apply').disabled);
    document.querySelector('.xrc-filter-apply').click();
    await wait(()=>notice()?.querySelector('.xrc-empty-restore:not([hidden])'));
    check('第二次整理全部收起后仍可恢复',document.querySelectorAll('[data-xrc-notification-hidden]').length===3);
    notice().querySelector('.xrc-empty-restore').click(); await settle();
    check('显示本批恢复三条卡片并保留仅已回开关',document.querySelectorAll('[data-xrc-notification-hidden]').length===0 &&
      document.querySelector('.xrc-notification-replied').getAttribute('aria-pressed')==='true');
    check('恢复后提示收起，标题栏按钮位置不变',!notice() && controls.every((button,index)=>button.getBoundingClientRect().x===positions[index]));
    check('恢复不发送评论或点赞',document.querySelector('#composer-evidence').dataset.requests==='0' &&
      document.querySelector('#composer-evidence').dataset.heartRequests==='0');
  } catch(error) { checks.push({name:error.message,ok:false}); }
  output.dataset.result=checks.every(row=>row.ok)?'passed':'failed';
  output.dataset.evidence=JSON.stringify(checks);
  output.textContent=checks.map(row=>`${row.ok?'✓':'✗'} ${row.name}`).join('\n');
}
