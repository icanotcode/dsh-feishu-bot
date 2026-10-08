// 海报渲染工具：模板 + 槽位 → 工作区 HTML → headless chromium 截图成 PNG。
//
// 安全模型：
// - 渲染环境断网（--host-resolver-rules 全域名解析到 NOTFOUND），模板只用系统字体；
// - 槽位文本在模板侧统一 HTML 转义；chromium 以数组参数启动，不经 shell；
// - 输出限定写回用户自己的工作区，文件名由插件生成；
// - 45 秒超时强杀，临时 HTML 与 profile 目录用后清理。

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { checkedPath } from './user-tools.js';
import { renderTemplate, listTemplates } from './poster-templates.js';

const RENDER_TIMEOUT_MS = 45_000;
const CHROMIUM = process.env.FEISHU_POSTER_CHROMIUM || 'chromium';

export const posterToolDefinitions = [
  {
    name: 'feishu_poster_render',
    description: '把海报渲染成 PNG 图片（服务端 chromium 截图，1080×1500）。两种用法：① template+slots：从内置专业模板（business-navy 深蓝商务 / stage-gold 发布会金句 / magazine-fresh 清新杂志）生成，slots 填 title（必填）、kicker、subtitle、highlight、sections[{heading,body}]（最多 4 条）、footer、brand；② htmlPath：渲染工作区内已有的 .html 文件。返回工作区内 PNG 相对路径，需再用 feishu_send_file(kind=image) 发给用户。',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'string', description: '内置模板 id；与 htmlPath 二选一' },
        slots: { type: 'string', description: 'JSON 字符串：模板槽位内容，title 必填' },
        htmlPath: { type: 'string', description: '工作区内 .html 文件的相对路径；与 template 二选一' },
        outputName: { type: 'string', description: '输出 PNG 文件名（不含扩展名），默认自动生成' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

function screenshot(htmlPath, pngPath, profileDir) {
  return new Promise((resolvePromise, reject) => {
    const argv = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      `--user-data-dir=${profileDir}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--hide-scrollbars', '--force-device-scale-factor=2',
      '--window-size=1080,1500', `--screenshot=${pngPath}`, '--virtual-time-budget=8000',
      `file://${htmlPath}`,
    ];
    const child = spawn(CHROMIUM, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(reject, new Error('海报渲染超时（45 秒）')); }, RENDER_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (err.length < 2000) err += chunk; });
    child.on('error', e => done(reject, new Error(`渲染器不可用：${e.message}`)));
    child.on('close', code => {
      if (code !== 0) return done(reject, new Error(`渲染失败（退出码 ${code}）：${err.trim().slice(0, 200)}`));
      done(resolvePromise);
    });
  });
}

export async function executePosterTool(name, args, binding) {
  if (name !== 'feishu_poster_render') throw new Error('Tool unavailable');
  const work = await mkdtemp(join(tmpdir(), 'poster-'));
  try {
    let htmlPath;
    if (args.template) {
      if (args.htmlPath) throw new Error('template 与 htmlPath 只能二选一');
      let slots;
      try { slots = JSON.parse(args.slots || '{}'); } catch { throw new Error('slots 必须是合法 JSON 字符串'); }
      await writeFile(htmlPath = join(work, 'poster.html'), renderTemplate(args.template, slots), 'utf8');
    } else if (args.htmlPath) {
      htmlPath = await checkedPath(binding.workspacePath, args.htmlPath);
      if (!htmlPath.toLowerCase().endsWith('.html')) throw new Error('仅支持渲染 .html 文件');
    } else {
      throw new Error(`需要 template 或 htmlPath 之一。可用模板：${listTemplates().map(t => `${t.id}（${t.name}）`).join('、')}`);
    }

    const base = typeof args.outputName === 'string' && /^[A-Za-z0-9_一-龥-]{1,40}$/.test(args.outputName)
      ? args.outputName : `海报-${randomUUID().slice(0, 8)}`;
    const pngName = `${base}.png`;
    const pngPath = await checkedPath(binding.workspacePath, pngName, true);
    await screenshot(htmlPath, pngPath, join(work, 'profile'));
    const info = await stat(pngPath);
    if (!info.size) throw new Error('渲染产物为空');
    return { path: pngName, bytes: info.size, templates: listTemplates() };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
