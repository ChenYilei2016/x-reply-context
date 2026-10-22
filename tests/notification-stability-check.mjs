export async function checkNotificationStability({ pauseLabels,paused,releaseLabels,lateReply,burst }) {
  const output = document.querySelector("#stability-status");
  const results = [];
  const check = (name,ok,details = {}) => results.push({ name,ok:Boolean(ok),...details });
  const wait = async condition => {
    const until = Date.now()+3500;
    while (!condition()) {
      if (Date.now()>until) return false;
      await new Promise(resolve => setTimeout(resolve,25));
    }
    return true;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve,650));
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const card = id => document.querySelector(`[data-demo-id="${id}"]`);
  const hidden = el => el.hasAttribute("data-xrc-notification-hidden");
  const toggle = () => document.querySelector(".xrc-notification-filter");
  const arrange = () => document.querySelector(".xrc-filter-apply");
  output.dataset.result = "running";
  try {
    if (location.pathname !== "/notifications") throw new Error("请从新的通知演示页运行");
    await wait(() => toggle() && !toggle().disabled && card("2112500000000000013")?.querySelector(".xrc-status"));
    pauseLabels();
    if (!await wait(paused)) throw new Error("未捕获标签分类请求");
    lateReply("2112500000000000013");
    releaseLabels();
    check("较旧的标签响应不能覆盖较新的已回依据",await wait(() =>
      card("2112500000000000013").querySelector(".xrc-status")?.dataset.confirmed === "true"));

    toggle().click(); await settle();
    const target = card("2112500000000000009");
    target.scrollIntoView({ block:"center",behavior:"instant" }); await frame();
    const beforeTop = target.getBoundingClientRect().top;
    const beforeHeight = target.getBoundingClientRect().height;
    target.querySelector('[data-testid="reply"]').click();
    await wait(() => document.querySelector('.demo-composer [data-testid="app-bar-close"]'));
    lateReply("2112500000000000009"); await settle();
    document.querySelector('.demo-composer [data-testid="app-bar-close"]').click();
    await settle();
    const afterTop = target.getBoundingClientRect().top;
    const afterHeight = target.getBoundingClientRect().height;
    check("打开空回复框后不发送，关闭仍保持卡片高度与位置",!hidden(target) &&
      Math.abs(afterTop-beforeTop)<1 && afterHeight===beforeHeight,{ beforeTop,afterTop,beforeHeight,afterHeight });
    check("晚到历史依据正常更新标签，未发送任何评论",
      target.querySelector(".xrc-status")?.dataset.confirmed === "true" &&
      document.querySelector("#composer-evidence").dataset.requests === "0");

    const arrived = burst(160);
    // Pin the reading point after X's own insertion, then check for a second plugin-driven movement.
    target.scrollIntoView({ block:"center",behavior:"instant" }); await frame();
    const burstTop = target.getBoundingClientRect().top;
    await settle();
    const protectedRows = arrived.filter(el => el.getBoundingClientRect().top <= innerHeight+600);
    check("160条完成项突增后，不二次收起阅读点上方的卡片",
      Math.abs(target.getBoundingClientRect().top-burstTop)<1 && protectedRows.every(el => !hidden(el)),
      { added:arrived.length,protected:protectedRows.length,before:burstTop,after:target.getBoundingClientRect().top });
    check("超过100条已加载通知仍全部渲染标签",arrived.every(el => el.querySelector('.xrc-labels')));
    const candidate = arrived[0];
    const unknownId = "2112500000000888888";
    candidate.setAttribute("data-xrc-notification-hidden",candidate.dataset.demoId);
    candidate.dataset.demoId = unknownId;
    candidate.querySelector("time").closest("a").href = `/unknown/status/${unknownId}`;
    candidate.querySelector('[data-testid="tweetText"]').textContent = "虚拟节点已复用为未知新帖";
    await Promise.resolve(); await Promise.resolve();
    check("虚拟行复用时，在绘制前清除旧隐藏标记",!hidden(candidate));
    await settle();
    check("历史更新只进入待整理，不自动移除当前通知",arrange() && !arrange().disabled && !hidden(target));
    if (arrange() && !arrange().disabled) {
      arrange().click(); await settle();
      check("只有点击整理更新后才收起已完成通知",hidden(target));
    } else check("只有点击整理更新后才收起已完成通知",false);
    toggle().click(); await settle();
    check("关闭筛选恢复当前已加载卡片",document.querySelectorAll('[data-xrc-notification-hidden]').length === 0);
  } catch (error) { results.push({ name:error.message,ok:false }); }
  finally { releaseLabels(); document.querySelector('.demo-composer [data-testid="app-bar-close"]')?.click(); }
  output.dataset.result = results.every(row => row.ok) ? "passed" : "failed";
  output.dataset.evidence = JSON.stringify(results);
  output.textContent = `${results.filter(row => row.ok).length}/${results.length} 通过\n`+
    results.map(row => `${row.ok ? "✓" : "✗"} ${row.name}`).join("\n");
}
