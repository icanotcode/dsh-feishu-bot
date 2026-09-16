import { access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { background: false };
const input = process.argv.slice(2);
for (let index = 0; index < input.length; index++) {
  const flag = input[index];
  if (flag === '--background') options.background = true;
  else if (['--port', '--name', '--config'].includes(flag)) {
    const value = input[++index];
    if (!value || value.startsWith('-')) throw new Error(`${flag} 需要参数`);
    options[flag.slice(2)] = value;
  } else if (flag === '--help') {
    console.log('Usage: node scripts/start-cloudflare.mjs [--port 3080] [--background]\n       node scripts/start-cloudflare.mjs --name NAME [--config PATH] [--background]\nQuick Tunnel URLs change on restart. Copy the HTTPS URL from the output/log into the plugin and update the Feishu callback URL. Named tunnels must already be configured; their ingress determines the target port.');
    process.exit(0);
  } else throw new Error(`未知参数：${flag}`);
}
if (options.name && options.port !== undefined) throw new Error('--name 与 --port 不能同时使用；命名隧道请在 ingress 中配置 Harness 端口');
if (options.config && !options.name) throw new Error('--config 仅用于 --name 指定的命名隧道');
if (options.name && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.name)) throw new Error('--name 必须是有效的隧道名称或 UUID');
const args = ['tunnel'];
if (options.name) {
  if (options.config) {
    const configPath = resolve(options.config);
    await access(configPath);
    args.push('--config', configPath);
  }
  args.push('run', options.name);
} else {
  const port = options.port ?? '3080';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('--port 必须在 1 到 65535 之间');
  args.push('--url', `http://127.0.0.1:${Number(port)}`);
}
await launch('cloudflared', args, { background: options.background, runtimeDir: join(root, '.runtime'), name: 'cloudflared' });
