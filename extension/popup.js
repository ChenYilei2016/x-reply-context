(async () => {
  const status = document.querySelector("#status");
  try {
    const [tab] = await chrome.tabs.query({ active:true,currentWindow:true });
    const { account } = await chrome.tabs.sendMessage(tab.id,{ type:"GET_ACCOUNT" });
    if (!account) throw new Error("请先打开已登录的 X 页面。");
    const summary = await chrome.runtime.sendMessage({ type:"SUMMARY",account });
    if (!summary?.ok) throw new Error(summary?.error || "本地记录暂不可用");
    status.textContent = `@${account}\n已记录 ${summary.replyCount} 组文字回复 · ${summary.likeCount} 条红心`;
    const history = document.querySelector("#history");
    history.href = `https://x.com/${account}/with_replies`;
    history.hidden = false;
  } catch {
    status.textContent = "请打开已登录的 X 页面。刚安装或更新后，请先刷新 X。";
  }
})();
