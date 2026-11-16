// 国内热榜渠道：百度热搜（实时榜）、B站热门。均为公开接口，无需登录。
(() => {
  "use strict";

  const { register } = globalThis.XReplyChannels;

  function baiduHotItems(body) {
    const list = body?.data?.cards?.[0]?.content?.[0]?.content;
    if (!Array.isArray(list)) throw new Error("百度热搜返回结构已变化");
    // 置顶条目是官方推荐位，不代表热度排名，排除。
    return list.filter(entry => !entry.isTop && typeof entry.word === "string" && entry.word.trim()).map(entry => ({
      id: `baidu:${entry.word.trim()}`, kind: "hot_topic", coverage: "title",
      url: typeof entry.url === "string" && entry.url.startsWith("https://") ? entry.url : `https://www.baidu.com/s?wd=${encodeURIComponent(entry.word)}`,
      title: entry.word, text: typeof entry.desc === "string" ? entry.desc : "",
      metrics: Number.isSafeInteger(entry.index) ? { rank: entry.index } : undefined
    }));
  }

  function bilibiliItems(body) {
    const list = body?.data?.list;
    if (body?.code !== 0 || !Array.isArray(list)) throw new Error(`B站热门返回异常（code ${body?.code}）`);
    return list.filter(video => typeof video.bvid === "string").map((video, index) => ({
      id: `bilibili:${video.bvid}`, kind: "hot_topic",
      url: `https://www.bilibili.com/video/${video.bvid}`,
      title: video.title, text: video.desc && video.desc !== "-" ? video.desc : "",
      publishedAt: Number.isSafeInteger(video.pubdate) ? video.pubdate * 1000 : undefined,
      author: video.owner?.name ? { name: video.owner.name } : undefined,
      metrics: {
        views: video.stat?.view, likes: video.stat?.like, replies: video.stat?.reply,
        reposts: video.stat?.share, bookmarks: video.stat?.favorite, rank: index + 1
      },
      media: typeof video.pic === "string" ? [{ type: "image", url: video.pic.replace(/^http:/, "https:") }] : [],
      tags: video.tname ? [video.tname] : []
    }));
  }

  register({
    id: "baidu-hot", name: "百度热搜", category: "hot", intervalMinutes: 30, maxItems: 50,
    url: "https://top.baidu.com/api/board?platform=wise&tab=realtime", format: "json",
    origins: ["https://top.baidu.com/*"], hosts: ["top.baidu.com"], parse: baiduHotItems
  });
  register({
    id: "bilibili-popular", name: "B站热门", category: "entertainment", intervalMinutes: 30, maxItems: 30,
    url: "https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1", format: "json",
    origins: ["https://api.bilibili.com/*"], hosts: ["api.bilibili.com"], parse: bilibiliItems
  });
})();
