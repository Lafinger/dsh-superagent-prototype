# 文档索引

## 接口（对外）

| 文档 | 用途 |
|---|---|
| [局域网-工时接口.md](局域网-工时接口.md) | 工时接口的局域网调用说明（Base URL、端点、v2 响应）|
| [局域网-项目创建接口.md](局域网-项目创建接口.md) | 项目创建 / 查询 / 删除 / 对齐 / 读群成员 / 维护协作者 |
| [工时接口文档.md](工时接口文档.md) | 工时接口完整开发文档（字段来源、示例、错误码）|
| [项目创建接口文档.md](项目创建接口文档.md) | 项目创建接口完整开发文档 |

## 设计

| 文档 | 内容 |
|---|---|
| [设计-工时统计.md](设计-工时统计.md) | 工时（交付时长）v3.1：B1–B4 四个时刻、三段时长、管理岗 coordination |
| [工时功能字段数据来源.md](工时功能字段数据来源.md) | 每个字段的取数位置（GitHub / SQLite / 计算）|
| [design-feishu-file-attachment.md](design-feishu-file-attachment.md) | 飞书文件附件处理设计（格式矩阵、方案对比）|
| [design-github-project-worker.md](design-github-project-worker.md) | GitHub 项目工人设计 |
| [research-feishu-attachment-options.md](research-feishu-attachment-options.md) | 附件处理方案调研 |

## 环境与账号

| 文档 | 内容 |
|---|---|
| [bot-github-account-setup.md](bot-github-account-setup.md) | 机器人 GitHub 账号配置 |
| [github-app-setup.md](github-app-setup.md) | GitHub App 配置 |

## 客户需求（测试材料）

| 文档 | 内容 |
|---|---|
| [计数器重置功能需求v1.0.md](测试材料/计数器重置功能需求v1.0.md) | 访问计数器「重置」功能（5 个工作日内的 2 天需求）|
| [数字人POC知识库功能需求说明v1.0.md](测试材料/数字人POC知识库功能需求说明v1.0.md) | 数字人 POC 增加知识库（CSV 导入）|
| [数字人语音交互演示程序POC需求说明v1.0.md](测试材料/数字人语音交互演示程序POC需求说明v1.0.md) | 数字人语音交互 POC 需求 |
| [南航智慧出行数字人POC需求文档v1.3.docx](测试材料/南航智慧出行数字人POC需求文档v1.3.docx) | 客户原始需求（Word）|

> 本目录随插件仓库一起版本化，便于评审与交付追溯；私密配置（`.env`、`defaults.env`）不在其中。
