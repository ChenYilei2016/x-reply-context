<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="回过了：评论点赞下条与伴随主页，把时间留给聊天。">
</p>

# 回过了 · X 通知助手

**回过、点过，一眼看清；少点几次，把时间留给聊天。**

一个 Chrome 扩展，帮你看清互动记录、逐条处理回复。写好后可以「评论点赞下条」，也可以打开「伴随主页」看看对方的帖子，原来的通知和草稿留在原处。

**当前版本 0.37.9** · Chrome 111+ · Manifest V3 · 本地存储 · 无运行依赖

[**下载安装包**](dist/x-reply-context-0.37.9.zip) · [快速安装](#快速安装) · [功能一览](#功能一览) · [更新日志](CHANGELOG.md) · [反馈问题](https://github.com/ChenYilei2016/x-reply-context/issues)

*A Chrome extension for X interaction context, user-confirmed reply-then-like, and a reusable native profile window.*

> 默认由你决定并确认发送；开启可选定时触发并点击“开始本轮”后，会自动发送已填好的草稿。可单独点赞，也可点击「评论点赞下条」先发后赞。快捷短语仅由你主动点击或按快捷键填入，不自动发送或点赞。网页脚本接入存在平台规范及账号处置风险，使用前请阅读 [使用建议与平台风险](docs/guide/privacy-and-limits.md#使用建议与平台风险)。

## 功能一览

| 能力 | 用途 | 说明 |
| --- | --- | --- |
| **选题雷达 / 素材渠道** | 你的 bot、AI 一手动态、科技新闻、热榜等 10 个渠道自动汇集素材，同一事件合并成话题，按账号定位综合排序 | [详情](docs/guide/creation.md) |
| **一键改写** | X 帖子下方「改写」「选入」，点击时才读取那一条；5 种改写风格、按原文长度、英文本地化、多篇融合，3 个候选并提示与原文的重合度 | [详情](docs/guide/creation.md#一键改写-x-上的爆款0310) |
| **对标风格** | 选一位博主的 3～10 条帖子，AI 拆解出选题、开头手法、结构和语气，存成模板，改写和成稿时一键套用 | [详情](docs/guide/creation.md#对标风格0320) |
| **AI 配图** | 8 种风格、3 种比例；成稿模型按正文写出图提示词（可改），再用你的 OpenAI 兼容出图 API 生成，可下载或复制 | [详情](docs/guide/creation.md#ai-配图0330) |
| **写作台** | 左右两栏：直接粘贴正文或链接（自动读取正文）、也可用已选素材；AI 改写或找角度写，3 个候选卡片对比，正文自查与一键精修，加权字数与首屏标线，写作要求可改，一键生图 | [详情](docs/guide/creation.md#写作台0350-起为左右两栏) |
| **草稿与复盘** | 一键打开预填好的 X 发帖页；bot 带回自己的帖子后自动标为已发，按角度和形态统计浏览与点赞，好帖子反哺写作样本 | [详情](docs/guide/creation.md#草稿与复盘0300) |
| **评论点赞下条 / 伴随主页 / 连续回复** | 写好回复后一键发送、点赞并打开下一条；可选定时触发 | [详情](docs/guide/replies.md) |
| **通知标签与筛选** | 原帖归属、已回 / 已点、双方互动次数；点赞、关注、转发分别过滤 | [详情](docs/guide/notifications.md) |
| **互动分析** | 按人对照「我评他 / 他评我」，管理跳过名单与白名单 | [详情](docs/guide/interaction-report.md) |
| **内置 AI 回复** | 自带 API 的推荐评论、改写、二次润色和快捷短语 | [详情](docs/guide/ai-replies.md) |
| **关注列表筛选 / 视频下载** | 按粉丝数和关粉差筛选；下载帖子视频 | [详情](docs/guide/tools.md) |
| **数据、隐私与限制** | 本地存储、权限说明、兼容性与平台风险 | [详情](docs/guide/privacy-and-limits.md) |

## 快速安装

1. 下载并解压 [0.37.9 安装包](dist/x-reply-context-0.37.9.zip)。也可用 **Code → Download ZIP** 下载源码。
2. 在 Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」：安装包选择包含 `manifest.json` 的文件夹；源码选择 **`extension/`**。
4. 完整刷新已打开的 X 页面。建议将「回过了」固定到工具栏，方便调整筛选开关。

安装无需 Node.js、API Key 或额外账号，照常登录 X 即可。

**升级**：先保存草稿并关闭伴随窗口 → 覆盖原扩展目录 → 在扩展管理页重新加载 → 完整刷新所有 X 标签页。只在站内切换主页/通知不够；沿用原目录，避免先卸载导致记录丢失。

<details>
<summary>从 0.15.0 之前的版本升级</summary>

0.21.0 首次读取会先在独立备份存储保留旧 IndexedDB 记录及可用的旧 local 快照，再迁移互动事实和人物汇总；备份失败不升级，迁移失败保留旧数据供重试。迁移只执行一次，满量模拟约4秒。扩展弹窗可打开「导出升级前备份／统计说明」下载本机 JSON。数据库已升级，旧版扩展不能直接读取新版库，请保留备份并避免直接降级。

</details>

## 本地开发

需要 **Node.js 22+**，无 npm 依赖，无需执行 `npm install`。

```sh
npm test                 # 核心逻辑与请求回执检查
npm run check:browser    # 无头 Chrome 运行 IndexedDB 等浏览器检查
npm run check:extension  # 无头 Chrome 真实加载扩展做冒烟检查
npm run preview          # 虚构数据演示，不连接 X 账号
npm run package          # 生成 dist/ 安装包；需系统 zip / unzip
```

演示入口：`http://127.0.0.1:5818/notifications`、`http://127.0.0.1:5818/home`。

<details>
<summary>代码目录</summary>

```text
extension/
  core.js                  数据归一化、原帖归属与互动统计
  observe.js               页面响应与成功回执观察
  notification-network.js  通知过滤、游标与空批暂停
  storage.js               IndexedDB 备份、迁移与增量保存
  interaction-ledger.js     独立互动事实、去重和人物汇总
  backup.html / backup.js   升级前备份导出（仅本机）
  background.js            消息分派、串行合并与持久化
  companion.js             按需创建、复用和清理伴随窗口
  content.*                通知标签与布局
  continuous.js            连续回复、草稿和原帖摘要
  home-filter.js           主页完成项筛选
  card-filter.js           列表折叠与异步校验
  notification-filter.js   通知整理与空闲调度
  popup.*                  设置、总览与历史入口
  creation/                创作工作台：素材模型与库、渠道适配与调度、话题聚合、选题雷达、渠道页、角度与成稿、写作台、草稿与复盘
tests/                     逻辑、虚构页面和布局检查
scripts/                   预览、打包、浏览器检查与本机 feed 服务
assets/readme/             首页展示素材
```

</details>

## 更新记录

查看 [CHANGELOG](CHANGELOG.md) 了解各版本变化；每个版本均链接到对应的验证记录。历史截图和检查结果保留，演示截图不作为真实发送成功的证据。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/ChenYilei2016/x-reply-context/issues) 反馈。请说明 Chrome / 扩展版本、入口、预期和实际结果；截图请遮去账号信息，勿提交 Cookie、访问令牌或完整个人缓存。

修改逻辑后运行 `npm test`，界面改动可使用本地演示页的现有检查。请把 PR 聚焦在具体问题上。

**许可证**：仓库当前尚未设置 `LICENSE`，具体开源许可待维护者确认。
