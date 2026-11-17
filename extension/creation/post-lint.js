// 帖子正文自查：在本地找出模型常见的问题，提示用户修改或交给「精修 · 修掉问题」。
// 只做提示，不拦截发布：这些写法偶尔也有合理用法（例如帖子本身在聊“素材”）。
(() => {
  "use strict";

  const MATCH_LIMIT = 3;

  /** 用若干正则找出命中的原文片段（去重，最多 3 个）。 */
  function finder(patterns) {
    return text => {
      const found = new Set();
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          found.add(match[0]);
          if (found.size >= MATCH_LIMIT) return [...found];
        }
      }
      return [...found];
    };
  }

  /** 引用转发时读者能看到被引用的帖子，“原帖”“这条”是正常说法。 */
  const META_PATTERNS = [/素材/g, /资料(?:显示|称|中|里|提到|表明|来看)/g, /原文(?:称|说|提到|中|里|指出)?/g, /该文|此文|这篇文章|文章(?:称|提到|指出)/g,
    /(?:发布)?时间(?:未知|不详|不明)/g, /来源(?:未知|不明|不详)/g, /[（(【[]\s*[MR]\d{1,2}\s*[)）】\]]/g];
  const findMeta = finder(META_PATTERNS);
  const findSourcePost = finder([/原帖/g]);

  const LintRule = Object.freeze([
    {
      id: "meta", label: "提到了资料本身", tip: "读者看不到给 AI 的资料，改成直接陈述，或写明真实出处",
      find: (text, { quotes }) => [...findMeta(text), ...(quotes ? [] : findSourcePost(text))].slice(0, MATCH_LIMIT)
    },
    {
      id: "cliche", label: "AI 套话", tip: "删掉，或换成具体信息",
      find: finder([/值得(?:注意|一提)的是/g, /总而言之|综上所述|总的来说|总之/g, /不仅仅?是.{1,20}(?:更是|而是)/g, /毋庸置疑|不可否认|显而易见/g,
        /在这个.{1,12}的时代/g, /随着.{1,16}的(?:发展|到来|普及)/g, /让我们/g, /赋能|颠覆性?|深度解析|一起来看看/g])
    },
    { id: "hype", label: "营销腔", tip: "换成平实的说法", find: finder([/家人们|震惊|重磅|炸裂|史诗级|王炸|绝绝子|yyds/gi]) },
    { id: "dash", label: "破折号", tip: "AI 常用破折号转折，改成逗号或句号", find: finder([/——|—/g]) },
    {
      id: "hashtags", label: "话题标签超过 1 个", tip: "只留最相关的一个",
      find: text => { const tags = text.match(/(?:^|\s)#[^\s#]+/g) || []; return tags.length > 1 ? tags.map(tag => tag.trim()).slice(0, MATCH_LIMIT) : []; }
    }
  ].map(rule => Object.freeze(rule)));

  /**
   * 检查正文。
   * @param options.quotes 是否为引用转发（读者能看到被引用的帖子）
   * @returns [{ id, label, tip, matches: string[] }]，没有问题时为空数组
   */
  function check(text, { quotes = false } = {}) {
    if (typeof text !== "string" || !text.trim()) return [];
    return LintRule.map(rule => ({ id: rule.id, label: rule.label, tip: rule.tip, matches: rule.find(text, { quotes }) }))
      .filter(issue => issue.matches.length);
  }

  /** 交给「修掉问题」的说明：每条一行，带命中的片段。 */
  const describe = issues => issues.map(issue => `${issue.label}（${issue.matches.map(match => `“${match}”`).join("、")}）：${issue.tip}`);

  globalThis.XReplyPostLint = Object.freeze({ LintRule, check, describe });
})();
