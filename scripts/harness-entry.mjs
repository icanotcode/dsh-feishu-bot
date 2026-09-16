import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function exists(path, executable = false) {
  try { await access(path, executable ? constants.X_OK : constants.F_OK); return true; }
  catch { return false; }
}

// npm's extensionless Windows shim is a shell script. Resolve the package's
// JavaScript entry instead of executing that shim or introducing a shell.
export async function findHarnessEntry({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.DSH_BIN) {
    if (/\.(cmd|bat)$/i.test(env.DSH_BIN)) throw new Error('DSH_BIN 不支持 .cmd/.bat，请指定 Harness 的 JS 入口或原生可执行文件。');
    if (platform === 'win32' && !/\.(?:[cm]?js|exe)$/i.test(env.DSH_BIN)) throw new Error('Windows 的 DSH_BIN 请指定 Harness 的 JS 入口或 .exe，不能使用 npm 的 shell shim。');
    return env.DSH_BIN;
  }
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    if (platform === 'win32') {
      const native = join(dir, 'dsh.exe');
      if (await exists(native)) return native;
      const entry = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (await exists(entry)) return entry;
    } else {
      const entry = join(dir, 'dsh');
      if (await exists(entry, true)) return entry;
    }
  }
  const caches = [
    env.npm_config_cache,
    platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'npm-cache') : undefined,
    join(home, '.npm'),
  ].filter(Boolean);
  for (const cache of new Set(caches)) {
    const npx = join(cache, '_npx');
    for (const entry of await readdir(npx).catch(() => [])) {
      const candidate = join(npx, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (await exists(candidate)) return candidate;
    }
  }
  throw new Error('未找到 Harness。请先安装 @deepseek-ai/dsh，或用 DSH_BIN 指定入口（Windows 请指定 JS 入口或 .exe）。');
}
