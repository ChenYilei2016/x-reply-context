// RSS / Atom 渠道：AI 一手动态、科技新闻、Hacker News、Product Hunt。
(() => {
  "use strict";

  const { parseFeed, htmlToText } = globalThis.XReplyFeedParser;
  const { register } = globalThis.XReplyChannels;
  const TEXT_LIMIT = 10000;

  /** 通用映射：一条 RSS/Atom 条目 → 文章素材。 */
  function articleItem(entry, extra = {}) {
    return {
      id: entry.link, kind: "article", url: entry.link, title: entry.title,
      text: htmlToText(entry.content || entry.summary, TEXT_LIMIT),
      publishedAt: entry.published,
      author: entry.author ? { name: entry.author } : undefined,
      media: entry.image ? [{ type: "image", url: entry.image }] : [],
      ...extra
    };
  }

  /** Hacker News：标题即素材，描述里只有原文链接、分数和评论数。 */
  function hackerNewsItem(entry, index) {
    const summary = htmlToText(entry.summary);
    const points = Number(summary.match(/Points:\s*(\d+)/)?.[1]);
    const comments = Number(summary.match(/# Comments:\s*(\d+)/)?.[1]);
    const metrics = { rank: index + 1 };
    if (Number.isSafeInteger(points)) metrics.likes = points;
    if (Number.isSafeInteger(comments)) metrics.replies = comments;
    return articleItem(entry, {
      text: "", coverage: "title", metrics,
      note: Number.isSafeInteger(points) ? `HN ${points} 分 · ${comments || 0} 条评论` : ""
    });
  }

  /** Product Hunt：正文是一句介绍加“Discussion | Link”链接，去掉链接行。 */
  function productHuntItem(entry) {
    const lines = htmlToText(entry.content || entry.summary).split("\n").map(line => line.trim());
    const tagline = lines.filter(line => line && !["Discussion", "|", "Link"].includes(line)).join("\n");
    return articleItem(entry, { text: tagline, category: "product" });
  }

  function rssChannel({ id, name, url, host, category, declared = false, intervalMinutes = 30, maxItems = 30, maxBytes, map }) {
    register({
      id, name, category, intervalMinutes, maxItems, maxBytes, url, format: "text",
      origins: [`https://${host}/*`], hosts: [host],
      parse: body => parseFeed(body, maxItems).map((entry, index) => {
        const item = map ? map(entry, index) : articleItem(entry);
        return declared ? { category, ...item } : item;
      })
    });
  }

  rssChannel({ id: "openai-news", name: "OpenAI News", url: "https://openai.com/news/rss.xml", host: "openai.com",
    category: "ai", declared: true, intervalMinutes: 60, maxBytes: 3 * 1024 * 1024 });
  rssChannel({ id: "google-ai", name: "Google AI", url: "https://blog.google/innovation-and-ai/technology/ai/rss/", host: "blog.google",
    category: "ai", declared: true, intervalMinutes: 60 });
  rssChannel({ id: "qbitai", name: "量子位", url: "https://www.qbitai.com/feed", host: "www.qbitai.com", category: "ai", declared: true });
  rssChannel({ id: "ithome", name: "IT之家", url: "https://www.ithome.com/rss/", host: "www.ithome.com", category: "tech" });
  rssChannel({ id: "hacker-news", name: "Hacker News", url: "https://hnrss.org/frontpage", host: "hnrss.org", category: "tech", map: hackerNewsItem });
  rssChannel({ id: "product-hunt", name: "Product Hunt", url: "https://www.producthunt.com/feed", host: "www.producthunt.com",
    category: "product", intervalMinutes: 60, map: productHuntItem });
})();
