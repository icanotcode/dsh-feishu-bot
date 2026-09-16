# 社区介绍文案

以下内容可用于项目分享帖；安装和支持范围以仓库 README 为准。

---

## dsh-feishu-bot：在飞书中使用 DeepSeek Harness

开源了一个 DeepSeek Harness 飞书机器人插件，支持在 Harness 插件列表和设置页中配置。通过飞书发送文本任务，由本机 Harness Agent 执行，再把最终文本答复发送回原消息。

提供两种可切换的接入方式：

- **开发者服务器 Webhook**：适合已有公网 HTTPS 入口、ngrok 或 Cloudflare Tunnel 的场景，支持飞书地址验证、Token 校验和加密请求处理。
- **长连接 WebSocket**：本机主动连接飞书，不需要公网地址或任何隧道。

设置页可保存应用凭据，选择工作目录、Agent 和权限预设，测试应用认证并查看连接状态。仓库提供中文/英文说明、安装步骤、飞书接入和常见问题指南。

处理开始时，机器人会在原消息添加敲键盘（`Typing`）表情回应，结束时尝试清除；需要表情回复写权限，权限不足不影响正常处理与回复。此功能不要求订阅用户的表情回应事件。

Cloudflare 需单独安装并运行 `cloudflared`；插件支持选择接入方式和手动填写 HTTPS 根地址，不会自动启动隧道，也不会将填好地址显示为已验证连通。Quick Tunnel 可用于临时测试，长期使用建议配置命名隧道。

当前版本 **0.1.3**，使用 MIT 许可证，通过 GitHub 源码安装，尚未发布到 npm。兼容验证基于 Harness `0.1.5-rc.2` 的 Web profile，需要 Node.js 22 或更新版本。

当前每条消息创建独立会话，支持文本输入与最终文本回复；暂不支持连续多轮会话、图片/文件输入、流式回复和卡片按钮回调。已有单元测试和本地浏览器检查，真实飞书消息收发尚未完成验收，欢迎试用反馈。

仓库与安装说明：[icanotcode/dsh-feishu-bot](https://github.com/icanotcode/dsh-feishu-bot)

问题反馈：[GitHub Issues](https://github.com/icanotcode/dsh-feishu-bot/issues)

本项目为独立维护的社区插件，与 DeepSeek、飞书无隶属关系。
