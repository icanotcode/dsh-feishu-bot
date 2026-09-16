import { spawn as nodeSpawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

class TunnelError extends Error {}
const fail = message => { throw new TunnelError(message); };
const origin = value => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { fail('公网地址必须是 HTTPS 域名，不包含路径或凭据'); }
};

/** Owns only children spawned here. Never installs an OS service or terminates external tunnels. */
export function createTunnelSupervisor({ config, getPort, resolveNgrokToken, detectNgrok, logger }, options = {}) {
  const spawn = options.spawn || nodeSpawn;
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path;
  const home = options.homedir || homedir();
  const now = options.now || Date.now;
  const later = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const interval = options.pollIntervalMs ?? 5000;
  const healthTimeout = options.healthTimeoutMs ?? 120000;
  const shutdownTimeout = options.shutdownTimeoutMs ?? 3000;
  const detectionTimeout = options.detectionTimeoutMs ?? 2000;
  let chain = Promise.resolve(), timer, child, disposed = false, paused = false;
  const closedChildren = new WeakSet();
  let fingerprint, previousAuto = Boolean(config.tunnelAutoRestart), generation = 0;
  let retryCount = 0, retryAt = null, unhealthySince = null, temporaryDir;
  let state = 'idle', message = '隧道尚未启动', url = null, running = false, external = false;
  let activePort = null, activeProvider, ngrokDisconnected = false;
  const enqueue = operation => {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  };
  const timerAfter = (callback, delay) => { const handle = later(callback, delay); handle?.unref?.(); return handle; };
  const clearTimer = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const readPort = () => {
    const value = Number(getPort());
    if (!Number.isInteger(value) || value < 1 || value > 65535) fail('Harness 监听端口无效');
    return value;
  };
  const configKey = port => {
    const provider = config.tunnelProvider || 'ngrok';
    const common = [port, provider, config.connectionMode || 'webhook'];
    if (provider === 'ngrok') return JSON.stringify([...common, config.ngrokExecutablePath,
      config.publicBaseUrl || config.ngrokDomain, config.ngrokTrafficPolicyFile, config.ngrokAuthtokenEnv]);
    if (provider === 'cloudflare') {
      const mode = config.cloudflareMode || 'quick';
      return JSON.stringify([...common, config.cloudflareExecutablePath, mode,
        ...(mode === 'named' ? [config.publicBaseUrl, config.cloudflareTunnelName, config.cloudflareConfigFile] : [])]);
    }
    return JSON.stringify(common);
  };
  const expand = value => {
    if (value === '~') return home;
    return /^~[/\\]/.test(value) ? paths.join(home, value.slice(2)) : value;
  };
  const filePath = value => {
    const expanded = expand(String(value || '').trim());
    if (!expanded || !paths.isAbsolute(expanded)) fail('文件路径必须是本机绝对路径');
    return expanded;
  };
  const executable = (custom, fallback) => {
    if (!custom) return platform === 'win32' ? `${fallback}.exe` : fallback;
    const value = filePath(custom);
    if (/\.(?:cmd|bat|ps1|sh)$/i.test(value)) fail('请选择原生可执行文件，不支持脚本或命令别名');
    return value;
  };
  const snapshot = () => ({ provider: config.tunnelProvider || 'ngrok', mode: config.connectionMode || 'webhook',
    state, running, managed: Boolean(child), url, port: activePort ?? Number(getPort()), autoRestart: Boolean(config.tunnelAutoRestart),
    restartCount: retryCount, nextRetryAt: retryAt, paused, message, ...(child?.pid ? { pid: child.pid } : {}) });
  const schedule = () => {
    if (disposed || (!child && (!config.tunnelAutoRestart || paused))) { clearTimer(); return; }
    if (timer !== undefined) return;
    if (!disposed && (child || (config.tunnelAutoRestart && !paused))) {
      timer = timerAfter(() => { timer = undefined; enqueue(reconcileInternal).catch(() => {}); }, interval);
    }
  };
  const safeFailure = error => {
    state = 'error'; running = false; external = false;
    message = error instanceof TunnelError ? error.message : error?.code === 'ENOENT'
      ? '未找到隧道程序，请安装原生 ngrok/cloudflared 或设置可执行文件路径'
      : error?.code === 'EACCES' ? '隧道程序没有执行权限' : '隧道启动或连接失败，请检查本机程序、网络与配置';
    if (!disposed && config.tunnelAutoRestart && !paused) {
      retryCount += 1;
      retryAt = now() + Math.min(60000, 1000 * 2 ** Math.min(retryCount - 1, 6));
      state = 'backoff';
    } else retryAt = null;
  };
  const cleanup = async directory => { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {}); };
  async function terminate() {
    clearTimer();
    const current = child;
    if (!current) { await cleanup(temporaryDir); temporaryDir = undefined; return true; }
    generation += 1;
    let finished = closedChildren.has(current);
    let done;
    const ended = new Promise(resolve => { done = () => { finished = true; resolve(); }; current.once('close', done); });
    const wait = async ms => {
      let handle;
      await Promise.race([ended, new Promise(resolve => { handle = later(resolve, ms); })]);
      if (handle !== undefined) cancel(handle);
    };
    try {
      if (!finished) { current.kill('SIGTERM'); await wait(shutdownTimeout); }
      if (!finished) { current.kill('SIGKILL'); await wait(shutdownTimeout); }
    } catch { /* Keep ownership if the child cannot be confirmed stopped. */ }
    current.removeListener('close', done);
    if (!finished) { generation -= 1; state = 'error'; message = '无法确认托管隧道已停止，请检查本机进程后重试'; return false; }
    child = undefined;
    running = false; external = false; url = null; unhealthySince = null;
    const directory = temporaryDir; temporaryDir = undefined; await cleanup(directory);
    return true;
  }
  async function detect() {
    if (!detectNgrok) return { running: false };
    let handle;
    try {
      return await Promise.race([Promise.resolve().then(() => detectNgrok(activePort)), new Promise(resolve => {
        handle = later(() => resolve({ running: false, unknown: true }), detectionTimeout);
      })]) || { running: false, unknown: true };
    } catch { return { running: false, unknown: true }; }
    finally { if (handle !== undefined) cancel(handle); }
  }
  function useDetection(result) {
    if (!result.running || !result.url || (child && ngrokDisconnected)) return false;
    let detected;
    try { detected = origin(result.url); } catch { return false; }
    const requested = config.publicBaseUrl || (config.ngrokDomain ? `https://${config.ngrokDomain}` : '');
    if (requested && detected !== origin(requested)) return false;
    url = detected; running = true; unhealthySince = null;
    state = child ? 'running' : 'external'; external = !child;
    message = child ? '托管 ngrok 隧道已连接' : '使用已存在的 ngrok 隧道；插件不会停止外部进程';
    return true;
  }
  async function cloudflareArguments(port) {
    if ((config.cloudflareMode || 'quick') === 'quick') {
      // An explicit empty config prevents a user's named-tunnel defaults changing quick mode.
      temporaryDir = await mkdtemp(path.join(options.tmpdir || tmpdir(), 'dsh-feishu-tunnel-'));
      await chmod(temporaryDir, 0o700);
      const target = path.join(temporaryDir, 'config.yml');
      await writeFile(target, '{}\n', { mode: 0o600, flag: 'wx' });
      return ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--logformat', 'json', '--config', target, '--url', `http://127.0.0.1:${port}`];
    }
    if (config.cloudflareMode !== 'named') fail('Cloudflare 隧道模式无效');
    const name = String(config.cloudflareTunnelName || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) fail('请填写本地 Cloudflare 命名隧道的名称或 UUID');
    const source = filePath(config.cloudflareConfigFile);
    const publicUrl = origin(config.publicBaseUrl);
    const document = yaml.load(await readFile(source, 'utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.ingress)) fail('Cloudflare 配置缺少 ingress 规则');
    if (document.token || document['token-file']) fail('目前仅支持本地管理的命名隧道配置');
    const hostname = new URL(publicUrl).hostname;
    const matching = document.ingress.filter(rule => rule && String(rule.hostname || '').toLowerCase() === hostname);
    if (!matching.length) fail('Cloudflare 配置中找不到与公网域名匹配的 ingress 规则');
    for (const rule of matching) {
      let service;
      try { service = new URL(rule.service); } catch { fail('匹配域名的 ingress 必须指向本机 HTTP 服务'); }
      if (!['http:', 'https:'].includes(service.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(service.hostname) || service.username || service.password || service.search || service.hash || service.pathname !== '/') fail('匹配域名的 ingress 必须指向本机 HTTP 服务');
      rule.service = `http://127.0.0.1:${port}`;
    }
    if (!document['credentials-file']) fail('Cloudflare 本地配置缺少 credentials-file');
    const credentials = expand(String(document['credentials-file']));
    document['credentials-file'] = paths.isAbsolute(credentials) ? credentials : paths.resolve(paths.dirname(source), credentials);
    if (document.origincert) {
      const cert = expand(String(document.origincert));
      document.origincert = paths.isAbsolute(cert) ? cert : paths.resolve(paths.dirname(source), cert);
    }
    await access(document['credentials-file']);
    temporaryDir = await mkdtemp(path.join(options.tmpdir || tmpdir(), 'dsh-feishu-tunnel-'));
    await chmod(temporaryDir, 0o700);
    const target = path.join(temporaryDir, 'config.yml');
    await writeFile(target, yaml.dump(document), { mode: 0o600, flag: 'wx' });
    return ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--logformat', 'json', '--config', target, 'run', name];
  }
  function observeCloudflare(current, mine) {
    const connections = new Set();
    const buffers = new Map();
    const line = text => {
      if (child !== current || generation !== mine || disposed) return;
      let foundUrl = false;
      if ((config.cloudflareMode || 'quick') === 'quick') {
        const match = text.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/i);
        if (match) { url = match[0].toLowerCase(); foundUrl = true; }
      }
      const index = text.match(/connIndex[=":\s]+(\d+)/)?.[1] || '0';
      if (/Registered tunnel connection/i.test(text)) connections.add(index);
      else if (/Unregistered tunnel connection|Connection terminated|Failed to serve tunnel connection|Serve tunnel error/i.test(text)) connections.delete(index);
      else if (!foundUrl) return;
      running = connections.size > 0 && Boolean(url);
      if (running) {
        unhealthySince = null; state = 'running';
        message = (config.cloudflareMode || 'quick') === 'quick'
          ? 'Cloudflare 临时隧道已连接；地址变化后请更新插件公网地址和飞书回调 URL'
          : '托管 Cloudflare 命名隧道已连接';
      } else { unhealthySince ??= now(); state = 'starting'; message = 'Cloudflare 正在连接或重连'; }
    };
    for (const stream of [current.stdout, current.stderr]) stream?.on('data', data => {
      const text = (buffers.get(stream) || '') + String(data);
      const lines = text.split(/\r?\n/); buffers.set(stream, lines.pop().slice(-8192));
      for (const entry of lines) line(entry.slice(0, 8192));
    });
  }
  function observeNgrok(current, mine) {
    const buffers = new Map();
    for (const stream of [current.stdout, current.stderr]) stream?.on('data', data => {
      const lines = ((buffers.get(stream) || '') + String(data)).split(/\r?\n/);
      buffers.set(stream, lines.pop().slice(-8192));
      if (child !== current || generation !== mine || disposed) return;
      for (const entry of lines) {
        let event;
        try { event = JSON.parse(entry.slice(0, 8192)); } catch { continue; }
        const text = String(event.msg || '');
        if (/session established|client session established|started tunnel/i.test(text)) ngrokDisconnected = false;
        else if (/session closed|failed to (?:send authentication|reconnect|dial)|reconnecting|heartbeat timeout|connection closed/i.test(text)) {
          ngrokDisconnected = true; running = false; unhealthySince ??= now();
          state = 'starting'; message = 'ngrok 正在连接或重连';
        }
      }
    });
  }
  async function launch() {
    if (disposed || child) return;
    const launchKey = fingerprint;
    try {
      if (activeProvider === 'ngrok') {
        const detected = await detect();
        if (disposed) return;
        if (useDetection(detected)) return;
        if (detected.unknown) fail('无法确认现有 ngrok 状态，稍后再试以避免重复启动');
        if (detected.running || detected.reachable) fail('已有 ngrok 服务但没有匹配隧道，请检查其端口与域名后再启动');
      }
      let args, command, env = { ...process.env };
      if (activeProvider === 'ngrok') {
        command = executable(config.ngrokExecutablePath, 'ngrok');
        args = ['http', `http://127.0.0.1:${activePort}`];
        const requested = config.publicBaseUrl || (config.ngrokDomain ? `https://${config.ngrokDomain}` : '');
        if (requested) args.push('--url', origin(requested));
        let policy = config.ngrokTrafficPolicyFile ? filePath(config.ngrokTrafficPolicyFile) : paths.join(home, '.config', 'ngrok', 'policy.yaml');
        try { await access(policy, constants.R_OK); } catch (error) { if (config.ngrokTrafficPolicyFile || error?.code !== 'ENOENT') fail('ngrok Traffic Policy 文件不可读取'); policy = null; }
        if (policy) args.push('--traffic-policy-file', policy);
        args.push('--log', 'stdout', '--log-format', 'json');
        const token = await resolveNgrokToken?.();
        if (token) env.NGROK_AUTHTOKEN = token;
      } else {
        delete env.TUNNEL_TOKEN; delete env.TUNNEL_TOKEN_FILE;
        command = executable(config.cloudflareExecutablePath, 'cloudflared');
        args = await cloudflareArguments(activePort);
      }
      if (disposed || configKey(readPort()) !== launchKey) { await cleanup(temporaryDir); temporaryDir = undefined; return; }
      state = 'starting'; running = false; external = false; retryAt = null;
      url = activeProvider === 'cloudflare' && config.cloudflareMode === 'named' ? origin(config.publicBaseUrl) : null;
      message = '隧道进程已启动，正在等待公网连接'; unhealthySince = now(); ngrokDisconnected = false;
      const current = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      child = current;
      const mine = ++generation;
      const ended = error => {
        if (child !== current || generation !== mine) return;
        generation += 1; child = undefined; running = false; url = null;
        const directory = temporaryDir; temporaryDir = undefined;
        // Publish the backoff before an in-flight health check can resume and launch again.
        if (!disposed) safeFailure(error);
        schedule();
        enqueue(() => cleanup(directory)).catch(() => {});
      };
      current.once('error', error => { if (!current.pid) ended(error); else if (child === current) safeFailure(error); });
      current.once('close', () => { closedChildren.add(current); ended(); });
      if (activeProvider === 'cloudflare') observeCloudflare(current, mine);
      else observeNgrok(current, mine);
      await Promise.resolve();
    } catch (error) {
      await cleanup(temporaryDir); temporaryDir = undefined;
      safeFailure(error);
    }
  }
  async function reconcileInternal(manual = false, inspectExternal = false) {
    if (disposed) return snapshot();
    try {
      const port = readPort();
      const provider = config.tunnelProvider || 'ngrok';
      const mode = config.connectionMode || 'webhook';
      const key = configKey(port);
      const changed = fingerprint !== undefined && key !== fingerprint;
      const autoEnabled = Boolean(config.tunnelAutoRestart) && !previousAuto;
      if (changed) {
        if (!await terminate()) { schedule(); return snapshot(); }
        retryAt = null; retryCount = 0; running = false; external = false; url = null; state = 'idle';
      }
      if (changed || autoEnabled || manual) paused = false;
      if (!config.tunnelAutoRestart) { retryAt = null; if (state === 'backoff') state = 'error'; }
      previousAuto = Boolean(config.tunnelAutoRestart); fingerprint = key;
      activePort = port; activeProvider = provider;
      if (mode !== 'webhook' || !['ngrok', 'cloudflare'].includes(provider)) {
        if (child && !await terminate()) return snapshot();
        state = mode !== 'webhook' ? 'not_required' : 'unsupported'; running = false; url = null;
        message = mode !== 'webhook' ? '长连接模式不需要公网隧道' : '自定义公网地址不支持进程管理';
        clearTimer(); return snapshot();
      }
      if (child && provider === 'ngrok') {
        const observedChild = child, observedGeneration = generation;
        const result = await detect();
        // The process can close while its API request is pending. Its response is stale then.
        if (disposed || child !== observedChild || generation !== observedGeneration) {
          schedule(); return snapshot();
        }
        if (!useDetection(result)) { running = false; unhealthySince ??= now(); state = 'starting'; message = 'ngrok 正在连接或重连'; }
      }
      if (child && unhealthySince !== null && now() - unhealthySince >= healthTimeout) {
        if (config.tunnelAutoRestart && !paused) {
          if (await terminate()) safeFailure(new TunnelError('隧道长时间未连接，等待自动重试'));
        } else { state = 'error'; message = '隧道长时间未连接，请检查网络或停止后重新启动'; }
      }
      if (!child && !paused && (manual || config.tunnelAutoRestart) && (manual || !retryAt || now() >= retryAt)) await launch();
      else if (!child && !retryAt && inspectExternal && provider === 'ngrok') {
        const result = await detect();
        if (!useDetection(result)) {
          const wasExternal = external;
          running = false; external = false; url = null;
          if (result.unknown || result.reachable || result.running) {
            state = 'error';
            message = result.unknown ? '无法确认现有 ngrok 状态，稍后再试以避免重复启动'
              : '已有 ngrok 服务但没有匹配隧道，请检查其端口与域名后再启动';
          } else if (wasExternal) { state = 'idle'; message = '外部 ngrok 隧道已停止'; }
        }
      }
      schedule(); return snapshot();
    } catch (error) { safeFailure(error); schedule(); return snapshot(); }
  }
  return {
    start: () => enqueue(() => reconcileInternal(true)),
    stop: () => enqueue(async () => {
      paused = true; retryAt = null;
      const owned = Boolean(child);
      if (await terminate()) {
        state = external && !owned ? 'external' : 'idle';
        message = external && !owned ? '外部隧道由其他进程管理，插件不会停止它' : '托管隧道已停止；再次启动或重新开启守护可恢复';
      }
      return snapshot();
    }),
    status: () => enqueue(() => reconcileInternal(false, true)),
    reconcile: () => enqueue(async () => { await reconcileInternal(); }),
    dispose: () => { disposed = true; clearTimer(); return enqueue(async () => { if (!await terminate()) throw new TunnelError('无法确认托管隧道已停止，请检查本机进程'); state = 'idle'; retryAt = null; }); },
  };
}
