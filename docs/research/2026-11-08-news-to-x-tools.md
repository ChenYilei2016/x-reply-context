# 新闻与热点转 X 推文的工具调研

调研日期为 2026-11-08（Asia/Singapore）。基于厂商官网、帮助中心、Chrome 商店、开源项目和 X 官方规则，未安装扩展、登录产品、付费或发帖。下文的发布能力为产品公开说明，实际可用性、中文成稿和网页正文提取效果仍待验证。

## 浏览器插件

| 工具 | 新闻怎么进来 | AI 草稿与发布 | 一手来源 |
| --- | --- | --- | --- |
| X Post Generator | 手动打开网页，可选中段落 | 生成多条 X 短帖草稿，支持自带 OpenAI 或 Gemini API Key，编辑后复制。商店样本较小 | [Chrome 商店](https://chromewebstore.google.com/detail/x-post-generator/idaegfdpikoibilcpopglegdclaffdok) |
| Article to Social Post（EasyPost） | 读取当前网页或选中的段落，可加自己的笔记 | 生成可编辑的 X 等平台草稿，商店列出中英文界面。付费版提及趋势与选题建议，未找到独立监测新闻源的说明 | [Chrome 商店](https://chromewebstore.google.com/detail/article-to-social-post/lecdkjhpehffkknlkekllmdfaijgoacd) |
| X Share AI Assistant | 手动打开网页。厂商称可提取正文及截图 | 自带 OpenAI、OpenRouter 或兼容接口凭证，生成后审阅，通过 X 分享入口发布。商店无评价，最近公开更新为 2025 年 6 月 | [Chrome 商店](https://chromewebstore.google.com/detail/x-share-ai-assistant/koaaieckobjniiomnjoibkfmdlahipkn) · [官网](https://x-share.iamdev.me/) |
| TwitMix | 用户在 X 内浏览并收藏帖子，可补充自己的观点 | 生成独立新帖或回复草稿，人工编辑发布。适合已有 X 素材的场景 | [Chrome 商店](https://chromewebstore.google.com/detail/twitmix-ai-tweet-remixer/elhbkkdnbaacbdbghpjoglocofhpmfao) |
| TurnThread | 官网演示在文章上右键，或手动输入选题 | 宣称可生成多条线程，逐条修改并打开 X 发布。官网安装按钮只链接至商店首页，本轮未核实可安装条目 | [官网](https://turnthread.com/) |

## 主动发现与 RSS 发稿平台

| 工具 | 发现与正文 | AI 草稿与发布 | 一手来源 |
| --- | --- | --- | --- |
| PostClaw | 厂商称主动聚合 Hacker News、Reddit、Product Hunt、YouTube、GitHub 等趋势及新闻源，支持自定义 RSS 和公开网页抓取。跨站去重和全文覆盖未验证 | 选题后按风格生成多个版本并可审阅。X 接入走 OAuth，发布功能需付费。公开演示未能验证实际草稿和发稿 | [Trend Radar](https://postclaw.fun/features/trend-radar/) · [发布与套餐说明](https://postclaw.fun/features/mcp-server/) · [X OAuth 说明](https://postclaw.fun/privacy/) |
| Xposto | 厂商称轮询用户指定的 RSS 或 URL 数据源，检测新文章后抓取、摘要并提取配图。按关键词找 X 热帖属于单独的回复功能 | 文章可生成单帖或线程，在日历中编辑排期，通过 X OAuth 发布。定价页列出的 RSS 起步档为 Pro | [官网](https://xposto.com/) · [定价与功能](https://xposto.com/pricing) |
| OpenTweet | 轮询用户配置的 RSS、Atom 或 JSON Feed。帮助中心明确 AI 输入为条目标题和描述，产品页另提及条目内容，尚未证实会回抓原网页全文 | 支持自定义提示词及审核模式，可编辑、拒绝或排期。适合来源已知、每条摘要信息足够的场景 | [RSS 帮助文档](https://opentweet.io/help/rss-connector) · [RSS 集成与审核](https://opentweet.io/integrations/rss) |
| News Studio | 内置新闻流，也可手动录入新闻。厂商称 AI 使用标题及文章内容，公开说明未明确具体新闻源范围 | 选新闻生成文案和视觉素材，可编辑并发布或排期到 X 等平台，产品面向新闻团队 | [工作流程](https://newsstudio.io/how-it-works/) |
| SocialBee | RSS 自动导入的默认形式是标题和链接预览。AI 写作有单独的链接或文本入口 | 支持 X 撰稿和排期。官方资料未证实 RSS 导入会自动回抓正文并调用 AI 改写 | [RSS 帮助](https://help.socialbee.com/hc/en-us/articles/29979191413783-How-Do-I-Add-RSS-Feeds-in-SocialBee) · [AI 写作变更日志](https://changelog.socialbee.com/use-ai-to-generate-content-256895) · [X 草稿工具](https://socialbee.com/tweet-generator/) |

## 组合方式与判断

- **手动挑文章后快速出稿**。X Post Generator 接近「当前新闻页 → 多个短帖草稿」，TwitMix 接近「当前 X 帖子 → 加自己的观点 → 独立新帖草稿」。现有「回过了」已经覆盖 X 内的阅读和互动场景，可用这两类产品对照独立发帖入口的体验。 [项目 README](../../README.md) · [X Post Generator](https://chromewebstore.google.com/detail/x-post-generator/idaegfdpikoibilcpopglegdclaffdok) · [TwitMix](https://chromewebstore.google.com/detail/twitmix-ai-tweet-remixer/elhbkkdnbaacbdbghpjoglocofhpmfao)
- **每天主动选题**。一体化 SaaS 中，PostClaw 的公开流程最接近「跨站趋势 → AI 草稿 → 人工选稿」。已有明确 RSS 来源时，Xposto 和 OpenTweet 更直接。关注中文热榜时，可用开源 TrendRadar 汇集国内平台和 RSS，或用 Inoreader 的 Google News 搜索和关键词监控找新闻，再衔接草稿工具。 [PostClaw](https://postclaw.fun/features/trend-radar/) · [Xposto](https://xposto.com/) · [OpenTweet](https://opentweet.io/rss) · [TrendRadar](https://github.com/sansan0/TrendRadar/blob/master/README.md) · [Inoreader 支持的来源](https://www.inoreader.com/help/basic/feeds-sources/what-types-of-sources-can-i-follow)
- **需要自定义筛选、去重和审稿**。n8n 可组合 RSS 触发、AI 和审核。平台模板示例覆盖新闻评分、生成 X 线程及审核，部分模板依赖 Upload-Post。也可只生成待审核草稿。 [n8n RSS Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.rssfeedreadtrigger/) · [新闻和 X 线程模板](https://n8n.io/workflows/9851-ai-powered-news-monitoring-and-social-post-generator-with-openai-and-upload-post/) · [RSS 和 Telegram 审核模板](https://n8n.io/workflows/5397-auto-generate-and-approve-social-media-posts-from-rss-feeds-with-openai-and-telegram/)
- **发稿边界**。X 官方自动化规则明确禁止使用脚本等非 API 方式自动操作 X，也禁止自动围绕 X 热点发帖或用自动化操纵热点。热点链路适合停在草稿，让人确认原文、链接和措辞后在 X 发布。 [X 自动化规则](https://help.x.com/en/rules-and-policies/x-automation)

如果继续试用，可选同一篇中文新闻和一篇英文原始公告，比较正文是否读全、数字与出处是否保留、单帖与线程是否可选，以及草稿能否方便地打开 X 编辑。公开材料暂未验证一个可安装 Chrome 插件同时具备主动跨站发现、可靠正文提取和完整的 X 发稿链路。
