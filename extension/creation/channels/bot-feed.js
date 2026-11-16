// 本机 bot feed：云端 bot 在电脑开机时把结果同步到本机目录，由本机静态服务提供 feed.json。
// 文件格式见 docs/guide/bot-feed.md（schema 固定为 xrc.feed/v1）。
(() => {
  "use strict";

  const { register } = globalThis.XReplyChannels;
  const SCHEMA = "xrc.feed/v1";
  const DEFAULT_URL = "http://127.0.0.1:8765/feed.json";

  function feedItems(body) {
    if (body?.schema !== SCHEMA) throw new Error(`feed 的 schema 不是 ${SCHEMA}`);
    if (!Array.isArray(body.items)) throw new Error("feed 缺少 items 数组");
    return body.items;
  }

  register({
    id: "bot-feed", name: "我的 bot", category: "other", intervalMinutes: 15, maxItems: 500, maxBytes: 5 * 1024 * 1024,
    url: settings => settings.url || DEFAULT_URL, configurableUrl: true, format: "json",
    origins: ["http://127.0.0.1/*", "http://localhost/*"], hosts: ["127.0.0.1", "localhost"],
    parse: feedItems
  });

  globalThis.XReplyBotFeed = Object.freeze({ SCHEMA, DEFAULT_URL });
})();
