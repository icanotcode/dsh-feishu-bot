# 参与贡献

感谢帮助改进 DeepSeek Harness 飞书机器人。问题反馈、文档纠错和代码贡献都可以通过本仓库的 [Issues](https://github.com/icanotcode/dsh-feishu-bot/issues) 和 Pull Request 提交。

## 反馈问题

请先查看 [接入指南](docs/setup.md) 和 [排错指南](docs/troubleshooting.md)，并提供：

- 操作系统、Node.js、Harness 和插件版本；插件版本见 `package.json`。
- 接收方式：Webhook 或长连接；Webhook 是否经过 ngrok 或其他代理。
- 复现步骤、期望结果、实际结果，以及对应的错误信息或 HTTP 状态码。
- 出错阶段：安装、设置页、保存地址、认证、接收事件、Agent 执行或回复发送。

日志请只截取相关片段，并移除 App Secret、Verification Token、Encrypt Key、ngrok Authtoken、Harness 登录 token、消息正文和个人信息。启动链接可能含 `?token=...`，不要原样公开。密钥输入框的空白状态本身不表示凭据丢失。

## 本地开发

```bash
git clone https://github.com/icanotcode/dsh-feishu-bot.git
cd dsh-feishu-bot
npm ci
npm test
```

需要在独立 Harness 环境检查时，可以指定单独的配置目录和端口。例如在 Bash 中：

```bash
export DSH_HOME="$PWD/.runtime/dev-dsh"
npm run install:harness
npm run start:harness -- --port 3081
```

这会使用独立的 Harness 配置目录，需要自行配置模型与飞书应用。不要让多个进程同时接收同一个飞书应用的事件；调试时使用测试应用。

| 目录或文件 | 内容 |
| --- | --- |
| `lib/index.js` | 插件配置、飞书 API 工具与 Webhook 入口 |
| `lib/runtime.js` | Harness 会话创建和最终答复路由 |
| `lib/transport.js` | 长连接生命周期 |
| `lib/management.js` | 设置页管理接口 |
| `client/index.js` | Harness Web 设置界面 |
| `scripts/` | 安装、Harness 启动和 ngrok 启动脚本 |
| `test/` | 自动化测试 |
| `docs/` | 接入、排错和社区介绍 |

## 提交改动

让每次改动聚焦一个问题，并说明触发条件、变化后的行为和验证结果。文档修改需要核对命令、链接和现有实现；行为修改应运行 `npm test`，并为需要保护的边界补充有意义的验证。

单元测试不代表真实飞书收发通过。报告手动验证时，请区分地址验证、应用认证、长连接建立和真实消息回复，说明实际完成了哪一步。

请勿提交 `.env`、`feishuApp`、Harness 配置目录、运行日志或其他凭据文件。许可证见 [LICENSE](LICENSE)。
