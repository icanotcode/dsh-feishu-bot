import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, normalize } from 'node:path';

const privateWorkspace = path => path.split(/[\\/]+/u).some(part => part.toLowerCase() === '.feishu-users');
const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;

/** Project choices come from Harness registrations, never a disk traversal.
 * Existing bot bindings remain visible if a registration was removed, and
 * inaccessible paths remain visible but cannot be selected.
 */
export async function listBotProjects(ctx, bots) {
  let registered = [];
  let warning;
  try {
    registered = ctx.workspaceRegistry.list();
    if (!Array.isArray(registered)) throw new Error('Workspace registry unavailable');
  } catch {
    warning = '暂时无法读取 Harness 项目列表，当前仅显示机器人已绑定的目录；请稍后刷新。';
  }
  const candidates = [
    ...registered.map(workspace => ({ path: workspace.path, name: workspace.title })),
    ...bots.map(bot => ({ path: bot.workspacePath, botId: bot.id, botName: bot.name })),
  ];
  // A registry may contain many user sessions. Exclude private roots before
  // filesystem access, and limit concurrent checks for larger installations.
  const results = new Array(candidates.length);
  let next = 0;
  const inspect = async () => {
    while (next < candidates.length) {
      const index = next++;
      const candidate = candidates[index];
      if (typeof candidate.path !== 'string' || !isAbsolute(candidate.path) || privateWorkspace(candidate.path)) continue;
      let path = normalize(candidate.path);
      let available = false;
      try {
        path = await realpath(path);
        if (privateWorkspace(path)) continue;
        if ((await stat(path)).isDirectory()) {
          // Directory metadata alone does not establish read/traversal access.
          // Node ignores X_OK on Windows, where POSIX execute bits do not apply.
          await access(path, constants.R_OK | constants.X_OK);
          available = true;
        }
      } catch { /* Missing directories are choices with an unavailable state. */ }
      results[index] = {
        path,
        name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : basename(path) || path,
        available,
        ...(candidate.botId ? { botId: candidate.botId, botName: candidate.botName } : {}),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, candidates.length) }, inspect));
  const projects = new Map();
  for (const item of results) {
    if (!item) continue;
    const key = pathKey(item.path);
    const existing = projects.get(key);
    if (!existing) projects.set(key, item);
    else if (item.botId) Object.assign(existing, { botId: item.botId, botName: item.botName });
  }
  return { projects: [...projects.values()], ...(warning ? { warning } : {}) };
}
