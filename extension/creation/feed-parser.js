// 纯 JS 的 RSS 2.0 / Atom 解析与 HTML 转文本。
// 扩展后台是 Service Worker，没有 DOMParser，因此不依赖 DOM；只处理渠道需要的字段。
(() => {
  "use strict";

  const NAMED_ENTITIES = Object.freeze({
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", copy: "©", reg: "®", trade: "™"
  });

  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === "#") {
        const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    });
  }

  /** HTML 片段转纯文本：去掉脚本样式，块级元素换行，合并空白。 */
  function htmlToText(html, limit = Infinity) {
    const text = html
      .replace(/<(script|style|noscript|iframe|svg)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    return decodeEntities(text)
      .replace(/[ \t\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, limit);
  }

  const escapeName = name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** 读取元素内的原始内容（未解码），按给定的限定名顺序取第一个存在的。 */
  function elementInner(block, names) {
    for (const name of names) {
      const match = block.match(new RegExp(`<${escapeName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeName(name)}>`, "i"));
      if (match) return match[1];
    }
    return "";
  }

  /** CDATA 原样返回，其余内容做实体解码。结果可能仍是 HTML。 */
  function elementValue(block, names) {
    const inner = elementInner(block, names);
    const parts = inner.split(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return parts.map((part, index) => index % 2 ? part : decodeEntities(part)).join("").trim();
  }

  function attribute(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    return match ? decodeEntities(match[2] ?? match[3]) : "";
  }

  /** RSS 用 <link>文本</link>；Atom 用 <link rel="alternate" href="…"/>，优先 alternate。 */
  function entryLink(block) {
    const tags = block.match(/<link\b[^>]*>/gi) || [];
    const atomLinks = tags.map(tag => ({ rel: attribute(tag, "rel") || "alternate", href: attribute(tag, "href") })).filter(link => link.href);
    const alternate = atomLinks.find(link => link.rel === "alternate");
    if (alternate) return alternate.href;
    return elementValue(block, ["link"]) || elementValue(block, ["guid"]);
  }

  function entryImage(block) {
    for (const tag of block.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/gi) || []) {
      const type = attribute(tag, "type");
      const medium = attribute(tag, "medium");
      if (medium === "image" || type.startsWith("image/") || /^<media:thumbnail/i.test(tag)) return attribute(tag, "url");
    }
    return "";
  }

  /**
   * 解析 RSS / Atom，返回最多 limit 条。
   * @returns {{title, link, summary, content, published, author, categories, image}[]}
   */
  function parseFeed(xml, limit = 50) {
    if (typeof xml !== "string" || !/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error("返回内容不是 RSS 或 Atom");
    const source = xml.replace(/<!--[\s\S]*?-->/g, "");
    const entries = [];
    const pattern = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    for (let match; entries.length < limit && (match = pattern.exec(source));) {
      const block = match[2];
      entries.push({
        title: htmlToText(elementValue(block, ["title"])),
        link: entryLink(block).trim(),
        summary: elementValue(block, ["description", "summary"]),
        content: elementValue(block, ["content:encoded", "content"]),
        published: elementValue(block, ["pubDate", "published", "dc:date", "updated"]),
        author: htmlToText(elementValue(block, ["dc:creator", "author"])),
        categories: [...block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)]
          .map(item => htmlToText(item[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))).filter(Boolean),
        image: entryImage(block)
      });
    }
    return entries;
  }

  globalThis.XReplyFeedParser = Object.freeze({ parseFeed, htmlToText, decodeEntities });
})();
