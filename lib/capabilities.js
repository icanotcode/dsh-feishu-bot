import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

/**
 * 通用能力桥（数据驱动，薄代理）：
 * - 扫描 ~/.dsh/skills/ 自动注册能力（加技能目录即注册，插件零改动）
 * - 有 feishu.json → 按显式清单暴露（角色/指令文件/命令模板）
 * - 无 feishu.json → 自动派生：summary 取 SKILL.md 的 description，指令体为 SKILL.md，
 *   角色用全局默认（defaultRoles），load-only 不开放命令（脚本执行必须显式声明）
 * - list 可见清单 / load 指令体 / run 清单内预声明的命令模板（argv 数组，无 shell）
 */
const SKILLS_ROOT = process.env.DSH_FEISHU_SKILLS_ROOT || join(homedir(), '.dsh', 'skills');
const MAX_OUTPUT_CHARS = 8000;
const RUN_TIMEOUT_MS = 15000;
const MAX_INSTRUCTION_CHARS = 12000;
const AUTO_LOAD_CAVEAT = '（说明：以下是该技能的原始说明文档。你在飞书隔离会话中——无 bash、无 skill 工具、文件仅限自己工作区；其中要求执行脚本/命令的部分对你不可用，请如实告知用户限制，或用对话方式尽力完成。）\n\n';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
export const capabilityTool = {
  name: 'feishu_capability',
  timeoutMs: 20000,
  description: 'Invoke capabilities granted to you as a Feishu user. action=list shows your granted capabilities; action=load returns a capability\'s instructions (follow them exactly); action=run executes one of its declared commands (name from the instructions, args per its declared schema). Never attempt unlisted capabilities or undeclared commands.',
  parameters: object({
    action: { type: 'string', enum: ['list', 'load', 'run'] },
    name: { type: 'string', description: 'capability name (required for load/run)' },
    command: { type: 'string', description: 'declared command name (required for run)' },
    args: { type: 'object', description: 'command arguments as declared by the capability' },
  }),
};

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

function deriveManifest(skillText, defaultRoles) {
  const description = /^description:\s*(.+)$/m.exec(skillText)?.[1]?.trim() || '';
  return {
    auto: true,
    roles: defaultRoles,
    summary: description.slice(0, 120) || '（未提供描述）',
    instructions: 'SKILL.md',
    commands: {},
  };
}

async function scanCapabilities(defaultRoles = []) {
  let entries = [];
  try { entries = await readdir(SKILLS_ROOT, { withFileTypes: true }); } catch { return []; }
  const caps = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(SKILLS_ROOT, entry.name);
    const manifest = await readJson(join(dir, 'feishu.json'));
    if (manifest) {
      if (manifest.enabled === false) continue;
      caps.push({ name: entry.name, dir, manifest });
      continue;
    }
    // 无声明文件 → 自动派生（load-only）
    let skillText = null;
    try { skillText = await readFile(join(dir, 'SKILL.md'), 'utf8'); } catch { continue; }
    caps.push({ name: entry.name, dir, manifest: deriveManifest(skillText, defaultRoles) });
  }
  return caps;
}

const SUPER_ROLE = 'superadmin';
const granted = (manifest, roles) => roles.includes(SUPER_ROLE)
  || (manifest.roles || []).some(role => roles.includes(role));

async function grantedCapabilities(roles, defaultRoles) {
  return (await scanCapabilities(defaultRoles)).filter(cap => granted(cap.manifest, roles));
}

function safeJoin(root, rel) {
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) throw new Error('非法路径');
  return full;
}

function runCommand(cap, commandName, args = {}) {
  const spec = cap.manifest.commands?.[commandName];
  if (!spec || !Array.isArray(spec.argv) || !spec.argv.length) throw new Error(`能力 ${cap.name} 没有声明命令 ${commandName}`);
  const declared = spec.args || {};
  for (const key of Object.keys(args)) {
    if (!declared[key]) throw new Error(`命令 ${commandName} 不接受参数 ${key}`);
  }
  const fill = template => {
    let out = template;
    for (const [key, pattern] of Object.entries(declared)) {
      const placeholder = `{${key}}`;
      if (!out.includes(placeholder)) continue;
      const value = args[key];
      if (value === undefined) throw new Error(`命令 ${commandName} 缺少参数 ${key}`);
      if (typeof value !== 'string' || !new RegExp(`^(?:${pattern})$`).test(value)) throw new Error(`参数 ${key} 格式不合法`);
      out = out.split(placeholder).join(value);
    }
    if (/\{[a-zA-Z_]+\}/.test(out)) throw new Error(`命令 ${commandName} 缺少必需参数`);
    return out;
  };
  const argv = spec.argv.map(fill);
  const stdin = typeof spec.stdin === 'string' ? fill(spec.stdin) : null;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: cap.dir, shell: false, stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(rejectRun, new Error(`命令执行超时（${RUN_TIMEOUT_MS / 1000}s）`)); }, RUN_TIMEOUT_MS);
    const collect = chunk => {
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT_CHARS) { child.kill('SIGKILL'); finish(rejectRun, new Error('命令输出超过上限')); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { clearTimeout(timer); finish(rejectRun, error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) finish(resolveRun, output.trim());
      else finish(rejectRun, new Error(`命令退出码 ${code}：${output.slice(-500)}`));
    });
    if (stdin !== null) { child.stdin.write(stdin); child.stdin.end(); }
  });
}

export function createCapabilityBridge({ rolesFor, defaultRoles = [] } = {}) {
  const rolesOf = identity => {
    try { return rolesFor?.(identity?.openId) || []; } catch { return []; }
  };
  return {
    /** 注入每条飞书消息的能力段落（无授予能力时为空串）。 */
    async section(identity) {
      const caps = await grantedCapabilities(rolesOf(identity), defaultRoles);
      if (!caps.length) return '';
      const lines = caps.map(cap => `- ${cap.name}：${cap.manifest.summary || cap.manifest.description || '（无描述）'}`).join('\n');
      return `\n\n你被额外授予以下能力（通过 feishu_capability 工具调用，先 action=load 读取能力指令并严格遵循，再按指令 action=run 执行其声明的命令）：\n${lines}\n用户问「你会什么/有什么功能/技能列表」时，把以上能力与内置工具一起列出。未列出的能力不要声称拥有。`;
    },
    async execute(args, binding) {
      const roles = rolesOf(binding?.identity);
      if (args.action === 'list') {
        const caps = await grantedCapabilities(roles, defaultRoles);
        return { capabilities: caps.map(cap => ({ name: cap.name, summary: cap.manifest.summary || '' })) };
      }
      const caps = await grantedCapabilities(roles, defaultRoles);
      const cap = caps.find(item => item.name === args.name);
      if (!cap) throw new Error(`能力不存在或未授予：${args.name || '(未指定)'}`);
      if (args.action === 'load') {
        const rel = cap.manifest.instructions || 'FEISHU.md';
        const text = await readFile(safeJoin(cap.dir, rel), 'utf8');
        const body = text.slice(0, MAX_INSTRUCTION_CHARS);
        return { name: cap.name, instructions: cap.manifest.auto ? AUTO_LOAD_CAVEAT + body : body };
      }
      if (args.action === 'run') {
        const commandRoles = cap.manifest.commands?.[args.command]?.roles;
        if (commandRoles && !commandRoles.some(role => roles.includes(role))) throw new Error(`命令 ${args.command} 未授予当前用户`);
        return { output: await runCommand(cap, args.command, args.args || {}) };
      }
      throw new Error(`未知 action：${args.action}`);
    },
  };
}
