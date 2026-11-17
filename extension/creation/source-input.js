// 写作台「基于内容」输入框的解析：拆出正文与链接（最多 3 个），识别 X 帖子链接。纯函数。
(() => {
  "use strict";

  const LINK_LIMIT = 3;
  const TEXT_LIMIT = 10000;
  /** 链接到空白或中文标点为止；末尾的英文标点（句号、逗号、右括号）不算链接。 */
  const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？、；：（）【】《》「」]+/gi;
  const X_POST = /^https:\/\/(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/(\d{1,25})/i;

  const trimUrl = url => url.replace(/[.,;:!?)\]]+$/, "");

  /**
   * @returns {{ body: string, links: [{ url, xPostId }], droppedLinks: number }}
   *   body：去掉“整行只有链接”的行后的正文（行内链接保留在正文里）；links：去重后的链接
   */
  function parse(text) {
    const value = String(text ?? "").slice(0, TEXT_LIMIT);
    const urls = [...new Set((value.match(URL_PATTERN) || []).map(trimUrl))];
    const body = value.split("\n").filter(line => !/^\s*(?:https?:\/\/\S+\s*)+$/i.test(line)).join("\n").trim();
    const links = urls.slice(0, LINK_LIMIT).map(url => ({ url, xPostId: url.match(X_POST)?.[1] || null }));
    return { body, links, droppedLinks: Math.max(0, urls.length - LINK_LIMIT) };
  }

  /** 正文长度对应的完整度：太短只当标题或事件。 */
  const coverageOf = text => text.length >= 300 ? "full" : text.length >= 40 ? "excerpt" : "title";

  globalThis.XReplySourceInput = Object.freeze({ parse, coverageOf, LINK_LIMIT, TEXT_LIMIT });
})();
