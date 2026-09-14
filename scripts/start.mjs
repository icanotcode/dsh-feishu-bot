import { readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launch } from './process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let executable = process.env.DSH_BIN;
const candidates = process.platform === 'win32' ? ['dsh.exe', 'dsh'] : ['dsh'];
for (const dir of (process.env.PATH || '').split(delimiter)) {
  if (executable) break;
  for (const name of candidates) {
    const candidate = join(dir, name);
    try { await access(candidate, constants.X_OK); executable = candidate; break; } catch {}
  }
}
if (!executable) {
  const cache = join(homedir(), '.npm', '_npx');
  for (const entry of await readdir(cache).catch(() => [])) {
    const candidate = join(cache, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    try { await access(candidate); executable = candidate; break; } catch {}
  }
}
if (!executable) throw new Error('未找到 Harness。请先安装 @deepseek-ai/dsh，或用 DSH_BIN 指定入口（Windows 请指定 JS 入口或 .exe）。');
if (/\.(cmd|bat)$/i.test(executable)) throw new Error('DSH_BIN 不支持 .cmd/.bat，请指定 Harness 的 JS 入口或原生可执行文件。');
const background = process.argv.includes('--background');
const args = process.argv.slice(2).filter(arg => arg !== '--background');
const javascript = /\.[cm]?js$/i.test(executable);
await launch(javascript ? process.execPath : executable,
  [...(javascript ? [executable] : []), 'web', '--no-open', ...args],
  { cwd: dirname(root), background, runtimeDir: join(root, '.runtime'), name: 'harness' });
