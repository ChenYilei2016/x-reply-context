// 读取用户粘贴的文章链接（写作台页面侧）：一次授权所有 HTTPS 网站后直接请求，提取标题与正文。
// 只在用户点击生成或找角度时读取；不带 Cookie，限制大小与时长。X 帖子链接不在这里读取（需要登录）。
(() => {
  "use strict";

  const PERMISSION = Object.freeze({ origins: ["https://*/*"] });
  const MAX_BYTES = 3 * 1024 * 1024;
  const TIMEOUT = 15000;
  const TEXT_LIMIT = 10000;
  const NOISE = "script,style,noscript,template,nav,header,footer,aside,form,iframe,svg,button,figure figcaption,[aria-hidden=true],.ad,.ads,.advert,.comment,.comments,.share,.related";
  const CONTAINERS = ["article", "main", "[role=main]", "[itemprop=articleBody]", ".article-content", ".post-content", ".entry-content", "#content", ".content"];

  const hasPermission = () => chrome.permissions.contains(PERMISSION);
  /** 必须在用户点击的处理函数里调用（浏览器要求用户手势）。 */
  const requestPermission = () => chrome.permissions.request(PERMISSION);

  const meta = (doc, ...names) => {
    for (const name of names) {
      const value = doc.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute("content")?.trim();
      if (value) return value;
    }
    return "";
  };

  const blockText = node => node.textContent.replace(/\s+/g, " ").trim();

  /** 容器内的段落文本（p、标题、列表项），过短的导航性碎片丢掉。 */
  function paragraphs(container) {
    return [...container.querySelectorAll("p,h2,h3,li,blockquote,pre")]
      .filter(node => !node.parentElement.closest("li,blockquote") || node.matches("p"))
      .map(blockText).filter(text => text.length >= 8);
  }

  /**
   * 从网页文档提取文章（纯 DOM，可在检查页测试）。
   * @returns {{ title, text, publishedAt }} 正文按段落用换行连接，最多 10000 字
   */
  function extract(doc) {
    const title = meta(doc, "og:title", "twitter:title") || doc.querySelector("h1")?.textContent.trim() || doc.title.trim();
    const published = Date.parse(meta(doc, "article:published_time", "og:published_time", "pubdate", "publishdate") ||
      doc.querySelector("time[datetime]")?.getAttribute("datetime") || "");
    for (const node of doc.querySelectorAll(NOISE)) node.remove();
    const candidates = CONTAINERS.flatMap(selector => [...doc.querySelectorAll(selector)]);
    let best = [];
    for (const container of candidates.length ? candidates : [doc.body]) {
      const parts = paragraphs(container);
      if (parts.join("").length > best.join("").length) best = parts;
    }
    if (best.join("").length < 200) {
      const fallback = paragraphs(doc.body);
      if (fallback.join("").length > best.join("").length) best = fallback;
    }
    const text = (best.length ? best.join("\n") : meta(doc, "og:description", "description")).slice(0, TEXT_LIMIT);
    return { title: title.slice(0, 300), text, publishedAt: Number.isFinite(published) ? published : null };
  }

  /** 按 Content-Type 或页面 meta 声明的编码解码（国内站点常见 GBK）。 */
  function decode(buffer, contentType) {
    const head = new TextDecoder("latin1").decode(buffer.slice(0, 4096));
    const charset = contentType.match(/charset=([\w-]+)/i)?.[1] || head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || "utf-8";
    try { return new TextDecoder(charset).decode(buffer); } catch { return new TextDecoder("utf-8").decode(buffer); }
  }

  async function readBody(response) {
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("网页太大，请粘贴正文。");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { void reader.cancel(); throw new Error("网页太大，请粘贴正文。"); }
      chunks.push(value);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  }

  /**
   * 读取一个 HTTPS 链接为文章素材（字段与 XReplyComposePrompt.toPromptMaterial 的结果一致）。
   * @throws 中文错误：非 HTTPS、未授权、超时、不是网页、没有正文
   */
  async function read(url) {
    let target;
    try { target = new URL(url); } catch { throw new Error("链接格式不对。"); }
    if (target.protocol !== "https:") throw new Error("只能读取 HTTPS 链接。");
    if (!await hasPermission()) throw new Error("还没有授权读取网页。");
    let response;
    try {
      response = await fetch(target.href, { credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(TIMEOUT) });
    } catch (error) {
      throw new Error(error?.name === "TimeoutError" ? "读取超时（15 秒）。" : "无法打开这个链接。");
    }
    if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}。`);
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(contentType)) throw new Error("这不是网页（可能是图片或文件）。");
    const html = decode(await readBody(response), contentType);
    const article = extract(new DOMParser().parseFromString(html, "text/html"));
    if (!article.title && article.text.length < 40) throw new Error("没读到正文，可能需要登录或由脚本加载，请粘贴正文。");
    const finalUrl = new URL(response.url || target.href);
    return {
      kind: "article", title: article.title, text: article.text, url: finalUrl.href, source: finalUrl.hostname.replace(/^www\./, ""),
      coverage: globalThis.XReplySourceInput.coverageOf(article.text), publishedAt: article.publishedAt, author: ""
    };
  }

  globalThis.XReplyLinkReader = Object.freeze({ PERMISSION, hasPermission, requestPermission, extract, decode, read });
})();
