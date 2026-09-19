# 能力桥接入指南（Skill Capability Bridge）

> 适用版本：0.2.0+（Unreleased）
> 本文档描述飞书隔离会话如何安全地发现与调用 Harness 技能（skill），
> 以及如何为新技能做出正确的开放决策。

## 背景：为什么隔离会话看不到技能

Harness 的 Web 会话拥有 `skill` 工具与自动注入的技能目录（available_skills），
但飞书机器人创建的是**隔离会话**，出于安全设计：

- 工具白名单守卫：只允许插件注册的 `feishu_*` 工具；
- 没有 `skill` 工具，系统提示中没有技能目录；
- 没有 Shell；文件只能读写当前用户的独立工作区。

因此，把技能目录（`~/.dsh/skills/`）装进 Harness 并不等于飞书用户可用。
能力桥（capability bridge）就是穿越这层隔离的**通用通道**。

## 架构原则

1. **桥梁不含业务**：插件只提供发现、鉴权、执行三种机制，
   任何具体技能的逻辑都不进插件代码；
2. **文件是真相来源**：技能目录即注册表，扫描发生在每条消息处理时，
   无缓存、无中央清单；
3. **显式决定，可审计**：每个技能的开放状态由它自己目录里的
   `feishu.json` 声明，而不是碰巧被默认规则扫进去；
4. **默认安全**：无声明的技能只读开放（load-only）；
   命令执行必须显式声明；未授权角色不可见。

## 工作方式

```
~/.dsh/skills/<技能名>/
├── SKILL.md            ← 技能本体说明（Web 会话用）
├── feishu.json         ← 能力声明（可选；缺省时自动派生只读能力）
└── FEISHU.md           ← 面向隔离会话的指令体（可选，缺省用 SKILL.md）
```

每条飞书消息处理时，插件扫描技能目录，按当前用户角色过滤后，
把可见能力清单注入消息上下文。Agent 通过 `feishu_capability` 工具调用：

| action | 作用 |
|---|---|
| `list` | 返回当前用户被授予的能力清单（名称 + 一句话简介） |
| `load` | 返回指定能力的指令体（Agent 必须严格遵循） |
| `run`  | 执行能力声明中的命令模板（argv 数组，不经 shell） |

## 能力声明（feishu.json）参考

```json
{
  "enabled": true,
  "roles": ["admin"],
  "summary": "一句话介绍，出现在能力清单中",
  "instructions": "FEISHU.md",
  "commands": {
    "search": {
      "argv": ["python3", "scripts/search.py", "{query}"],
      "args": { "query": "[\\s\\S]{1,200}" },
      "description": "按关键词检索"
    },
    "add": {
      "argv": ["python3", "scripts/add.py"],
      "stdin": "{json}",
      "args": { "json": "[\\s\\S]{2,4000}" },
      "roles": ["admin"],
      "description": "写入类命令可单独收紧角色"
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | `false` 则完全隐藏（连 admin 也不可见） |
| `roles` | 可见该能力的角色列表（见下文角色配置） |
| `summary` | 清单中的一句话简介 |
| `instructions` | 指令文件，相对技能目录；缺省 `FEISHU.md` |
| `commands.<name>.argv` | 命令模板；`{参数名}` 占位符在执行时替换 |
| `commands.<name>.args` | 每个参数的正则校验（全文匹配） |
| `commands.<name>.stdin` | 可选；模板渲染后经 stdin 传入 |
| `commands.<name>.roles` | 可选；命令级角色收紧（高于能力级） |

## 无声明技能的自动派生

技能目录没有 `feishu.json` 时，插件自动派生一个**只读能力**：

- 简介取 `SKILL.md` frontmatter 的 `description`；
- 指令体为 `SKILL.md` 全文，并自动附加一段隔离限制提醒
  （告知 Agent 当前会话无 Shell、脚本类步骤不可用）；
- 开放角色取机器人配置的 `capabilityDefaultRoles`（默认 `["admin"]`）；
- 不开放任何命令。

这让"新技能放进目录即对管理员可见"，同时把脚本执行保留为显式 opt-in。

## 角色与用户授权

在机器人配置（`feishu-bot.json`）中为每位授权用户声明角色：

```json
{
  "authorizedUsers": [
    { "openId": "ou_xxx", "displayName": "Alice", "roles": ["admin"] },
    { "openId": "ou_yyy", "displayName": "Bob",   "roles": ["member"] }
  ],
  "capabilityDefaultRoles": ["admin"]
}
```

- 能力清单按角色过滤：用户角色与能力 `roles` 有交集才可见；
- 未配置 `roles` 的用户看不到任何能力；
- 能力级与命令级角色可叠加收紧（例如读命令开放给 member，写命令仅 admin）。

## 权限模型（RBAC-lite）

```
主体：飞书用户（openId，姓名确认后）
  ↓ 拥有
角色：字符串标签（admin / member / 自定义领域角色）
  ↓ 匹配
客体：能力（feishu.json 的 roles）+ 命令级收紧（commands.x.roles）
```

三条回退规则（默认姿态）：

1. 用户未配置角色 → 回退 `defaultUserRoles`（默认 `[]`，即什么都看不到，
   须管理员显式授予）；
2. 技能未声明 `feishu.json` → 回退 `capabilityDefaultRoles`（默认 `["admin"]`）；
3. 命令未声明角色 → 跟随能力级角色。

增 / 减权限的四个操作点（均即时生效，逐消息现读）：

| 操作 | 位置 |
|---|---|
| 给某用户开通 / 收回一类能力 | 配置中该用户的 `roles` 增删角色 |
| 调整某技能开放范围 | 该技能 `feishu.json` 的 `roles` |
| 单命令收紧（如读开放、写仅管理员） | `commands.<name>.roles` |
| 全局紧急关闭某能力 | `feishu.json` 设 `enabled: false` |

新用户审批流：姓名确认后仍无角色的用户，插件会主动向全部管理员私聊推送审批请求；
管理员用 `/approve <open_id> <角色>` 批准、`/reject <open_id>` 拒绝、`/pending` 查看待审批列表；
批准即时生效并写回配置文件，用户自动收到开通通知。审批命令仅 `admin` 角色可用。

角色语义约定：`admin` = 所有者全量；`member` = 普通授权用户；
领域角色（如 `xxx-user`）用于按技能粒度发放。

## 开放决策树（建议固化为团队规则）

新增技能时，按顺序判断并把决定**显式写进 `feishu.json`**：

1. 涉及凭据、支付、对外发送等敏感动作？
   → `enabled: false`，或仅 load-only + `roles: ["admin"]`；
2. 需要执行脚本？
   → 必须声明 `commands`（argv 模板 + 参数正则），并编写 `FEISHU.md`；
3. 纯对话 / 方法论型？
   → 写明 `feishu.json` 与角色（admin 或更宽）；
4. 要对普通用户开放？
   → 能力 `roles` 加对应角色，并在配置中为用户配角色。

> 三层各归其位：**判断标准在团队规则，默认策略在机器人配置，
> 每个技能的决定在它自己的 `feishu.json`。**

## 安全模型

- 命令以 argv 数组执行，**不经 shell**，无法注入 shell 语法；
- 每个参数按声明正则全文校验，未声明的参数一律拒绝；
- 单次执行 15 秒超时、输出 8000 字符上限；
- 指令文件路径限定在技能目录内（防路径穿越）；
- 工具调用要求会话已绑定已授权的飞书用户；
- 技能目录位于 Harness 用户级目录，飞书 Agent 自身无法直接读写，
  一切经能力桥代理。

## 推荐的全局 Agent 规则（AGENTS.md）配套

建议在 Harness 全局规则中固化两条与本机制配套的约定
（示例见 [examples/agents-rules.md](examples/agents-rules.md)）：

1. **能力发现**：用户问"你会什么"时，Web 会话列技能目录，
   飞书会话列内置工具 + `feishu_capability list` 的已授予能力；
2. **新能力接入协议**：新技能建成时必须完成入口清单、飞书可达性
   （按决策树写 `feishu.json`）、入口级验收、能力发现同步、
   双副本同步五项检查，才允许宣布建成。

## 示例

一个最小可用的能力声明与指令体示例：
[examples/skills/example-notes/](examples/skills/example-notes/)。
