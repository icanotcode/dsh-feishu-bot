import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 新用户审批流（薄代理：权限校验在插件侧强制执行，不经模型猜测）：
 * - 新用户完成姓名确认且无角色 → 主动通知所有 admin 的飞书私聊
 * - 两个入口共用同一套核心逻辑：
 *   · 斜杠命令：/approve /reject /pending（用户直接发）
 *   · feishu_approval 工具：Agent 理解自然语言后调用（"批准张三为普通用户"）
 * - 批准即时生效（内存配置）并写回配置文件（读-改-写，不动其他字段）
 */

// 角色层级：超管 > 管理 > 普通用户；未登记的自定义角色按普通用户（1级）处理
const ROLE_RANK = { superadmin: 3, admin: 2, member: 1 };

const object = properties => ({ type: 'object', properties, additionalProperties: false });
export const approvalTool = {
  name: 'feishu_approval',
  description: 'Manage Feishu user capability approvals (admin only; enforced plugin-side). action=list shows pending users (confirmed but no roles); action=approve grants roles to a user (target accepts open_id or exact display name); action=reject removes access. You may only grant roles below your own rank. Always confirm intent with the admin before approve/reject.',
  parameters: object({
    action: { type: 'string', enum: ['list', 'approve', 'reject'] },
    target: { type: 'string', description: 'open_id or exact display name (required for approve/reject)' },
    roles: { type: 'string', description: 'comma-separated roles for approve, e.g. "member" (default) or "member,cognitive-user"' },
  }),
};

export function createApprovals({ config, client, knownUsers }) {
  const admins = () => (config.authorizedUsers || []).filter(u => (u.roles || []).some(r => (ROLE_RANK[r] ?? 1) >= 2));
  const rankOf = openId => Math.max(0, ...((config.authorizedUsers || []).find(u => u.openId === openId)?.roles || config.defaultUserRoles || []).map(r => ROLE_RANK[r] ?? 1));
  const rolesOf = openId => (config.authorizedUsers || []).find(u => u.openId === openId)?.roles || config.defaultUserRoles || [];
  const notified = new Set();

  const listKnown = () => [...(knownUsers?.() || [])];
  const resolveUser = target => {
    const known = listKnown();
    return known.find(u => u.openId === target)
        || known.find(u => u.displayName === target)
        || { openId: target, displayName: target };
  };
  const pendingUsers = () => listKnown().filter(u => u.openId && !rolesOf(u.openId).length);

  async function persist() {
    const file = config.configFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'feishu-bot.json');
    let raw = {};
    try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { /* 保留其他字段 */ }
    raw.authorizedUsers = config.authorizedUsers || [];
    await writeFile(file, JSON.stringify(raw, null, 2), 'utf8');
    await chmod(file, 0o600).catch(() => {});
  }

  // ===== 核心逻辑（命令与工具共用）；调用前必须已校验 caller 为管理 =====
  async function doList() {
    const pending = pendingUsers();
    if (!pending.length) return '当前没有待审批用户。';
    return '待审批用户：\n' + pending.map(u => `· ${u.displayName}（${u.openId}）`).join('\n') + '\n\n批准：直接说「批准 某某 为普通用户」即可。';
  }

  async function doApprove(callerOpenId, target, rolesArg) {
    if (!target) return '请指定要批准的用户（open_id 或姓名）。';
    const roles = (rolesArg || 'member').split(',').map(r => r.trim()).filter(Boolean);
    if (!roles.length || roles.some(r => !/^[a-z0-9-]{1,32}$/.test(r))) return '角色只能包含小写字母、数字、短横线。';
    const myRank = rankOf(callerOpenId);
    if (roles.some(r => (ROLE_RANK[r] ?? 1) >= myRank)) {
      return `不能授予不低于自己的角色。你的级别：${myRank === 3 ? '超管' : '管理'}，可授予：${myRank === 3 ? 'admin / member / 自定义角色' : 'member / 自定义角色'}。`;
    }
    const user = resolveUser(target);
    config.authorizedUsers = config.authorizedUsers || [];
    const existing = config.authorizedUsers.find(u => u.openId === user.openId);
    if (existing) existing.roles = roles;
    else config.authorizedUsers.push({ openId: user.openId, displayName: user.displayName, roles });
    await persist();
    try { await client.sendTextMessage(user.openId, `✅ 你的使用权限已开通（角色：${roles.join(', ')}）。发送「你会什么」查看可用能力。`); } catch {}
    return `已批准 ${user.displayName}（${user.openId}），角色：${roles.join(', ')}。即时生效。`;
  }

  async function doReject(target) {
    if (!target) return '请指定要拒绝的用户（open_id 或姓名）。';
    const user = resolveUser(target);
    config.authorizedUsers = (config.authorizedUsers || []).filter(u => u.openId !== user.openId);
    await persist();
    try { await client.sendTextMessage(user.openId, '你的使用申请未通过审批。如有疑问请联系管理员。'); } catch {}
    return `已拒绝 ${user.displayName}（${user.openId}），未授予任何能力。`;
  }

  return {
    /** 注入管理员消息的角色提示（非管理员返回空串）。 */
    adminNote(openId) {
      if (rankOf(openId) < 2) return '';
      return '\n你是本机器人的管理员。用户权限审批可直接用 feishu_approval 工具完成（action: list/approve/reject，target 支持 open_id 或姓名，roles 如 member）——用户说「批准某某为普通用户」时，先调 list 核对身份再 approve；不能授予不低于自己级别的角色。也可以让用户直接发斜杠命令 /approve、/reject、/pending。不要声称无法操作或引导改配置文件。';
    },

    /** 新用户完成姓名确认后调用：无角色则通知全部 admin。 */
    async notifyIfNeeded({ openId, displayName }) {
      if (!openId || rolesOf(openId).length) return;
      if (notified.has(openId)) return;
      notified.add(openId);
      const text = `🔔 新用户审批请求\n姓名：${displayName}\nopen_id：${openId}\n\n直接回复我「批准 ${displayName} 为普通用户」即可；\n拒绝：/reject ${openId}　待审批列表：/pending`;
      for (const admin of admins()) {
        try { await client.sendTextMessage(admin.openId, text); } catch { /* 通知失败不阻断用户流程 */ }
      }
    },

    /** 工具入口：Agent 调用。权限在插件侧强制校验。 */
    async execute(args, binding) {
      const caller = binding?.identity?.openId;
      if (!caller || rankOf(caller) < 2) throw new Error('审批操作仅管理员可用。');
      if (args.action === 'list') return { result: await doList() };
      if (args.action === 'approve') return { result: await doApprove(caller, args.target, args.roles) };
      if (args.action === 'reject') return { result: await doReject(args.target) };
      throw new Error(`未知 action：${args.action}`);
    },

    /** 斜杠命令入口：用户直接发。命中返回 {reply}，未命中返回 null。 */
    async handleCommand(text, senderOpenId) {
      const match = /^\/(approve|reject|pending)(?:\s+(\S+))?(?:\s+(\S+))?$/i.exec(text.trim());
      if (!match) return null;
      if (rankOf(senderOpenId) < 2) return { reply: '审批命令仅管理员可用。' };
      const [, action, target, roleArg] = match;
      if (action.toLowerCase() === 'pending') return { reply: await doList() };
      if (action.toLowerCase() === 'reject') return { reply: await doReject(target) };
      return { reply: await doApprove(senderOpenId, target, roleArg) };
    },
  };
}
