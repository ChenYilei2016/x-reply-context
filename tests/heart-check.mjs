// Runs only in the local fixture, using production buttons and the mocked native requests.
export async function checkHearts() {
  const output = document.querySelector("#heart-status");
  const evidence = document.querySelector("#composer-evidence");
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
  const heart = () => document.querySelector(".xrc-flow-heart");
  const requestCount = () => Number(evidence.dataset.heartRequests);
  const records = () => JSON.parse(evidence.dataset.likeRecords || "{}");
  const dialog = () => document.querySelector(".demo-composer");
  const targetId = location.pathname === "/home" ? "2112500000000050001" : "2112500000000000013";
  const source = document.querySelector(`[data-demo-id="${targetId}"]`);
  output.dataset.result = "running";
  document.querySelector("#heart-result-mode").value = "success";
  document.querySelector("#reply-result-mode").value = "success";
  try {
    if (dialog()) throw new Error("请先关闭现有回复框并刷新演示页");
    source.querySelector('[data-testid="reply"]').click();
    await wait(() => heart());
    check("打开回复框不自动点赞",requestCount() === 0 && heart().getAttribute("aria-pressed") === "false");
    heart().click();
    await wait(() => records()[`101:${targetId}`]?.liked === true && !heart().disabled);
    check("手动点赞精确保存当前帖，按钮同步已点",requestCount() === 1 && heart().getAttribute("aria-pressed") === "true");
    const savedReplies = evidence.dataset.replyWrites;
    heart().click();
    await wait(() => records()[`101:${targetId}`]?.liked === false && !heart().disabled);
    check("手动取消正常保存，不改变文字记录",requestCount() === 2 &&
      heart().getAttribute("aria-pressed") === "false" && evidence.dataset.replyWrites === savedReplies);
    document.querySelector("#heart-result-mode").value = "failed";
    heart().click();
    await wait(() => !heart().disabled && heart().getAttribute("aria-pressed") === "false");
    check("失败回滚红心，不写成成功",requestCount() === 3 && records()[`101:${targetId}`]?.liked === false);
    document.querySelector("#heart-result-mode").value = "success";
    document.querySelector(".xrc-flow-skip").click();
    await wait(() => dialog()?.dataset.targetId !== targetId && heart());
    check("跳过不自动点赞",requestCount() === 3);
    const nextId = dialog().dataset.targetId;
    const editor = dialog().querySelector('[contenteditable="true"]');
    editor.textContent = "本地模拟：发送不附带点赞";
    editor.dispatchEvent(new InputEvent("input",{ bubbles:true,inputType:"insertText",data:editor.textContent }));
    document.querySelector(".xrc-flow-send").click();
    await wait(() => evidence.dataset.sent === "1" && dialog()?.dataset.targetId !== nextId && heart());
    check("发送并下一条不自动点赞",requestCount() === 3);
    const currentId = dialog().dataset.targetId;
    document.querySelector(`[data-demo-id="${currentId}"]`).remove();
    await wait(() => heart().disabled);
    heart().click();
    check("原卡片移出后禁用，不误点其他帖",requestCount() === 3 && heart().textContent.includes("不可用"));
  } catch (error) {
    results.push({ name:error.message,ok:false });
  } finally {
    dialog()?.querySelector('[data-testid="app-bar-close"]').click();
  }
  output.dataset.result = results.every(row => row.ok) ? "passed" : "failed";
  output.dataset.evidence = JSON.stringify(results);
  output.textContent = `${results.filter(row => row.ok).length}/${results.length} 通过\n`+
    results.map(row => `${row.ok ? "✓" : "✗"} ${row.name}`).join("\n");
}
