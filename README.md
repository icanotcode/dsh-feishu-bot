# DeepSeek Harness 飞书机器人

**从飞书向本机 Harness 发起任务，在原消息下接收文本答复。**

[![Tests](https://github.com/icanotcode/dsh-feishu-bot/actions/workflows/test.yml/badge.svg)](https://github.com/icanotcode/dsh-feishu-bot/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js ≥22](https://img.shields.io/badge/Node.js-%E2%89%A522-339933.svg)](package.json)

简体中文 · [English](README.en.md)

[快速开始](#快速开始) · [飞书接入指南](docs/setup.md) · [常见问题](docs/troubleshooting.md) · [反馈问题](https://github.com/icanotcode/dsh-feishu-bot/issues)

## 简介

`dsh-feishu-bot` 是 DeepSeek Harness 的飞书机器人插件。在 Harness 的插件列表中启用后，即可通过设置页填写应用凭据、选择事件接收方式和任务工作目录。

插件提供 **开发者服务器（HTTP Webhook）** 和 **长连接（WebSocket）** 两种接入方式：已有公网地址或 ngrok 的用户可以使用 Webhook；只在本机运行、没有公网入口的用户可以选择长连接。保存配置后切换生效。

```text
飞书文本消息 → Webhook / 长连接 → Harness Agent → 回复原飞书消息
```

这是独立维护的社区插件，与 DeepSeek、飞书无隶属关系。当前版本为 **0.1.2**，通过本仓库源码安装；尚未发布到 npm。

## 设置界面

![飞书插件设置界面](assets/settings-webhook.png)

实际设置界面，拍摄于独立演示环境，未填写应用凭据。

## 当前能力

| 能力 | 当前行为 |
| --- | --- |
| 原生设置入口 | 在插件列表中显示，在「飞书机器人」设置页管理配置 |
| 两种接收方式 | Webhook 与长连接二选一，保存后更新运行状态 |
| 文本消息处理 | 接收 `im.message.receive_v1`，为每条有效消息创建独立 Harness 会话 |
| 自动答复 | Agent 完成后向原消息回复最终文本，较长回复分段发送 |
| Webhook 验证 | 处理地址验证、Verification Token、加密请求解密和签名校验 |
| 连接检查 | 测试应用凭据、显示长连接状态、检测本机 ngrok 隧道 |
| 飞书工具 | 为 Agent 注册 `feishu_*` 工具；实际可调用范围取决于应用权限和资源授权 |

飞书工具覆盖消息、群聊、通讯录、文档、电子表格、日历、任务、多维表格和云空间等接口。接收消息的权限不会自动授予这些工具的权限；使用某类工具时，应按对应接口补充授权。工具定义见 [lib/index.js](lib/index.js)。

### 使用示例

在飞书私聊机器人发送：

> 请阅读工作目录里的 README，用中文概括这个项目的用途。

或者把机器人加入群聊后 @机器人：

> 请检查工作目录中未提交的改动，列出需要关注的问题。

Harness 会出现一个对应会话，处理完成后由插件回复最终文本。这些是自然语言请求示例，执行结果取决于模型、Agent 预设、工作目录和权限。当前每条消息独立创建会话，下一条消息需要带上必要背景。

## 快速开始

### 1. 准备环境

- Node.js **22 或更新版本**、npm、Git。
- 可正常运行的 DeepSeek Harness；已配置模型，并能在网页会话中得到答复。
- 一个已启用机器人能力的飞书企业自建应用及其 App ID、App Secret。

当前兼容验证基于 Harness **0.1.5-rc.2** 相关组件，使用 **Web profile**。其他版本和运行方式尚未验证。

尚未安装 Harness 时，先运行：

```bash
npm install -g @deepseek-ai/dsh
```

### 2. 安装并启动

```bash
git clone https://github.com/icanotcode/dsh-feishu-bot.git
cd dsh-feishu-bot
npm ci
npm run install:harness
npm run start:harness
```

打开启动日志给出的本机地址，默认端口为 `3080`。在插件列表搜索 `feishu`，打开 **设置 → 插件 → 飞书机器人**；也可以使用设置中的「飞书机器人」入口。

安装脚本将当前仓库链接到 Harness 的 `web` profile，并补充所需的 Webhook 运行时，修改已有配置前会备份。**安装后请保留仓库目录。** 已有实例占用端口时，先在原启动终端停止该实例；启动脚本不会自动停止服务。自定义 `DSH_HOME` 时，安装和启动必须使用相同的值。

### 3. 选择接入方式

先填写 App ID、App Secret、实际存在的工作目录绝对路径和 Agent 预设，然后选择接收方式：

| 项目 | 开发者服务器（Webhook） | 长连接（WebSocket） |
| --- | --- | --- |
| 连接方向 | 飞书向公网 HTTPS 地址推送 | 本机主动连接飞书 |
| 公网地址 / ngrok | 需要可达的 HTTPS 入口；ngrok 是一种选择 | 不需要 |
| 应用凭据 | App ID、App Secret | App ID、App Secret |
| 回调验证配置 | Verification Token；启用加密时还需 Encrypt Key | 不需要 Token / Encrypt Key |
| 飞书后台订阅方式 | 将事件发送至开发者服务器 | 使用长连接接收事件 |
| 当前实现默认值 | 默认接收方式 | 在设置页选择后保存 |

两种模式均需订阅 **接收消息 `im.message.receive_v1`**，开通接收和回复消息的权限，并完成飞书应用版本的发布/生效流程。

- **Webhook**：插件「公网服务地址」填 `https://your-domain.example`，先保存验证凭据，再在飞书后台填写完整地址 `https://your-domain.example/webhook/feishu`。
- **长连接**：保存应用凭据与接收方式，等插件显示已连接，再在飞书后台选择长连接并配置事件。

完整字段解释、飞书权限、ngrok 命令和配置顺序见 **[飞书接入指南](docs/setup.md)**。

### 4. 验证第一次回复

在飞书私聊机器人发送一条简单文本，确认 Harness 中出现会话，并在飞书收到最终答复。群聊测试需先加入机器人并 @机器人。

「测试连接成功」说明应用凭据通过认证；「请求地址保存成功」说明地址验证通过；「长连接已连接」说明连接已建立。只有实际收到机器人答复，才验证了完整链路。

## 默认配置与数据保存

| 配置 | 默认行为 |
| --- | --- |
| 接收方式 | `webhook` |
| 回调路径 | `/webhook/feishu` |
| Agent 预设 | `standard`，需已在 Harness 中安装 |
| 权限预设 | `workspace-write`；可在设置页选择只读等其他预设 |
| 工作目录 | 源码安装脚本初始化为仓库的父目录；首次使用时请改为实际项目目录 |
| 模型 | 未单独指定时使用 Harness 的默认模型配置 |
| 普通配置 | 保存在 `DSH_HOME` 下的 `feishu-bot.json`；默认 `DSH_HOME` 为 `~/.dsh` |
| 密钥 | 由 Harness 凭据服务保存；设置页留空保留已有值，环境变量提供的值需在启动环境中修改 |

机器人会使用所选工作目录和权限执行请求。当前插件没有独立的用户/群聊白名单，应在飞书中设置适当的应用可用范围，并按任务选择权限预设。

## 支持范围与验证状态

当前聊天入口支持文本消息和最终文本回复，暂不提供图片/文件输入、流式输出、按聊天延续的多轮会话或插件斜杠命令。消息去重和回复关联保存在进程内存中，重启后不会恢复未交付的答复。

除 `im.message.receive_v1` 外，尚未处理机器人入群/出群、消息已读/撤回、reaction、云文档评论、会议/纪要/妙记事件；也未实现 **`card.action.trigger` 卡片按钮回调** 或定时任务执行器。这些事件无需为本插件额外订阅。

已有单元测试和本地浏览器检查；**真实飞书消息收发尚未完成验收**。欢迎按接入指南进行试用并反馈环境、复现步骤和脱敏日志。

## 常见问题

- **保存请求地址提示 3 秒超时**：先检查转发端口、完整路径、代理登录拦截和 Encrypt Key 配置。
- **为什么地址要加 `/webhook/feishu`？** 域名将请求送到服务器，路径将请求交给飞书接收接口；默认根路径是 Harness 页面。
- **看到已连接，却收不到回复**：继续检查事件订阅、应用发布、消息权限以及 Harness 会话中的执行结果。

具体步骤与 HTTP 状态码说明见 **[排错指南](docs/troubleshooting.md)**。

## 更新与参与

在仓库目录中更新，完成后重启正在使用此插件的 Harness：

```bash
git pull --ff-only
npm ci
npm run install:harness
```

本地验证命令为 `npm test`。提交问题或改进前可阅读 [贡献说明](CONTRIBUTING.md)。需要向社区介绍本插件时，可使用 [社区介绍文案](docs/community-introduction.md)。

## 许可与参考

代码使用 [MIT 许可证](LICENSE)，第三方依赖遵循各自的许可证。

文档组织参考了 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) 的中英文入口和分层接入指南；本页列出的能力以本仓库实现为准。
