import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findHarnessEntry } from './harness-entry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nextStep = 'Settings → Plugins → Plugin list → 飞书机器人';

export function checkNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!(major > 22 || major === 22 && minor >= 13)) {
    throw new Error(`需要 Node.js 22.13 或更新版本；当前为 ${version}。请先升级 Node.js，再重新运行 npm run setup:harness。`);
  }
}

export function parseSetupArgs(args) {
  const options = { noStart: false, port: 3080, host: '127.0.0.1', help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-start') options.noStart = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--background') { /* Background is already the setup default. */ }
    else if (arg === '--port' || arg === '--host') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} 需要一个值。`);
      if (arg === '--port') {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
          throw new Error('--port 必须是 1–65535 的整数。');
        }
        options.port = Number(value);
      } else {
        if (!/^[a-zA-Z0-9.:%_-]+$/.test(value)) throw new Error('--host 必须是主机名或 IP 地址。');
        options.host = value;
      }
    } else throw new Error(`不支持参数 ${arg}。请使用 --help 查看用法；高级启动参数请用 npm run start:harness。`);
  }
  return options;
}

// An open TCP port alone never proves the process is Harness. Do not send
// credentials, stop the process, or claim the plugin is running on that basis.
export function isPortOccupied(host, port) {
  const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return new Promise((resolveProbe, reject) => {
    const socket = createConnection({ host: target, port });
    const finish = (error, occupied) => {
      socket.destroy();
      if (error) reject(error); else resolveProbe(occupied);
    };
    socket.once('connect', () => finish(null, true));
    socket.once('error', error => error.code === 'ECONNREFUSED'
      ? finish(null, false)
      : finish(new Error(`无法检查 ${target}:${port}（${error.code || '连接失败'}）。请确认 --host/--port 和本机网络。`)));
    socket.setTimeout(1500, () => finish(new Error(`检查 ${target}:${port} 超时，未自动启动第二个服务。请确认 --host/--port。`)));
  });
}

function runScript(name, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', name), ...args], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${name} 未完成（${signal || code}）。请按上方提示处理后重新运行；已完成的安装步骤可以安全重试。`)));
  });
}

export async function setup(args = process.argv.slice(2), env = process.env) {
  const options = parseSetupArgs(args);
  if (options.help) {
    console.log('用法：npm run setup:harness -- [--no-start] [--port 3080] [--host 127.0.0.1]');
    console.log('检查环境、安装飞书插件并在后台启动 Harness。保留已有配置；不停止已有进程。');
    console.log('DSH_HOME 指定 Harness 数据目录；DSH_BIN 指定已安装的 Harness JS 入口或可执行文件。');
    return 0;
  }
  checkNodeVersion();
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    try { import.meta.resolve(dependency); }
    catch { throw new Error(`缺少插件依赖 ${dependency}。请先在插件目录运行 npm install，再重新运行 npm run setup:harness。`); }
  }
  const executable = await findHarnessEntry({ env });
  try { await access(executable, /\.[cm]?js$/i.test(executable) || process.platform === 'win32' ? constants.F_OK : constants.X_OK); }
  catch { throw new Error('Harness 入口不存在或不可执行。请检查 DSH_BIN，或先安装 @deepseek-ai/dsh，再重试。'); }
  console.log('Node.js、插件依赖及 Harness 入口检查通过。');
  await runScript('install.mjs', [], env);
  if (options.noStart) {
    console.log(`安装完成，未启动 Harness。下一步启动 Harness，然后打开 ${nextStep}。`);
    return 0;
  }
  if (await isPortOccupied(options.host, options.port)) {
    console.error(`端口 ${options.port} 已有服务，无法仅凭端口确认它是 Harness，因此未创建新进程。`);
    console.error(`如果这是使用同一 DSH_HOME 的 Harness，请刷新页面并打开 ${nextStep}；插件未显示时请由现有服务管理器重新加载。`);
    console.error('如果是其他服务，请用 npm run setup:harness -- --port 其他端口 重试。');
    return 2;
  }
  await runScript('start.mjs', ['--background', '--host', options.host, '--port', String(options.port)], { ...env, DSH_BIN: executable });
  const browserHost = options.host === '0.0.0.0' ? '127.0.0.1' : options.host === '::' ? '::1' : options.host;
  const authority = browserHost.includes(':') ? `[${browserHost}]` : browserHost;
  console.log(`Harness 启动请求已提交；启动进度、就绪状态及登录入口请查看 ${join(root, '.runtime', 'harness.log')}。`);
  console.log(`服务就绪后打开 http://${authority}:${options.port} ，进入 ${nextStep}。`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await setup(); }
  catch (error) { console.error(`配置未完成：${error.message}`); process.exitCode = 1; }
}
