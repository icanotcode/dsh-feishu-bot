import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 新用户审批流（薄代理：确定性命令处理，不经模型猜测）：
 * - 新用户完成姓名确认且无角色 → 主动通知所有 admin 的飞书私聊
 * - admin 用 /approve /reject /pending 命令审批（即时生效，无需重启）
 * - 批准结果写回配置文件（读-改-写，不动其他字段）
 */
export function createApprovals({ config, client }) {
  // 角色层级：超管 > 管理 > 普通用户；未登记的自定义角色按普通用户（1级）处理
  const ROLE_RANK = { superadmin: 3, admin: 2, member: 1 };
  const rankOf = openId => Math.max(0, ...((config.authorizedUsers || []).find(u => u.openId === openId)?.roles || config.defaultUserRoles || []).map(r => ROLE_RANK[r] ?? 1));
  const admins = () => (config.authorizedUsers || []).filter(u => (u.roles || []).some(r => (ROLE_RANK[r] ?? 1) >= 2));
  const isAdmin = openId => rankOf(openId) >= 2;
  const rolesOf = openId => (config.authorizedUsers || []).find(u => u.openId === openId)?.roles || config.defaultUserRoles || [];
  const notified = new Set();

  async function persist() {
    const file = config.configFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'feishu-bot.json');
    let raw = {};
    try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { /* 保留其他字段 */ }
    raw.authorizedUsers = config.authorizedUsers || [];
    await writeFile(file, JSON.stringify(raw, null, 2), 'utf8');
    await chmod(file, 0o600).catch(() => {});
  }

  return {
    /** 新用户完成姓名确认后调用：无角色则通知全部 admin。 */
    async notifyIfNeeded({ openId, displayName }) {
      if (!openId || rolesOf(openId).length) return;
      if (notified.has(openId)) return;
      notified.add(openId);
      const text = `🔔 新用户审批请求\n姓名：${displayName}\nopen_id：${openId}\n\n批准为普通用户：/approve ${openId} member\n批准为管理员：/approve ${openId} admin\n拒绝（不授予任何能力）：/reject ${openId}\n查看待审批列表：/pending`;
      for (const admin of admins()) {
        try { await client.sendTextMessage(admin.openId, text); } catch { /* 通知失败不阻断用户流程 */ }
      }
    },

    /** 斜杠命令处理；命中返回 {reply}，未命中返回 null。 */
    async handleCommand(text, senderOpenId, knownUsers) {
      const match = /^\/(approve|reject|pending)(?:\s+(\S+))?(?:\s+(\S+))?$/i.exec(text.trim());
      if (!match) return null;
      if (!isAdmin(senderOpenId)) return { reply: '审批命令仅管理员可用。' };
      const [, action, target, roleArg] = match;

      if (action.toLowerCase() === 'pending') {
        const pending = [...(knownUsers?.() || [])].filter(u => !rolesOf(u.openId).length);
        if (!pending.length) return { reply: '当前没有待审批用户。' };
        return { reply: '待审批用户：\n' + pending.map(u => `· ${u.displayName}（${u.openId}）`).join('\n') + '\n\n批准：/approve <open_id> member' };
      }

      if (!target) return { reply: `用法：/${action} <open_id>${action === 'approve' ? ' <角色，如 member>' : ''}` };
      const known = [...(knownUsers?.() || [])].find(u => u.openId === target);
      const displayName = known?.displayName || target;

      if (action.toLowerCase() === 'reject') {
        config.authorizedUsers = (config.authorizedUsers || []).filter(u => u.openId !== target);
        await persist();
        try { await client.sendTextMessage(target, '你的使用申请未通过审批。如有疑问请联系管理员。'); } catch {}
        return { reply: `已拒绝 ${displayName}（${target}），未授予任何能力。` };
      }

      // approve
      const roles = (roleArg || 'member').split(',').map(r => r.trim()).filter(Boolean);
      if (roles.some(r => !/^[a-z0-9-]{1,32}$/.test(r))) return { reply: '角色只能包含小写字母、数字、短横线。' };
      const myRank = rankOf(senderOpenId);
      if (roles.some(r => (ROLE_RANK[r] ?? 1) >= myRank)) return { reply: `不能授予不低于自己的角色。你的级别：${myRank === 3 ? '超管' : '管理'}，可授予：${myRank === 3 ? 'admin / member / 自定义角色' : 'member / 自定义角色'}。` };
      config.authorizedUsers = config.authorizedUsers || [];
      const existing = config.authorizedUsers.find(u => u.openId === target);
      if (existing) existing.roles = roles;
      else config.authorizedUsers.push({ openId: target, displayName, roles });
      await persist();
      try { await client.sendTextMessage(target, `✅ 你的使用权限已开通（角色：${roles.join(', ')}）。发送「你会什么」查看可用能力。`); } catch {}
      return { reply: `已批准 ${displayName}（${target}），角色：${roles.join(', ')}。即时生效。` };
    },
  };
}
