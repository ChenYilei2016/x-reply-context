// Fixture-only workflow using production controls, storage events and simulated native requests.
export async function checkNotificationFilter(arrive) {
  const output = document.querySelector("#notification-filter-status");
  const results = [];
  const check = (name,ok) => {
    results.push({ name,ok });
    if (!ok) throw new Error(name);
  };
  const wait = async condition => {
    const until = Date.now()+4000;
    while (!condition()) {
      if (Date.now() > until) throw new Error("等待界面或记录超时");
      await new Promise(resolve => setTimeout(resolve,30));
    }
  };
  const toggle = () => document.querySelector(".xrc-notification-filter");
  const hidden = () => document.querySelectorAll('[data-xrc-notification-hidden]');
  const arrange = () => document.querySelector('.xrc-filter-apply');
  const card = id => document.querySelector(`[data-demo-id="${id}"]`);
  output.dataset.result = "running";
  try {
    if (!/^\/notifications$/.test(location.pathname)) throw new Error("请从新的通知演示页运行");
    await wait(() => toggle() && !toggle().disabled);
    const positions = () => JSON.stringify([toggle(),arrange(),document.querySelector('a[href="/settings/notifications"]')]
      .map(el => { const b = el.getBoundingClientRect(); return [b.left,b.top,b.width,b.height]; }));
    const initialPositions = positions();
    const headerHeight = document.querySelector(".demo-title").getBoundingClientRect().height;
    check("默认关闭，通知完整保留",toggle().getAttribute("aria-pressed") === "false" && hidden().length === 0);
    check("关闭筛选时应用按钮仍保留并置灰",arrange() && !arrange().hidden && arrange().disabled);
    document.querySelector("#demo-settings-fail").checked = true;
    toggle().click();
    await wait(() => toggle().textContent.includes("失败"));
    check("保存失败不改变设置或隐藏通知",toggle().getAttribute("aria-pressed") === "false" && hidden().length === 0);
    document.querySelector("#demo-settings-fail").checked = false;
    toggle().click();
    await wait(() => hidden().length === 1);
    check("仅隐藏文字和红心均确认的评论，聚合通知保留",
      card("2112500000000000004").hasAttribute("data-xrc-notification-hidden") &&
      !card("2112500000000000008").hasAttribute("data-xrc-notification-hidden") &&
      !card("2112500000000000009").hasAttribute("data-xrc-notification-hidden") &&
      document.querySelector('[data-testid="notification"]').getBoundingClientRect().height > 1);
    check("按钮切换不新增标题行高度",document.querySelector(".demo-title").getBoundingClientRect().height === headerHeight);
    check("开启后无更新时保持按钮位置",arrange().disabled && positions() === initialPositions);
    arrive();
    await wait(() => arrange() && !arrange().disabled);
    check("阅读区域的新通知先保留，等待手动整理",!card("2112500000000070001").hasAttribute("data-xrc-notification-hidden"));
    check("有更新时按钮启用但位置宽度不变",positions() === initialPositions && arrange().textContent === '整理列表');
    arrange().click();
    check("点击应用后立即锁定，避免连点",arrange().disabled);
    await wait(() => hidden().length === 2);
    check("手动整理沿用同原帖同人的已确认状态",card("2112500000000070001").hasAttribute("data-xrc-notification-hidden"));
    document.querySelector("#demo-hide-completed").click();
    await new Promise(resolve => setTimeout(resolve,350));
    check("主页开关与通知筛选独立",hidden().length === 2 && toggle().getAttribute("aria-pressed") === "true");
    document.querySelector("#simulate").click();
    card("2112500000000000013").querySelector('[data-testid="reply"]').click();
    await wait(() => document.querySelector(".xrc-flow-heart"));
    await wait(() => toggle().disabled && arrange().disabled);
    check("compose路径编辑时按钮保留且禁用",!arrange().hidden && positions() === initialPositions);
    document.querySelector(".xrc-flow-heart").click();
    await wait(() => document.querySelector("#composer-evidence").dataset.likeRecords?.includes('"id":"2112500000000000013"'));
    check("回复框打开时不隐藏当前评论",!card("2112500000000000013").hasAttribute("data-xrc-notification-hidden"));
    document.querySelector('[data-testid="app-bar-close"]').click();
    await wait(() => arrange() && !arrange().disabled);
    check("关闭回复框不自动收起当前评论",!card("2112500000000000013").hasAttribute("data-xrc-notification-hidden"));
    arrange().click();
    await wait(() => hidden().length === 3);
    check("手动整理后应用已保存的两项状态",card("2112500000000000013").hasAttribute("data-xrc-notification-hidden"));
    toggle().click();
    await wait(() => hidden().length === 0);
    check("关闭筛选恢复全部卡片，保留已回和红心标签",
      card("2112500000000000013").querySelector('.xrc-status[data-confirmed="true"]') &&
      card("2112500000000000013").querySelector('.xrc-heart[data-confirmed="true"]'));
    check("完成与关闭后控件仍在原位置",!arrange().hidden && arrange().disabled && positions() === initialPositions);
  } catch (error) {
    results.push({ name:error.message,ok:false });
  } finally {
    document.querySelector("#demo-settings-fail").checked = false;
    document.querySelector('.demo-composer [data-testid="app-bar-close"]')?.click();
  }
  output.dataset.result = results.every(row => row.ok) ? "passed" : "failed";
  output.dataset.evidence = JSON.stringify(results.map(row => ({ name:row.name,ok:Boolean(row.ok) })));
  output.textContent = `${results.filter(row => row.ok).length}/${results.length} 通过\n`+
    results.map(row => `${row.ok ? "✓" : "✗"} ${row.name}`).join("\n");
}
