// Browser-only regression check using the real content script and local demo data.
export async function checkLayout(updateRecord) {
  const output = document.querySelector("#layout-status");
  const timeline = document.querySelector("#timeline");
  const rows = [...timeline.querySelectorAll('article[data-testid="tweet"]')];
  const originalUrl = location.href;
  const selectedTabs = [...document.querySelectorAll('a[role="tab"][aria-selected="true"][href^="/notifications"]')];
  const results = [];
  const settle = () => new Promise(resolve => setTimeout(resolve,500));
  const position = () => Math.round((rows[1].getBoundingClientRect().top + scrollY) * 100) / 100;
  const check = (name,ok,details) => results.push({ name,ok,...details });
  output.dataset.result = "running";
  output.textContent = "正在检查弹窗、数据更新和列表重绘…";
  let dialog;
  try {
    if (!rows.length || !timeline.querySelector(".xrc-labels")) throw new Error("标签尚未加载");
    for (const path of ["/compose/post","/notifications"]) {
      const before = position();
      const bars = [...timeline.querySelectorAll(".xrc-labels")];
      const heartBefore = rows[0].querySelector(".xrc-heart").dataset.confirmed;
      dialog = document.createElement("div");
      dialog.className = "demo-dialog";
      dialog.setAttribute("role","dialog");
      dialog.setAttribute("aria-modal","true");
      dialog.setAttribute("aria-label","模拟回复框");
      const heading = document.createElement("h2");
      heading.textContent = "模拟回复框 · 不会发送评论";
      const quoted = rows[0].cloneNode(true);
      quoted.querySelectorAll(".xrc-labels").forEach(node => node.remove());
      dialog.append(heading,quoted);
      history.replaceState(null,"",path);
      // X deselects all notification tabs while its reply dialog is open.
      selectedTabs.forEach(tab => tab.setAttribute("aria-selected","false"));
      document.body.append(dialog);
      await settle();
      check(`${path} 打开并取消页签选中后，背景标签和位置保持`,
        bars.every(bar => bar.isConnected) && Math.abs(position()-before) < 1,
        { before,after:position(),labels:timeline.querySelectorAll(".xrc-labels").length });
      const expectedCount = updateRecord();
      await settle();
      const displayedCount = Number(rows[0].querySelector(".xrc-person").textContent.match(/\d+/)?.[0]);
      check(`${path} 弹窗中同步评论统计和红心，且不移动列表`,
        !dialog.querySelector(".xrc-labels") && Math.abs(position()-before) < 1 &&
          rows[0].querySelector(".xrc-heart")?.dataset.confirmed !== heartBefore &&
          displayedCount === expectedCount,
        { before,after:position(),expectedCount,displayedCount });
      dialog.remove();
      history.replaceState(null,"",originalUrl);
      selectedTabs.forEach(tab => tab.setAttribute("aria-selected","true"));
      window.dispatchEvent(new PopStateEvent("popstate"));
      await settle();
      check(`${path} 关闭后位置保持并显示新记录`,
        Math.abs(position()-before) < 1 &&
          rows[0].querySelector(".xrc-heart")?.dataset.confirmed !== heartBefore,
        { before,after:position() });
    }
    const heartBeforeEmpty = rows[0].querySelector(".xrc-heart").dataset.confirmed;
    dialog = document.createElement("div");
    dialog.setAttribute("role","dialog");
    document.body.append(dialog);
    updateRecord();
    await settle();
    check("零高度弹窗容器不阻止更新",rows[0].querySelector(".xrc-heart").dataset.confirmed !== heartBeforeEmpty);
    dialog.remove();
    // X can replace an article's contents while retaining its outer element.
    rows[0].querySelector(".xrc-labels").remove();
    await settle();
    check("同一条卡片重绘后标签恢复",Boolean(rows[0].querySelector(".xrc-labels")));
    check("通知页不再插入顶部统计说明",!document.querySelector(".xrc-guide"));
  } catch (error) {
    check("检查完成",false,{ error:error.message });
  } finally {
    dialog?.remove();
    selectedTabs.forEach(tab => tab.setAttribute("aria-selected","true"));
    history.replaceState(null,"",originalUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  const passed = results.filter(result => result.ok).length;
  output.textContent = `${passed}/${results.length} 通过\n` +
    results.map(result => `${result.ok ? "✓" : "✗"} ${result.name}` +
      (result.before === undefined ? "" : `（偏移 ${Math.round(result.after-result.before)}px）`)).join("\n");
  output.dataset.evidence = JSON.stringify(results);
  output.dataset.result = passed === results.length ? "passed" : "failed";
}
