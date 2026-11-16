// GitHub Trending：官方没有 RSS，解析公开网页。页面结构变化时整渠道报错，不产出残缺条目。
(() => {
  "use strict";

  const { htmlToText } = globalThis.XReplyFeedParser;
  const { MaterialCategory } = globalThis.XReplyMaterialModel;
  const { register } = globalThis.XReplyChannels;

  const toNumber = value => value ? Number(value.replaceAll(",", "")) : undefined;

  function repositoryItem(block, index) {
    const path = block.match(/<h2\b[^>]*>\s*<a\b[^>]*\shref="\/([\w.-]+\/[\w.-]+)"/)?.[1];
    if (!path) return null;
    const description = htmlToText(block.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/)?.[1] || "");
    const language = block.match(/itemprop="programmingLanguage">([^<]+)</)?.[1]?.trim();
    const stars = toNumber(block.match(/\/stargazers"[^>]*>[\s\S]*?<\/svg>\s*([\d,]+)\s*<\/a>/)?.[1]);
    const today = toNumber(block.match(/([\d,]+)\s+stars?\s+today/)?.[1]);
    const metrics = { rank: index + 1 };
    if (Number.isSafeInteger(stars)) metrics.stars = stars;
    const tags = [language, MaterialCategory.classify(`${path}\n${description}`) === MaterialCategory.AI ? "AI" : ""].filter(Boolean);
    return {
      id: `https://github.com/${path}`, kind: "article", category: "open_source",
      url: `https://github.com/${path}`, title: path.replace("/", " / "), text: description,
      metrics, tags, note: Number.isSafeInteger(today) ? `今日 +${today} star` : ""
    };
  }

  function trendingItems(html) {
    const blocks = html.match(/<article class="Box-row">[\s\S]*?<\/article>/g);
    if (!blocks?.length) throw new Error("GitHub Trending 页面结构已变化");
    return blocks.map(repositoryItem).filter(Boolean);
  }

  register({
    id: "github-trending", name: "GitHub Trending", category: "open_source", intervalMinutes: 120, maxItems: 25,
    url: "https://github.com/trending", format: "text",
    origins: ["https://github.com/*"], hosts: ["github.com"], parse: trendingItems
  });
})();
