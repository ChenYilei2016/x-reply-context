// Measure intermediate sizes too: X measures virtual rows before async labels arrive.
export async function checkHeights(confirmReply) {
  const output = document.querySelector("#height-status");
  const timeline = document.querySelector("#timeline");
  const rows = [...timeline.querySelectorAll('article[data-testid="tweet"]')];
  const results = [];
  const settle = () => new Promise(resolve => setTimeout(resolve,500));
  const height = node => Math.round(node.getBoundingClientRect().height * 100) / 100;
  const top = node => Math.round((node.getBoundingClientRect().top + scrollY) * 100) / 100;
  const check = (name,before,after) => results.push({ name,before,after,ok:Math.abs(after-before)<1 });
  output.dataset.result = "running";
  output.textContent = "正在检查新通知加载及中途高度变化…";
  const incoming = rows[0].cloneNode(true);
  incoming.querySelectorAll(".xrc-labels").forEach(node => node.remove());
  delete incoming.dataset.xrcId;
  delete incoming.dataset.xrcStatus;
  const originalWidth = rows[0].style.width;
  try {
    timeline.prepend(incoming);
    // Synchronous reading matches a virtual list's initial row measurement.
    const initialHeight = height(incoming);
    const initialTop = top(rows[1]);
    await settle();
    check("新通知补入标签时不改变初次测量高度",initialHeight,height(incoming));
    check("新通知的标签不再二次推动下面的旧通知",initialTop,top(rows[1]));
    incoming.remove();
    await settle();
    rows[0].style.width = "500px";
    const beforeReply = height(rows[0]);
    confirmReply();
    await settle();
    check("窄卡片回复和点赞后 NEW 不换行改变高度",beforeReply,height(rows[0]));
    const beforeRepaint = height(rows[0]);
    rows[0].querySelector(".xrc-labels").remove();
    check("卡片重绘移除标签的一瞬间不收缩",beforeRepaint,height(rows[0]));
    await settle();
    check("恢复标签后高度保持",beforeRepaint,height(rows[0]));
  } catch (error) {
    results.push({ name:error.message,ok:false });
  } finally {
    incoming.remove();
    rows[0].style.width = originalWidth;
  }
  const passed = results.filter(result => result.ok).length;
  output.textContent = `${passed}/${results.length} 通过\n` + results.map(result =>
    `${result.ok ? "✓" : "✗"} ${result.name}` +
    (result.before === undefined ? "" : `（变化 ${Math.round(result.after-result.before)}px）`)).join("\n");
  output.dataset.evidence = JSON.stringify(results);
  output.dataset.result = passed === results.length ? "passed" : "failed";
}
