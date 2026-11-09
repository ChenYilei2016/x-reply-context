(() => {
  "use strict";
  const { parsePostLink,mp4Url } = globalThis.XReplyPostVideo;

  function create({ tabs,downloads }) {
    let busy = false;

    async function readTab(tabId,postId) {
      if (!Number.isInteger(tabId)) return null;
      try {
        const result = await tabs.sendMessage(tabId,{ type:"GET_POST_VIDEO",id:postId },{ frameId:0 });
        return result?.seen ? { url:mp4Url(result.url) } : null;
      } catch { return null; }
    }

    async function readTemporaryTab(post) {
      const tab = await tabs.create({ url:post.url,active:false });
      let selected = false, closed = false;
      const onActivated = info => { if (info.tabId === tab.id) selected = true; };
      const onRemoved = id => { if (id === tab.id) closed = true; };
      tabs.onActivated.addListener(onActivated);
      tabs.onRemoved.addListener(onRemoved);
      try {
        const deadline = Date.now()+12000;
        while (!closed && Date.now() < deadline) {
          const result = await readTab(tab.id,post.id);
          if (result) return result;
          if (!closed) await new Promise(resolve => setTimeout(resolve,400));
        }
        return null;
      } finally {
        try {
          if (!selected && !closed) {
            const current = await tabs.get(tab.id);
            if (!selected && !current.active) await tabs.remove(tab.id);
          }
        } catch { /* The tab may have been closed while checking. */ }
        tabs.onActivated.removeListener(onActivated);
        tabs.onRemoved.removeListener(onRemoved);
      }
    }

    async function download({ url,tabId }) {
      const post = parsePostLink(url);
      if (!post) return { ok:false,error:"请填写 X 或 Twitter 的帖子链接。" };
      if (busy) return { ok:false,error:"正在处理上一个视频，请稍候。" };
      busy = true;
      try {
        const result = await readTab(tabId,post.id) ?? await readTemporaryTab(post);
        if (!result) return { ok:false,error:"没能读取帖子，请确认该链接能在 X 打开后重试。" };
        if (!result.url) return { ok:false,error:"这条帖子没有可下载的 MP4 视频。" };
        await downloads.download({ url:result.url,filename:`X-${post.id}.mp4`,conflictAction:"uniquify" });
        return { ok:true };
      } finally { busy = false; }
    }

    return { download };
  }

  globalThis.XReplyVideoDownload = { create };
})();
