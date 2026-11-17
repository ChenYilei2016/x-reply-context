// X 帖子的加权字数与首屏折叠位置，口径对齐 twitter-text v3 配置：
// 码点 0～4351 及几段常用标点按 1 计，其余（中日韩文字等）按 2 计；一个 emoji（含组合序列）按 2 计；
// 链接无论长短按 23 计（X 会转成 t.co 短链）。正文先做 NFC 规范化。
// 已知差异：不带 http(s):// 或 www. 前缀的裸域名（如 example.com）这里按普通文字计，X 会按链接计 23。
(() => {
  "use strict";

  const SCALE = 100;
  const DEFAULT_WEIGHT = 200;
  const LIGHT_RANGES = Object.freeze([[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]]);
  const URL_WEIGHT = 23 * SCALE;
  const EMOJI_WEIGHT = 2 * SCALE;
  const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'，。！？、；：（）【】《》「」]+/giu;
  const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

  /** 非 Premium 帖子的上限，也是时间线首屏（“显示更多”之前）大约能展示的长度。 */
  const STANDARD_LIMIT = 280;
  /** Premium 长帖上限。 */
  const PREMIUM_LIMIT = 25000;
  const FOLD_LIMIT = STANDARD_LIMIT;

  const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

  function codePointWeight(codePoint) {
    return LIGHT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end) ? SCALE : DEFAULT_WEIGHT;
  }

  function graphemeWeight(grapheme) {
    if (EMOJI_PATTERN.test(grapheme)) return EMOJI_WEIGHT;
    let weight = 0;
    for (const character of grapheme) weight += codePointWeight(character.codePointAt(0));
    return weight;
  }

  /**
   * 把正文切成计数单元：链接整体一个单元，其余按字素（用户看到的一个字符）切分。
   * @returns {{ start: number, end: number, weight: number }[]} start/end 为规范化后字符串的下标
   */
  function units(text) {
    const result = [];
    let cursor = 0;
    const pushGraphemes = (from, to) => {
      for (const { segment, index } of segmenter.segment(text.slice(from, to))) {
        result.push({ start: from + index, end: from + index + segment.length, weight: graphemeWeight(segment) });
      }
    };
    for (const match of text.matchAll(URL_PATTERN)) {
      pushGraphemes(cursor, match.index);
      result.push({ start: match.index, end: match.index + match[0].length, weight: URL_WEIGHT });
      cursor = match.index + match[0].length;
    }
    pushGraphemes(cursor, text.length);
    return result;
  }

  const normalize = text => String(text ?? "").normalize("NFC");

  /** 加权字数（与 X 编辑框的计数一致，半角字符为 1）。 */
  function weightedLength(text) {
    return units(normalize(text)).reduce((sum, unit) => sum + unit.weight, 0) / SCALE;
  }

  /**
   * 首屏折叠位置：返回规范化文本中最后一个仍在首屏内的单元结束下标；全文都在首屏内时返回 null。
   * 链接等不可拆分的单元跨过标线时，整体算到标线之后。
   */
  function foldIndex(text, limit = FOLD_LIMIT) {
    const value = normalize(text);
    let total = 0;
    for (const unit of units(value)) {
      if (total + unit.weight > limit * SCALE) return unit.start;
      total += unit.weight;
    }
    return null;
  }

  /** 编辑区用的计数摘要。 */
  function measure(text) {
    const value = normalize(text);
    const length = weightedLength(value);
    const fold = foldIndex(value);
    return {
      text: value, length, fold,
      folded: fold !== null,
      overPremium: length > PREMIUM_LIMIT,
      overStandard: length > STANDARD_LIMIT
    };
  }

  globalThis.XReplyXText = Object.freeze({ weightedLength, foldIndex, measure, STANDARD_LIMIT, PREMIUM_LIMIT, FOLD_LIMIT });
})();
