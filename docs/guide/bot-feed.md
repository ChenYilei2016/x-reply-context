# 接入你的 bot（本机 feed）

[← 返回创作工作台](creation.md)

任何 bot、agent 或脚本，只要按下面的约定输出 `feed.json`，就能成为创作工作台的素材渠道。扩展每 15 分钟读取一次，按 `id` 去重合并；bot 离线时渠道显示失败，其他渠道照常工作。

## 1. 安装本机服务（一次）

```sh
scripts/feed-service.sh install   # 开机自启，只监听 127.0.0.1:8765
scripts/feed-service.sh status    # 查看服务、feed.json 更新时间和 HTTP 检查
```

默认目录是 `~/x-reply-feed`，可用环境变量 `XRC_FEED_DIR`、`XRC_FEED_PORT` 修改；修改端口后，在「素材渠道」页填写对应地址。卸载：`scripts/feed-service.sh uninstall`（目录保留）。

然后打开扩展的「素材渠道」页，给「我的 bot」授权本机地址。

## 2. 给 bot 的输出约定

> 把这一节原样转给你的 bot。

1. 每次运行后，把结果写进 `~/x-reply-feed/feed.json`（或你指定的同步目录）。**先写 `feed.json.tmp`，写完再改名覆盖**，避免读到写了一半的文件。
2. 文件格式见下方示例，`schema` 固定为 `xrc.feed/v1`。
3. `items` 至少保留最近 48 小时或 500 条，新的在前。电脑刚开机时一次补同步也没关系，扩展会去重。
4. 同一条内容的 `id` 必须稳定：X 帖子用 `x:<帖子ID>`，其他内容用原文链接。
5. `kind` 取 `x_post`、`article`、`hot_topic` 之一；`coverage` 取 `title`、`excerpt`、`full` 之一。
6. `url` 必须是 `https://` 链接。
7. 指标只填真实读到的整数，读不到就不填，不要估算；`metrics.observedAt` 填读到数字的时间。
8. `tags` 用于分类，可选：`AI`、`科技`、`产品`、`开源`、`热点`、`娱乐`。
9. `note` 用一句中文说明为什么值得写，不超过 80 字。

示例（[bot-feed.example.json](bot-feed.example.json)，测试用例会校验它始终可用）：

```json
{
  "schema": "xrc.feed/v1",
  "channel": { "id": "grok-bot", "name": "Grok 机器人" },
  "generatedAt": "2026-11-16T12:00:00+08:00",
  "items": [
    {
      "id": "x:1890000000000000000",
      "kind": "x_post",
      "url": "https://x.com/someone/status/1890000000000000000",
      "text": "帖子原文",
      "coverage": "full",
      "lang": "zh",
      "publishedAt": "2026-11-16T09:30:00+08:00",
      "author": { "handle": "someone", "name": "某人", "followers": 12000 },
      "metrics": { "views": 250000, "likes": 3200, "reposts": 410, "replies": 180, "observedAt": "2026-11-16T11:58:00+08:00" },
      "tags": ["AI"],
      "note": "一句话说明为什么值得写"
    }
  ]
}
```

## 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 稳定标识，最长 300 字符 |
| `kind` | 是 | `x_post` / `article` / `hot_topic` |
| `url` | 是 | HTTPS 原文链接 |
| `title` / `text` | 至少一个 | 标题最长 300 字，正文超过 10000 字会截断 |
| `coverage` | 否 | 不填时按正文长度推断 |
| `publishedAt` | 否 | ISO 时间；有它和浏览量才能算流速 |
| `author` | 否 | `handle`、`name`、`followers`；有粉丝数才能算爆文倍数 |
| `metrics` | 否 | `views`、`likes`、`reposts`、`replies`、`quotes`、`bookmarks`、`rank`，非负整数 |
| `media` | 否 | 最多 4 个 `{ "type": "image" | "video" | "gif", "url": "https://…" }` |
| `tags` / `note` / `lang` | 否 | 分类标签、推荐理由、语言 |
| `own` | 否 | `true` 表示是你自己发的帖子，保留 90 天，后续用作风格样本和复盘 |

bot 报告的指标标记为「渠道报告」。同一条内容被多个渠道带来时自动合并，保留更完整的正文和更可信的指标。
