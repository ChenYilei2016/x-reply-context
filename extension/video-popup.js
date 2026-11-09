(() => {
  "use strict";
  const { parsePostLink } = globalThis.XReplyPostVideo;
  const form = document.querySelector("#post-video-form");
  const input = form.querySelector("input");
  const button = form.querySelector("button");
  const status = form.querySelector('[role="status"]');
  let tabId;

  void chrome.tabs.query({ active:true,currentWindow:true }).then(async ([tab]) => {
    tabId = tab?.id;
    const post = parsePostLink(tab?.url) || (Number.isInteger(tabId) &&
      parsePostLink((await chrome.tabs.sendMessage(tabId,{ type:"GET_POST_VIDEO" },{ frameId:0 }))?.postUrl));
    if (post && !input.value && !button.disabled) input.value = post.url;
  }).catch(() => {});

  form.addEventListener("submit",async event => {
    event.preventDefault();
    if (button.disabled) return;
    const post = parsePostLink(input.value);
    if (!post) { status.textContent = "请填写 X 或 Twitter 的帖子链接。"; input.focus(); return; }
    button.disabled = input.disabled = true;
    status.textContent = "正在读取帖子视频…";
    try {
      const result = await chrome.runtime.sendMessage({ type:"DOWNLOAD_POST_VIDEO",url:post.url,tabId });
      status.textContent = result?.ok ? "已交给 Chrome 下载。" : result?.error || "暂时无法下载，请重试。";
    } catch { status.textContent = "暂时无法下载，请重试。"; }
    finally { button.disabled = input.disabled = false; }
  });
})();
