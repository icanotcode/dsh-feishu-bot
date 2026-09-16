# 更新日志

## 0.1.3

- Webhook 设置新增公网接入方式选择：ngrok、Cloudflare Tunnel、自定义公网地址。保留 ngrok 默认行为；Cloudflare 和自定义方式使用手动填写的 HTTPS 根地址，不回退至 ngrok，不将配置成功当作公网连通。
- 新增 `npm run start:cloudflare`，支持 Quick Tunnel、启动现有命名隧道以及后台运行。Quick Tunnel 域名需手动同步到插件与飞书回调配置；长连接仍无需任何隧道。
- 接受有效飞书文本任务后自动添加 `Typing` 敲键盘表情回应，完成、错误、取消或卸载时尝试移除自己的表情。需开通 `im:message.reactions:write_only` 并完成权限发布；状态更新失败不影响任务与文本回复。
- 补充 Cloudflare 配置、表情权限和排错文档。添加工作状态表情不代表支持接收用户 reaction 事件。

真实飞书消息与 Cloudflare 公网链路需在使用者环境完成端到端验证。

## 0.1.2

- 提供 Harness Web profile 飞书插件设置页、Webhook / 长连接切换、应用凭据管理和连接状态显示。
- 接收飞书文本消息并创建独立 Harness 会话，完成后回复最终文本。
- 提供源码安装、ngrok 启动脚本、中英文项目说明与接入指南。
