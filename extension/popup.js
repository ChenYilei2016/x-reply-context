async function installCheckbox(selector,key,statusSelector,enabledText,defaultEnabled = false,
    disabledText = defaultEnabled ? "已关闭；刷新通知页可恢复此前被过滤的消息。" : "已关闭，恢复正常显示。") {
  const checkbox = document.querySelector(selector);
  const status = document.querySelector(statusSelector);
  try {
    const saved = await chrome.storage.local.get(key);
    checkbox.checked = defaultEnabled ? saved[key] !== false : saved[key] === true;
    checkbox.disabled = false;
    checkbox.addEventListener("change",async () => {
      const value = checkbox.checked;
      checkbox.disabled = true;
      try {
        await chrome.storage.local.set({ [key]:value });
        status.textContent = value ? enabledText : disabledText;
      } catch {
        checkbox.checked = !value;
        status.textContent = "设置未保存，请重试。";
      } finally { checkbox.disabled = false; }
    });
  } catch { status.textContent = "设置暂时不可用，请重新打开扩展。"; }
}
void installCheckbox("#ai-auto-complete","aiAutoComplete","#ai-auto-status","已开启；空回复框自动生成候选。",false,"已关闭；点击推荐评论才生成，已有草稿保留。");
void installCheckbox("#hide-completed-home","hideCompletedHome","#home-filter-status","已开启，按本机已确认记录筛选。");
void installCheckbox("#auto-hide-like-notifications","autoHideLikeNotifications","#like-filter-status","已开启，后续接收时过滤点赞通知；空批暂停翻页。",true);
void installCheckbox("#auto-hide-follow-notifications","autoHideFollowNotifications","#follow-filter-status","已开启，后续接收时过滤关注通知；空批暂停翻页。",true);
void installCheckbox("#auto-hide-repost-notifications","autoHideRepostNotifications","#repost-filter-status",
  "已开启，后续接收时过滤转发通知；带正文的引用帖保留。",false,"已关闭；刷新通知页可恢复此前被过滤的转发通知。");

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
