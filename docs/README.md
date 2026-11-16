# 文档目录

| 目录 | 内容 |
| --- | --- |
| [`guide/`](guide/) | 各功能的使用说明，README 的「功能一览」链接到这里 |
| [`design/`](design/) | 进行中的设计稿与任务拆分 |
| [`research/`](research/) | 选型与外部资料调研，注明调研日期与证据 |
| [`archive/`](archive/) | 已归档内容：历史版本审查记录（`reviews/`）、截图与检查结果（`evidence/`）、0.19.7 及更早的更新日志、旧版 README |

约定：

- 新功能的使用说明写进 `guide/` 对应文件；README 只保留简介、安装、功能一览和开发入口。
- 版本审查和验证证据随版本完成后放入 `archive/`，不再堆在 `docs/` 根目录。
- `dist/` 只保留当前版本安装包，`npm run package` 会自动删除旧包；历史安装包从 git 历史取回。
