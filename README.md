# DeepSeek Harness 飞书插件

在 DeepSeek Harness 插件列表和设置页中配置飞书机器人，接收飞书文本消息，交给 Harness Agent 处理，再把最终文本答复回复到原消息。

这是社区维护的非官方插件（community / unofficial），与 DeepSeek、飞书无隶属关系。仓库包名为 `@icanotcode/dsh-feishu-bot`；本文使用 GitHub 源码安装，不表示该包已经发布到 npm。

## 当前能力

- 插件列表显示、设置页打开、配置保存及重启恢复。
- 两种可切换的事件接收方式：HTTP Webhook 和飞书 SDK 长连接。
- 接收 `im.message.receive_v1` 文本消息，创建 Harness 会话并自动回复最终文本。
- Webhook 地址验证、Verification Token 校验、加密载荷解密和签名校验；两种模式共用消息去重逻辑。
- 应用凭据认证测试、长连接状态展示、本机 ngrok 隧道检测。

目前不处理机器人入群/出群、消息已读/撤回、reaction、云文档评论、会议/纪要/妙记等事件；没有实现卡片按钮回调 `card.action.trigger` 或定时任务执行器。已有发送卡片等工具不代表支持卡片回调。自动聊天入口目前只支持文本消息。

## 安装

需要 Node.js 22 或更新版本、npm、Git，以及可正常运行的 DeepSeek Harness。当前兼容验证基于 Harness `0.1.5-rc.2` 相关组件；Harness 接口仍可能变化。

如果尚未安装 Harness，先安装官方程序：

```bash
npm install -g @deepseek-ai/dsh
```

然后安装本插件：

```bash
git clone https://github.com/icanotcode/dsh-feishu-bot.git
cd dsh-feishu-bot
npm ci
npm run install:harness
npm run start:harness
```

打开启动日志给出的本机地址，默认是 `http://127.0.0.1:3080`。进入插件列表搜索 `feishu`，然后打开 **设置 → 插件 → 飞书机器人**。

安装脚本会把当前目录链接到 Harness 的 `web` profile，并添加飞书插件及 `@deepseek-ai/dsh-webhook` 运行时；修改已有配置前会生成备份。安装后请保留这个仓库目录。默认使用 `~/.dsh`，如使用自定义 `DSH_HOME`，安装和启动时应保持相同的环境变量。

如果已有 Harness 实例占用端口，请在其原启动终端停止后再启动。`start:harness` 不会自动停止已有服务。

## 配置机器人

1. 在 [飞书开放平台](https://open.feishu.cn/app) 创建或选择企业自建应用，启用机器人能力。
2. 从应用的「凭证与基础信息」复制 App ID 和 App Secret，填写到插件设置。
3. 在 Harness 中配置可用的模型与模型凭据，先确认普通网页会话能够得到回复。
4. 在插件中填写实际存在的工作目录绝对路径，选择已安装的 Agent 预设（默认 `standard`）和所需的权限预设。飞书消息会在这个目录和权限下触发 Agent。
5. 选择下面一种接收方式，并点击 **保存配置**。飞书后台的订阅方式必须与插件一致。

应用密钥由 Harness 凭据服务保存；普通插件配置写入 `DSH_HOME` 下的 `feishu-bot.json`。设置页不会回显已保存的密钥，密钥输入框留空表示保留原值。若凭据来自进程环境变量，需在启动环境中修改，不能在设置页覆盖。

### 方式一：开发者服务器（Webhook）

1. 插件选择 **将事件发送至开发者服务器（Webhook）**。
2. 从飞书后台 **事件与回调 → 加密策略** 复制 Verification Token；启用事件加密时同时复制 Encrypt Key。先在插件中保存这些值，再到飞书保存请求地址。
3. 让公网 HTTPS 地址转发到 Harness 实际监听端口。插件的「公网服务地址」填域名根地址，例如 `https://your-domain.example`；最终的飞书请求地址应为：

   ```text
   https://your-domain.example/webhook/feishu
   ```

4. 飞书后台 **事件与回调 → 事件配置** 选择 **将事件发送至开发者服务器**，填写完整请求地址并保存。插件会处理首次 `challenge` 地址验证，启用加密时也会解密该验证请求。
5. 添加 **接收消息 `im.message.receive_v1`** 事件，按后台要求开通对应接收权限和回复消息权限，并完成应用版本发布/生效步骤。

正常消息接收需要 Verification Token 校验或加密签名校验。地址验证成功只说明验证接口可达，不代表消息权限、模型或回复链路已经通过验收。

如果使用 ngrok，先安装并配置好你自己的 ngrok，然后在另一个终端运行：

```bash
npm run start:ngrok -- --url https://YOUR-NGROK-DOMAIN --port 3080
```

也可通过 `NGROK_URL` 提供 URL。`--port` 应与 Harness 监听端口一致。已有自己的 ngrok traffic policy 时，可用 `--traffic-policy-file PATH` 指定；脚本默认不附加策略。外层代理或认证策略需允许飞书访问 `/webhook/feishu`，同时保留 Harness 管理页面的访问保护。

插件可检测本机 `127.0.0.1:4040` 上指向 Harness 端口的 HTTPS 隧道；未填写公网服务地址时，会尝试用检测到的地址生成 Webhook URL。设置页只检测隧道，不启动或停止 ngrok 进程。

### 方式二：长连接

1. 插件填写 App ID、App Secret，选择 **使用长连接接收事件** 并保存。
2. 等待插件显示长连接已连接；如提示缺少配置或连接错误，检查凭据与本机网络。
3. 飞书后台选择 **使用长连接接收事件**，订阅 `im.message.receive_v1`，确认相应权限和应用版本已生效。

长连接模式不需要公网地址、ngrok、Verification Token 或 Encrypt Key。切换并保存后插件会更新连接，Webhook 入口在长连接模式下返回 `409`，不会同时处理两种入口的事件。

## 如何判断是否接通

| 显示或操作 | 能说明什么 |
| --- | --- |
| 插件列表中已启用 | Harness 加载了插件 |
| Webhook 已启用 / 等待推送 | 本地 Webhook 模式已启用，不代表公网可达 |
| 测试连接成功 | App ID / App Secret 通过飞书应用认证，不代表已收到事件 |
| 长连接已连接 | SDK 报告连接建立，不代表消息收发已验收 |
| 飞书保存请求地址成功 | `challenge` 验证成功，不代表 Agent 能完成回复 |
| 私聊或群内 @机器人后收到答复 | 这次真实消息经过了完整处理链路 |

完成配置后，在飞书私聊机器人发送一条文本；群聊测试时将机器人加入群并 @机器人。检查 Harness 是否出现对应会话，以及飞书是否收到最终回复。只有这一步成功才能确认实际收发。

截至当前版本，验证覆盖单元测试和本地浏览器检查；尚未完成真实飞书消息收发验收。

## 排查问题

- **保存地址超时**：确认 ngrok 转发到当前 Harness 端口，地址包含 `/webhook/feishu`，请求没有被外层登录拦截；启用加密时先保存正确 Encrypt Key。查看实际 HTTP 状态和 Harness 日志，平台提示的超时不一定是处理耗时过长。
- **Webhook 返回 `401`**：检查 Verification Token、Encrypt Key 与飞书应用是否匹配。
- **Webhook 返回 `503`**：检查加密 Key/请求认证配置、插件依赖运行时是否可用，并查看日志。
- **收到消息但没有答复**：检查 Harness 会话中的模型、Agent 预设、工作目录和执行错误，以及飞书回复消息权限。
- **后台启动命令结束却打不开页面**：后台命令只报告进程创建与短时存活，需查看 `.runtime/harness.log` 或 `.runtime/ngrok.log` 确认服务就绪。

## 开发与更新

```bash
npm test
```

更新源码后运行 `npm ci` 和 `npm run install:harness`，再重启 Harness。启动脚本支持向 `dsh web` 透传参数：

```bash
npm run start:harness -- --port 3081
npm run start:harness -- --background
```

如果未找到 `dsh`，可用 `DSH_BIN` 指定可执行文件或 JavaScript 入口。Windows 上使用 `DSH_BIN` 时应指向 JavaScript 入口或原生可执行文件。ngrok 脚本同样支持 `--background`。

不要把应用凭据、`.env`、Harness 配置目录或运行日志提交到仓库。本插件的 MIT 许可见 [LICENSE](LICENSE)；第三方依赖遵循各自的许可证。
