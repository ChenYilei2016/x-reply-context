// 中文友好的文本相似度：按双字（相邻两个字符）计数比较，忽略链接、空白、标点和大小写。
// 用于已发帖子与草稿的匹配（对称的 Dice 系数），以及改写稿与原文的重合度（单向包含度）。
(() => {
  "use strict";

  /** 比较用的正文：去链接、空白、标点，统一全半角与大小写，只留文字和数字。 */
  function normalize(text) {
    return String(text ?? "").normalize("NFKC").replace(/https?:\/\/\S+/gi, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }

  function bigrams(text) {
    const counts = new Map();
    for (let index = 0; index < text.length - 1; index++) {
      const gram = text.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    return counts;
  }

  function shared(left, right) {
    let total = 0;
    for (const [gram, count] of left) total += Math.min(count, right.get(gram) || 0);
    return total;
  }

  /** Dice 系数，0～1；两段规范化后相同为 1。 */
  function similarity(a, b) {
    const left = normalize(a), right = normalize(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.length < 2 || right.length < 2) return 0;
    return (2 * shared(bigrams(left), bigrams(right))) / (left.length - 1 + right.length - 1);
  }

  /** 包含度：text 的双字有多少比例出现在 source 中，0～1。衡量“text 照搬了 source 多少”，不受两者长短差异影响。 */
  function containment(text, source) {
    const left = normalize(text), right = normalize(source);
    if (left.length < 2 || right.length < 2) return 0;
    return shared(bigrams(left), bigrams(right)) / (left.length - 1);
  }

  globalThis.XReplyTextSimilarity = Object.freeze({ normalize, similarity, containment });
})();
