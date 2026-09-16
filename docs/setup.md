# 飞书接入指南

[返回项目首页](../README.md) · [故障排查](troubleshooting.md)

本指南适用于当前版本的 DeepSeek Harness **Web profile**，接入飞书企业自建应用。先按首页完成源码安装，再配置应用与消息接收方式。配置完成的验收标准是：发送一条真实飞书文本消息，Harness 生成会话，机器人回复最终文本。

## 1. 准备应用和 Harness

1. 打开 [飞书开发者后台](https://open.feishu.cn/app)，创建或选择企业自建应用，在应用能力中添加机器人。
2. 在「凭证与基础信息」取得 **App ID** 和 **App Secret**。这里需要应用凭据，不是群自定义机器人的发送 Webhook 地址。
3. 启动 Harness，先在网页中完成模型配置，确认普通会话能够正常得到答复。
4. 在插件列表搜索 `feishu`，确认 `feishu-bot` 已启用。打开 **设置 → 插件 → 飞书机器人**；设置中也可能直接显示 **飞书机器人** 入口。
5. 填写应用凭据、实际存在的工作目录和 Agent 预设，再按下文选择接收方式。

安装脚本会把源码目录链接到 `web` profile，安装后请保留该目录。如果使用自定义 `DSH_HOME`，安装和启动应使用同一个值，才能读取同一份插件与配置。

## 2. 选择事件接收方式

| 项目 | 开发者服务器（Webhook） | 长连接 |
| --- | --- | --- |
| 插件选项 | 将事件发送至开发者服务器（Webhook） | 使用长连接接收事件 |
| 事件如何到达 | 飞书向公网 HTTPS 地址发送 POST 请求 | Harness 使用飞书 SDK 建立连接接收事件 |
| App ID / App Secret | 需要，用于应用认证和回复 | 需要，用于连接、应用认证和回复 |
| 公网域名 / 隧道 | 需要可达的公网入口 | 不需要，本机需能访问飞书服务 |
| Verification Token / Encrypt Key | 按应用的加密策略配置，见下文 | 不需要 |
| 飞书后台填写请求地址 | 需要完整的 Webhook URL | 不需要 |

两种方式接收的都是 `im.message.receive_v1` 文本消息，功能范围相同。修改下拉选项后必须点击 **保存配置** 才生效；飞书后台也要选择相同方式。长连接模式下，HTTP Webhook 入口返回 `409`，两个入口不会同时接收消息。

### 方式 A：开发者服务器（Webhook）

1. 插件选择 **将事件发送至开发者服务器（Webhook）**，在 **公网接入方式** 中选择 ngrok、Cloudflare Tunnel 或自定义公网地址。
2. 在飞书后台 **事件与回调 → 加密策略** 中取得 Verification Token；如果启用了事件加密，同时取得 Encrypt Key。将这些值填写到插件并先点击 **保存配置**。
3. 将公网 HTTPS 入口转发到 Harness 实际监听端口，默认是本机 `3080`。
4. 在插件的 **公网服务地址** 中填写域名根地址，例如 `https://your-domain.example`，保存后复制页面显示的 **Webhook 地址**。
5. 飞书后台打开 **事件与回调 → 事件配置**，编辑订阅方式，选择 **将事件发送至开发者服务器**，填写复制的完整地址并保存。
6. 完成下文的事件订阅、权限和应用发布，再测试真实消息。

默认配置下，两处地址的填写方式不同：

| 填写位置 | 示例 |
| --- | --- |
| 插件「公网服务地址」 | `https://your-domain.example` |
| 飞书「请求地址」 | `https://your-domain.example/webhook/feishu` |

插件「公网服务地址」只接受 HTTPS 根地址，不接受路径、查询参数或 URL 中的用户名密码。保存请求地址时，飞书会向该地址发起验证请求，插件读取 `challenge` 并返回同一个值；启用加密时会先解密。此步骤不调用模型，不需要等待 Agent 生成答复。订阅流程可参阅 [飞书：配置事件订阅方式](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)。

#### 使用本机 ngrok

在公网接入方式中选择 **ngrok**。先自行安装并配置 ngrok，在插件源码目录的另一个终端运行：

```bash
npm run start:ngrok -- --url https://YOUR-NGROK-DOMAIN --port 3080
```

`--port` 与 Harness 的实际监听端口保持一致；也可通过 `NGROK_URL` 提供域名。有自己的 traffic policy 时，可追加 `--traffic-policy-file PATH`。策略需要允许飞书的 Webhook 请求到达该路径，不应要求飞书完成浏览器登录；Harness 管理页面仍应保留原有访问保护。

设置页会显示只读的「当前 Harness 监听端口」，并用实际端口生成 ngrok / Cloudflare 启动命令，端口不固定为 `3080`。例如要改为 `4321`，先停止原 Harness 实例，再运行 `npm run start:harness -- --port 4321`，同时把隧道的目标端口改为 `4321`。插件共用 Harness 的 HTTP 服务，没有独立监听端口；仅修改隧道端口或保存插件设置不会移动该服务。

插件会读取本机 `127.0.0.1:4040` 的 ngrok 隧道信息，仅选择指向当前 Harness 端口的 HTTPS 隧道。如果「公网服务地址」留空，可用检测到的隧道生成 Webhook URL。填写了公网服务地址时，以填写值为准。设置页只检测隧道，不负责启动、停止或配置 ngrok。

#### 使用 Cloudflare Tunnel

在公网接入方式中选择 **Cloudflare Tunnel**。先按 [Cloudflare 官方安装说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) 安装 `cloudflared`，确保终端能找到该命令。

临时验证可以使用 Quick Tunnel。在插件源码目录的另一个终端运行：

```bash
npm run start:cloudflare -- --port 3080
```

将启动日志中的 `https://…trycloudflare.com` 根地址填写到插件 **公网服务地址** 并保存，再将该根地址加 `/webhook/feishu` 填入飞书后台。`--port` 必须等于 Harness 实际监听端口；Quick Tunnel 退出后域名不能继续使用，下次启动获得新地址时，应同步更新插件与飞书后台。

长期使用建议创建命名隧道，并把自己的域名路由到 Harness。完成 Cloudflare 账户、域名、隧道凭据和配置文件准备后，可运行现有命名隧道：

```bash
npm run start:cloudflare -- --name YOUR-TUNNEL --config /path/to/config.yml
```

`--name` 与 `--port` 不能同时使用；命名隧道的本地目标由配置文件中的 `ingress` 决定，例如 `http://127.0.0.1:3080`。插件脚本只启动现有隧道，不负责创建账户、申请域名、创建隧道或修改 DNS。部署细节见 [Cloudflare 本地管理隧道指南](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)。

Cloudflare 模式需要手动填写公网服务地址，不读取 ngrok 检测结果，也不会在地址留空时回退到 ngrok。**保存地址只表示完成配置，不代表 Cloudflare 已运行或公网已连通。** 如有 Cloudflare Access 或其他入口策略，飞书 POST 回调必须能够到达 `/webhook/feishu`；管理页面的访问保护应继续保留。

#### 使用自定义公网地址

已有反向代理或其他公网 HTTPS 入口时，选择 **自定义公网地址**，填写根地址并保存。确保入口将回调路径转发到 Harness 实际端口。此方式同样不会启动代理、自动检测 ngrok 或验证公网连通性。

### 方式 B：长连接

1. 插件填写 App ID 和 App Secret，选择 **使用长连接接收事件**，点击 **保存配置**。
2. 等待状态显示 **当前运行：长连接 · 已连接**；可点击 **刷新连接状态**。
3. 飞书后台打开 **事件与回调 → 事件配置**，选择 **使用长连接接收事件** 并保存。
4. 完成下文的事件订阅、权限和应用发布，再测试真实消息。

长连接由 Harness 进程维持。关闭 Harness 后就无法接收消息；重启后会根据保存的配置重新建立连接。该方式无需填写公网地址，也不需要 ngrok、Cloudflare 或其他隧道；Verification Token / Encrypt Key 同样不需要。

## 3. 订阅事件、配置权限并发布应用

在 **事件与回调 → 事件配置** 中添加 **接收消息 `im.message.receive_v1`**。自动聊天只需要这一项事件，更多事件不会自动增加插件能力。

在「权限管理」中按实际使用场景开通应用身份权限：

| 场景 | 应检查的权限名称 |
| --- | --- |
| 接收用户私聊机器人的文本 | 读取用户发给机器人的单聊消息 |
| 接收群里 @机器人的文本 | 获取群组中用户 @机器人消息 |
| 回复处理结果 | 以应用的身份发消息 |
| 添加/删除敲键盘工作状态表情 | 发送、删除消息表情回复（`im:message.reactions:write_only`） |

飞书可能提供多项可满足同一接口的权限，具体以当前后台提示为准。不要为了接通文本聊天，一次性申请所有文档、日历或通讯录权限。接收条件和回复权限分别见 [飞书：接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[飞书：回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。

`Typing` 工作状态表情通过主动调用飞书 API 添加和删除，不需要订阅 `im.message.reaction.created_v1` 或 `im.message.reaction.deleted_v1`。权限详情见 [飞书：添加消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create) 与 [删除消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete)。新增权限后必须完成发布/生效流程，不能只在权限管理页面勾选。

完成 **版本管理与发布** 中的创建版本、发布或审批流程，确认应用对测试用户可见。群聊测试前将机器人加入群，并 @机器人发送文本。当前插件没有独立的用户或群聊白名单，应通过飞书应用的可用范围、事件接收权限以及 Harness 权限预设控制使用范围。

**「回调配置」无需为当前聊天功能添加项目。** 插件未处理 `card.action.trigger` 卡片按钮交互。机器人入群/出群、已读/撤回、用户表情回应事件、云文档评论、会议和纪要/妙记等事件也不在当前处理范围内。

## 4. 设置字段说明

| 设置项 | 用途与填写规则 |
| --- | --- |
| 连接方式 | 决定使用 Webhook 或长连接，保存后生效。 |
| App ID | 飞书企业自建应用的标识，在「凭证与基础信息」取得。 |
| App Secret | 应用密钥，用于向飞书认证及获取应用访问令牌；与 Verification Token 是不同凭据。 |
| Verification Token | 飞书事件中的校验令牌，用于核对请求是否属于你的应用。Webhook 接收普通消息时需有 Token 校验或加密签名校验。 |
| Encrypt Key | 飞书启用事件加密时使用的密钥，插件据此解密载荷并验证普通加密事件的签名。必须与飞书后台一致，不是自行填写的登录密码。 |
| 工作目录 | Agent 处理飞书请求时使用的目录，必须是存在且可访问的绝对路径。请按自己的项目设置。 |
| Agent 预设 | 当前 Harness 已安装的预设名称，默认 `standard`。 |
| 权限预设 | 可选只读（`read-only`）、工作区写入（`workspace-write`，默认）或完全访问（`danger-full-access`）；具体可执行操作由 Harness 负责约束。 |
| 公网接入方式 | Webhook 下选择 ngrok（默认）、Cloudflare Tunnel 或自定义公网地址，保存后生效。长连接不需要任何隧道。 |
| 公网服务地址 | 填写 HTTPS 根地址。仅 ngrok 模式允许留空并使用自动检测结果；Cloudflare 和自定义模式需手动填写，不会回退 ngrok。 |
| Webhook 地址 | 只读显示，由公网服务地址和插件路径组合；复制到飞书后台的请求地址栏。 |

**测试连接** 会使用当前填写的 App ID / App Secret 向飞书进行应用认证；输入留空时使用已保存值。测试成功不会保存修改，也不代表事件订阅或消息回复已经接通，仍需点击 **保存配置**。

App Secret、Verification Token、Encrypt Key 不会回显；出现「已保存凭证」时，输入框为空是正常现象。**留空表示保留旧值，填写新值表示替换**，不是清空已保存凭据。

凭据通过 Harness 凭据服务保存，普通配置保存在 `DSH_HOME` 下的 `feishu-bot.json`。默认凭据引用为 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN` 和 `FEISHU_ENCRYPT_KEY`。若值来自进程环境变量，页面不能覆盖成不同值；应修改启动环境并重启 Harness。

## 5. 验收第一条消息

1. 在 Harness 网页中发起普通会话，确认模型可以答复。
2. 确认插件配置已保存，Webhook 地址通过验证或长连接显示已连接。
3. 在飞书私聊机器人发送 `请只回复：飞书连接正常`。这是一条普通文本请求，不是插件命令。
4. 确认 Harness 出现以 `Feishu:` 开头的会话，并生成答复。
5. 确认机器人在飞书回复了这次请求。若需要群聊，再单独测试群内 @机器人。
6. 开通表情写权限后，用一条耗时稍长的文本任务检查原消息上的敲键盘表情是否在处理期间出现、结束后移除；快速完成的任务可能不易观察。

当前每条受支持的消息会创建独立 Harness 会话，后续消息不自动继承上一条的上下文。自动接收目前只处理文本，不处理图片、文件或语音；默认在 Agent 完成后回复最终文本，没有流式进度卡片。需要较长上下文时，请在同一条文本中提供完整背景。

工作状态表情默认自动启用，目前没有独立开关。任务完成、出错、取消或插件卸载时，插件会尝试移除自己添加的表情，不会删除他人的回应。状态更新失败只记录日志，不影响任务和最终答复；断网或强制终止进程可能导致表情残留。

当前版本已进行单元测试和本地浏览器检查，但项目尚未完成真实飞书消息收发验收。完成上述步骤后，才能确认你自己的应用、权限、网络和模型组成的完整链路可用。

## 启动参数与更新

### 平台与端口

插件核心使用 Node.js，面向 Linux、Windows 和 macOS。安装器在 Windows 使用目录 junction，在 Linux/macOS 使用符号链接。各系统均可运行本文的 `npm run` 命令；Windows 建议使用 PowerShell。Bash 的 `alias` 不是插件依赖，也不能直接粘贴进 PowerShell。

Windows 的工作目录可填写 `C:\Projects\my-project`，Linux/macOS 填写各自本机目录；路径中有空格时，在命令行中用引号包裹。ngrok 和 cloudflared 需要安装对应系统版本，并加入 PATH。插件不会自动安装这些程序。

目前本机验证环境是 Linux。CI 配置覆盖三种系统的自动测试，但真实飞书收发、隧道连通和后台进程行为仍需在目标系统验收；不能仅凭代码兼容认定三平台所有场景均已通过。

Harness 与飞书回调共用同一个监听端口。插件会自动获取该端口，无需再保存一个可能不一致的副本；修改监听端口需要重启 Harness，并同步调整隧道目标。

### 启动命令

在插件源码目录运行，默认以前台方式启动 Harness，日志显示在当前终端：

```bash
npm run start:harness
```

脚本向 `dsh web` 透传启动参数，可指定其他端口或使用后台运行：

```bash
npm run start:harness -- --port 3081
npm run start:harness -- --background
```

后台运行时，日志位于插件目录的 `.runtime/harness.log`。`--background` 只检查进程启动后短时间内是否退出，需通过日志确认服务实际就绪。若已有实例占用端口，请在其原启动终端停止后再启动，脚本不会自动停止已有服务。

脚本优先使用 `DSH_BIN` 指定的入口，其次查找 PATH 中的 Harness 入口和已有 npm npx 缓存；Windows 会读取 npm 安装目录中的 JS 入口，避免执行 shell shim。如果提示未找到 Harness，先确认官方程序已安装；也可以通过启动环境中的 `DSH_BIN` 指定 JavaScript 入口或原生可执行文件。Windows 上不要将 `DSH_BIN` 指向 `.cmd` / `.bat`，当前脚本不支持这两种入口。

ngrok 也支持后台运行，日志位于 `.runtime/ngrok.log`：

```bash
npm run start:ngrok -- --url https://YOUR-NGROK-DOMAIN --port 3080 --background
```

Cloudflare 启动脚本也支持 `--background`，日志位于 `.runtime/cloudflared.log`。后台启动只表示进程没有立即退出，不表示隧道已经连通：

```bash
npm run start:cloudflare -- --port 3080 --background
```

Quick Tunnel 的公网域名仍需从日志中复制到插件，再同步飞书后台的完整回调地址。

更新仓库源码后，运行 `npm ci` 和 `npm run install:harness`，再重启 Harness。若使用自定义 `DSH_HOME`，更新安装与启动时也应保持一致。
