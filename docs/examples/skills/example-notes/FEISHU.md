# 示例便签能力 · 隔离会话使用协议

你在飞书隔离会话中，通过 `feishu_capability` 工具使用本能力
（capability 名：`example-notes`）。

## 意图判断

| 用户意图 | 动作 |
|---|---|
| "查一下关于…的便签" | run command=search，args.query 为关键词 |
| "记一下：…" | run command=add，args.json 为便签 JSON 字符串 |

## 流程

1. 检索：调用 search 拿到结果后，用对话方式总结，不照抄原始输出；
2. 记录：由你补全字段（title、content、tags）后调用 add；
   存完向用户回报结果；
3. 写命令（add）仅管理员可用；非管理员调用会被拒绝，
   如实告知即可，不要重试。

## 边界

- 数据全局共享：飞书侧写入的便签，其他端可见；
- 回答保持精炼，适配聊天阅读。
