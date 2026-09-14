import { access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { url: process.env.NGROK_URL, port: '3080', background: false };
const input = process.argv.slice(2);
for (let index = 0; index < input.length; index++) {
  const flag = input[index];
  if (flag === '--background') options.background = true;
  else if (['--url', '--port', '--traffic-policy-file'].includes(flag)) {
    const value = input[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 需要参数`);
    options[flag.slice(2)] = value;
  } else if (flag === '--help') {
    console.log('Usage: node scripts/start-ngrok.mjs --url https://YOUR-DOMAIN [--port 3080] [--traffic-policy-file PATH] [--background]\nURL may also be set via NGROK_URL.');
    process.exit(0);
  } else throw new Error(`未知参数：${flag}`);
}
if (!options.url) throw new Error('请通过 --url 或 NGROK_URL 指定 ngrok HTTPS 地址');
const url = new URL(options.url);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('ngrok URL 必须是 HTTPS 域名，不包含路径、查询参数或凭据');
if (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) throw new Error('--port 必须在 1 到 65535 之间');
const args = ['http', options.port, '--url', url.origin];
if (options['traffic-policy-file']) {
  const policy = resolve(options['traffic-policy-file']);
  await access(policy);
  args.push('--traffic-policy-file', policy);
}
await launch('ngrok', args, { background: options.background, runtimeDir: join(root, '.runtime'), name: 'ngrok' });
