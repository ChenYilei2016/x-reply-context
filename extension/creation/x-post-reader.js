// 从 X 页面上的一条帖子（article[data-testid="tweet"]）读出素材字段。
// 只在用户点击「改写」「选入」时调用；纯 DOM 读取，不发请求。引用帖（帖子内嵌的另一条帖子）不计入。
(() => {
  "use strict";

  /** 引用帖在帖子内是一个可点击的 div[role="link"]（作者、时间等链接是 a 元素，不受影响）。 */
  const QUOTE = 'div[role="link"]';
  const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/|$)/;

  /** 操作栏 aria-label 的指标关键词（中文、英文界面）。 */
  const METRIC_WORDS = Object.freeze([
    ["replies", /回复|repl(?:y|ies)/i], ["reposts", /转帖|转推|repost|retweet/i], ["quotes", /引用|quote/i],
    ["likes", /喜欢|赞|like/i], ["bookmarks", /书签|bookmark/i], ["views", /观看|查看|浏览|view/i]
  ]);
  const UNITS = Object.freeze({ 万: 1e4, 亿: 1e8, k: 1e3, m: 1e6, b: 1e9 });

  /** 属于本帖（不在引用帖里）的第一个匹配元素。 */
  function own(article, selector) {
    return [...article.querySelectorAll(selector)].find(node => !node.closest(QUOTE)) || null;
  }

  /** 正文：保留换行、emoji（图片 alt）；链接用显示文字，去掉 X 加的省略号。 */
  function textOf(node) {
    let text = "";
    const walk = current => {
      for (const child of current.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue;
        else if (child.nodeName === "IMG") text += child.getAttribute("alt") || "";
        else if (child.nodeName === "BR") text += "\n";
        else if (child.nodeName === "A" && /^https?:\/\//.test(child.getAttribute("href") || "") && !/^[@#$]/.test(child.textContent)) {
          text += child.textContent.replace(/…$/, "");
        } else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
      }
    };
    walk(node);
    return text.replace(/ /g, " ").trim();
  }

  /** "1.2万" "250K" "7,890" → 数字；无法识别返回 undefined。 */
  function parseCount(value) {
    // 单位字母后面不能紧跟字母，避免把 “900 bookmarks” 的 b 当成十亿。
    const match = String(value).replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([万亿]|[kmb](?![a-z]))?/i);
    if (!match) return undefined;
    const unit = match[2];
    return Math.round(Number(match[1]) * (unit ? UNITS[unit] ?? UNITS[unit.toLowerCase()] : 1));
  }

  /** 解析操作栏的 aria-label，例如“12 条回复、34 次转帖、567 次喜欢、25万 次观看”或 “12 replies, 34 reposts, 567 likes, 250K views”。 */
  function parseMetrics(label) {
    const metrics = {};
    // 英文以“逗号 + 空格”分隔各项，数字里的千分位逗号后面没有空格。
    for (const part of String(label || "").split(/[，、;；]|,\s/)) {
      const entry = METRIC_WORDS.find(([, pattern]) => pattern.test(part));
      const value = entry && parseCount(part);
      if (entry && value !== undefined && metrics[entry[0]] === undefined) metrics[entry[0]] = value;
    }
    return metrics;
  }

  function postLink(article) {
    for (const time of article.querySelectorAll("time")) {
      if (time.closest(QUOTE)) continue;
      const anchor = time.closest("a[href]");
      const match = anchor && new URL(anchor.getAttribute("href"), location.origin).pathname.match(STATUS_PATH);
      if (match) return { handle: match[1], id: match[2], publishedAt: time.getAttribute("datetime") };
    }
    return null;
  }

  function authorName(article, handle) {
    const names = own(article, '[data-testid="User-Name"]');
    const link = names && [...names.querySelectorAll("a[href]")].find(anchor => !textOf(anchor).startsWith("@"));
    const name = link ? textOf(link) : "";
    return name && name !== `@${handle}` ? name : "";
  }

  function media(article) {
    const items = [];
    for (const image of article.querySelectorAll('[data-testid="tweetPhoto"] img[src^="https://"]')) {
      if (!image.closest(QUOTE)) items.push({ type: "image", url: image.src });
    }
    for (const video of article.querySelectorAll("video")) {
      if (!video.closest(QUOTE)) items.push({ type: "video", url: video.poster || video.src });
    }
    return items.filter(item => /^https:\/\//.test(item.url)).slice(0, 4);
  }

  /**
   * 读取一条帖子。
   * @returns xrc.feed/v1 条目（交给素材模型归一化）；读不到帖子链接或正文时返回 null
   */
  function read(article) {
    const link = postLink(article);
    const body = own(article, '[data-testid="tweetText"]');
    const text = body ? textOf(body) : "";
    if (!link || !text) return null;
    const truncated = Boolean(own(article, '[data-testid="tweet-text-show-more-link"]'));
    const group = own(article, '[role="group"][aria-label]');
    const metrics = parseMetrics(group?.getAttribute("aria-label"));
    return {
      id: `x:${link.id}`, kind: "x_post", url: `https://x.com/${link.handle}/status/${link.id}`,
      text, coverage: truncated ? "excerpt" : "full", lang: body.getAttribute("lang") || "",
      publishedAt: link.publishedAt || undefined,
      author: { handle: link.handle, name: authorName(article, link.handle) },
      metrics: Object.keys(metrics).length ? { ...metrics, observedAt: new Date().toISOString() } : undefined,
      media: media(article)
    };
  }

  globalThis.XReplyXPostReader = Object.freeze({ read, parseMetrics, parseCount, textOf });
})();
