import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createInventoryDOM } from '../test-support/inventory-dom.mjs';

const source = await readFile(new URL('../client/index.js', import.meta.url), 'utf8');

function inventoryFixture(t, prepare = () => {}) {
  const dom = createInventoryDOM();
  const disposers = [];
  const registrations = [];
  let plugin;
  const React = { createElement: (type, props) => ({ type, props }) };
  prepare(dom);
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: definition => {
      plugin = definition.factory(name => {
        if (name === 'react') return React;
        if (name === 'react-dom/client') return dom.reactDOM;
        throw new Error(`Unexpected client dependency: ${name}`);
      });
    } } },
    document: dom.document,
    MutationObserver: dom.MutationObserver
  });
  plugin.apply({
    effect(callback) { disposers.push(callback()); },
    slots: { inject(name) { registrations.push(name); }, register(metadata) { registrations.push(metadata.name); } }
  });
  function dispose() { disposers.splice(0).reverse().forEach(cleanup => cleanup?.()); }
  t.after(dispose);
  dom.flush();
  return { ...dom, registrations, dispose };
}

test('inventory attaches only to exact public and legacy plugin cards with owned details', t => {
  const cards = {};
  const f = inventoryFixture(t, dom => {
    cards.public = dom.card();
    cards.legacy = dom.card('@deepseek-ai/dsh-feishu-bot');
    cards.other = dom.card('@someone/dsh-feishu-bot');
    cards.similar = dom.card('@icanotcode/dsh-feishu-bot-extra');
    cards.closed = dom.card('@icanotcode/dsh-feishu-bot', false);
    cards.foreignDetails = dom.card();
    cards.foreignDetails.button.setAttribute('aria-controls', cards.other.details.getAttribute('id'));
    cards.noTrigger = dom.card();
    cards.noTrigger.button.remove();
  });
  assert.equal(f.roots.length, 2);
  assert.deepEqual(f.registrations, [], 'the inventory must be the sole navigation entry');
  for (const name of ['public', 'legacy']) {
    assert.equal(cards[name].details.children.length, 1);
    assert.equal(cards[name].element.getAttribute('data-feishu-settings'), 'true');
  }
  for (const name of ['other', 'similar', 'closed', 'foreignDetails', 'noTrigger']) {
    assert.equal(cards[name].details.children.length, 0);
    assert.equal(cards[name].element.getAttribute('data-feishu-settings'), null);
  }
});

test('inventory expansion mounts once, collapse unmounts, and reopening gets a fresh root', t => {
  let card;
  const f = inventoryFixture(t, dom => { card = dom.card('@icanotcode/dsh-feishu-bot', false); });
  assert.equal(f.roots.length, 0);
  card.element.setAttribute('data-open', 'true');
  f.flush();
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].renders.length, 1);
  card.details.appendChild(f.document.createElement('p'));
  f.flush();
  assert.equal(f.roots.length, 1, 'unrelated inventory mutations must retain draft state');
  assert.equal(f.roots[0].renders.length, 1);
  const panel = f.document.createElement('section');
  f.document.body.appendChild(panel);
  panel.appendChild(card.element);
  panel.setAttribute('hidden', '');
  f.flush();
  assert.equal(f.roots[0].unmounts, 0, 'switching away from a retained hidden tab must preserve draft state');
  panel.removeAttribute('hidden');
  card.element.setAttribute('data-open', 'false');
  f.flush();
  assert.equal(f.roots[0].unmounts, 1);
  assert.equal(f.roots[0].container.isConnected, false);
  assert.equal(card.element.getAttribute('data-feishu-settings'), null);
  card.element.setAttribute('data-open', 'true');
  f.flush();
  assert.equal(f.roots.length, 2);
  assert.equal(f.roots[1].renders.length, 1);
  assert.equal(f.roots[1].unmounts, 0);
});

test('inventory search removal and replacement details release stale roots', t => {
  let card;
  const f = inventoryFixture(t, dom => { card = dom.card(); });
  card.element.remove();
  f.flush();
  assert.equal(f.roots[0].unmounts, 1);
  assert.equal(card.details.children.length, 0);
  f.document.body.appendChild(card.element);
  f.flush();
  assert.equal(f.roots.length, 2);
  const replacement = f.document.createElement('div');
  replacement.setAttribute('id', card.details.getAttribute('id'));
  card.details.remove();
  card.element.appendChild(replacement);
  f.flush();
  assert.equal(f.roots[1].unmounts, 1);
  assert.equal(f.roots.length, 3);
  assert.equal(replacement.contains(f.roots[2].container), true);
});

test('inventory plugin disposal disconnects observation and removes mounted roots and styles', t => {
  let card;
  const f = inventoryFixture(t, dom => { card = dom.card(); });
  assert.equal(f.document.head.children.length, 1);
  f.dispose();
  assert.equal(f.observers.length, 1);
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.roots[0].unmounts, 1);
  assert.equal(card.details.children.length, 0);
  assert.equal(card.element.getAttribute('data-feishu-settings'), null);
  assert.equal(f.document.head.children.length, 0);
  f.card();
  f.flush();
  f.dispose();
  assert.equal(f.roots.length, 1, 'disposed plugins must not attach to later inventory renders');
  assert.equal(f.roots[0].unmounts, 1);
});

async function fixture(t, initial = {}, options = {}) {
  let hooks = [];
  const instances = new Map();
  const effects = [];
  const timers = new Map();
  const requests = [];
  const registrations = [];
  const disposers = [];
  let cursor = 0;
  let tree;
  let component;
  let plugin;
  const dom = createInventoryDOM(vnode => { component = vnode.type; });
  dom.card();
  let timerId = 0;
  let saved = { connectionMode: 'webhook', tunnelProvider: 'ngrok', harnessPort: 4321, appId: 'cli_example', configured: { appSecret: true, verificationToken: true }, ...initial };
  const projectCatalog = options.projects || [{ path: '/srv/customer', name: '客户项目', available: true }];
  const projectsWarning = options.projectsWarning;
  const bots = [{ id: 'default', name: '默认机器人', enabled: true }, ...(options.bots || [])];
  const configs = new Map(bots.map(bot => [bot.id, { ...saved, appId: `cli_${bot.id}`, ...bot.config }]));
  configs.set('default', saved);
  let confirmation = true;
  let confirmations = 0;
  let tunnelOverride;
  const failures = new Map();
  const pauses = new Map();
  let runtime = { mode: saved.connectionMode, state: saved.connectionMode === 'webhook' ? 'listening' : 'connected', message: '' };
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }),
    useId: () => 'feishu-test',
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = value;
      const state = hooks;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        const state = hooks;
        effects.push(() => { previous?.cleanup?.(); state[index] = { deps, cleanup: callback() }; });
      }
    }
  };
  vm.runInNewContext(source, {
    window: { confirm: () => { confirmations++; return confirmation; }, __ModuleLoader__: { load: definition => { plugin = definition.factory(name => {
      if (name === 'react') return React;
      if (name === 'react-dom/client') return dom.reactDOM;
      throw new Error(`Unexpected client dependency: ${name}`);
    }); } } },
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (failures.has(url)) throw new Error(failures.get(url));
      if (pauses.has(url)) await pauses.get(url);
      if (url === '/api/feishu-bot/projects') return { ok: true, status: 200, json: async () => ({ projects: projectCatalog, warning: projectsWarning }) };
      if (url === '/api/feishu-bot/bots') {
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          const bot = { id: `bot-${bots.length}`, ...body, enabled: true };
          bots.push(bot);
          configs.set(bot.id, { ...saved, appId: '', workspacePath: body.workspacePath, connectionMode: 'webhook' });
          return { ok: true, status: 200, json: async () => ({ success: true, bot }) };
        }
        return { ok: true, status: 200, json: async () => ({ bots, defaultBotId: 'default' }) };
      }
      const botId = url.match(/\/bots\/([^/]+)\//)?.[1] || 'default';
      let config = configs.get(botId);
      const bot = bots.find(item => item.id === botId);
      if (url.endsWith('/meta')) {
        Object.assign(bot, JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ success: true, bot }) };
      }
      if (url.endsWith('/config') && options.method === 'POST') {
        config = { ...config, ...JSON.parse(options.body) };
        configs.set(botId, config);
        if (botId === 'default') {
          saved = config;
          runtime = { mode: saved.connectionMode, state: saved.connectionMode === 'webhook' ? 'listening' : 'connecting', message: '' };
        }
      }
      if (url.endsWith('/setup/check') || url.endsWith('/setup/repair')) return { ok: true, status: 200, json: async () => options.setupReport || {
        ready: false, checkedAt: '2026-09-17T00:00:00Z', callbackUrl: `https://example.ngrok.app/webhook/feishu/${botId}`,
        checks: [{ id: 'credentials', title: '飞书应用认证', state: 'ok', message: '凭据已验证' },
          { id: 'publish', title: '飞书应用发布', state: 'action', message: '请发布应用并完成真实收发验收', action: { label: '打开飞书开发者后台', url: 'https://open.feishu.cn/app' } }],
      } };
      const baseUrl = saved.publicBaseUrl || (saved.tunnelProvider === 'ngrok' ? 'https://example.ngrok.app' : null);
      const data = url.endsWith('/config') ? { ...config, sharedTunnel: botId !== 'default' }
        : url.endsWith('/connection/status') ? botId === 'default' ? runtime : { mode: config.connectionMode, state: bot.enabled ? 'listening' : 'disabled' }
          : url.endsWith('/webhook-url') ? { url: config.connectionMode === 'websocket' || !baseUrl ? null : `${baseUrl}/webhook/feishu${botId === 'default' ? '' : `/${botId}`}` }
            : tunnelOverride || { provider: saved.tunnelProvider, state: saved.connectionMode === 'websocket' ? 'not_required' : saved.tunnelProvider === 'ngrok' ? 'detected' : saved.publicBaseUrl ? 'configured' : 'unconfigured', running: saved.tunnelProvider === 'ngrok' ? true : null, url: saved.publicBaseUrl || null, port: 4321 };
      return { ok: true, status: 200, json: async () => data };
    },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  plugin.apply({ effect(callback) { disposers.push(callback()); }, slots: {
    inject: (_name, register) => register(),
    register: (metadata, view) => { registrations.push(metadata); component = view; }
  } });
  function render() {
    const seen = new Set();
    function expand(node, path = 'root') {
      if (!node || typeof node !== 'object') return node;
      if (typeof node.type === 'function') {
        const key = `${path}:${node.type.name}:${node.props.key || ''}`;
        seen.add(key);
        if (!instances.has(key)) instances.set(key, []);
        hooks = instances.get(key); cursor = 0;
        return expand(node.type(node.props), key);
      }
      return { ...node, children: node.children.map((child, index) => expand(child, `${path}/${index}`)) };
    }
    tree = expand({ type: component, props: {}, children: [] });
    for (const [key, state] of instances) if (!seen.has(key)) {
      state.forEach(hook => hook?.cleanup?.()); instances.delete(key);
    }
    effects.splice(0).forEach(effect => effect());
    return tree;
  }
  async function settle() { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); render(); } }
  function nodes(node = tree) {
    return typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  }
  function text(node = tree) { return typeof node === 'object' ? node.children.map(text).join(' ') : String(node); }
  function field(key) { return nodes().find(node => node.props.id === `feishu-test-${key}`); }
  function edit(key, value) { field(key).props.onChange({ target: { value } }); render(); }
  function dispose() { for (const state of instances.values()) state.forEach(hook => hook?.cleanup?.()); disposers.splice(0).reverse().forEach(cleanup => cleanup?.()); }
  t.after(dispose);
  render();
  await settle();
  return { render, settle, nodes, text, field, edit, dispose, timers, requests, registrations,
    pause(path) {
      let resume;
      const url = `/api/feishu-bot/${path}`;
      pauses.set(url, new Promise(resolve => { resume = () => { pauses.delete(url); resolve(); }; }));
      return resume;
    },
    setConfirmation: value => { confirmation = value; },
    confirmations: () => confirmations,
    setRuntime: value => { runtime = value; },
    setTunnel: value => { tunnelOverride = value; },
    fail: (path, message) => { if (message) failures.set(`/api/feishu-bot/${(path === 'projects' || path.startsWith('bots')) ? path : `bots/default/${path}`}`, message); else failures.delete(`/api/feishu-bot/${(path === 'projects' || path.startsWith('bots')) ? path : `bots/default/${path}`}`); } };
}

test('inventory settings expose transport choice without extra navigation; unsaved selection does not claim runtime switched', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.registrations, []);
  assert.equal(f.field('connectionMode').props.value, 'webhook');
  assert.ok(f.field('verificationToken'));
  assert.equal(f.field('webhook').props.value, 'https://example.ngrok.app/webhook/feishu');
  assert.equal(f.field('harness-port').props.value, 4321);
  assert.equal(f.field('harness-port').props.readOnly, true);
  assert.match(f.text(), /ngrok http 4321 --url https:\/\/YOUR-NGROK-DOMAIN/);
  assert.doesNotMatch(f.text(), /ngrok http 3080/);
  f.edit('connectionMode', 'websocket');
  assert.equal(f.field('verificationToken'), undefined);
  assert.equal(f.field('webhook'), undefined);
  assert.match(f.text(), /连接方式尚未保存/);
  assert.match(f.text(), /当前运行：开发者服务器（Webhook） · 等待事件/);
  assert.match(f.text(), /无需公网地址/);
  assert.match(f.text(), /在飞书后台同步选择/);
});

test('saving transport retains blank secrets and refreshes the actual connection state', async t => {
  const f = await fixture(t);
  f.edit('connectionMode', 'websocket');
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  const post = f.requests.find(request => request.method === 'POST');
  const body = JSON.parse(post.body);
  assert.equal(body.connectionMode, 'websocket');
  assert.equal('appSecret' in body, false);
  assert.equal('verificationToken' in body, false);
  assert.match(f.text(), /配置已保存/);
  assert.match(f.text(), /当前运行：长连接 · 正在连接/);
  assert.doesNotMatch(f.text(), /连接方式尚未保存/);
  f.edit('connectionMode', 'webhook');
  assert.ok(f.field('verificationToken'));
  assert.match(f.text(), /已保存凭证/);
});

test('connection polling updates runtime without resetting draft edits and is cancelled on unmount', async t => {
  const f = await fixture(t, { connectionMode: 'websocket' });
  f.edit('appId', 'cli_unsaved');
  assert.equal(f.timers.size, 1);
  const [id, poll] = [...f.timers][0];
  f.timers.delete(id);
  f.setRuntime({ mode: 'websocket', state: 'reconnecting', message: '连接中断，正在重试。' });
  await poll();
  await f.settle();
  assert.match(f.text(), /当前运行：长连接 · 正在重连/);
  assert.equal(f.field('appId').props.value, 'cli_unsaved');
  assert.equal(f.timers.size, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith('/tunnel/status')).length, 2);
  f.dispose();
  assert.equal(f.timers.size, 0);
});

test('Cloudflare draft shows the actual Harness port while distinguishing saved provider and callback', async t => {
  const f = await fixture(t);
  f.edit('tunnelProvider', 'cloudflare');
  assert.match(f.text(), /cloudflared tunnel --url http:\/\/127\.0\.0\.1:4321/);
  assert.match(f.text(), /公网接入方式尚未保存/);
  assert.match(f.text(), /原公网地址会保留/);
  assert.match(f.text(), /已保存配置的公网状态（ngrok）/);
  assert.equal(f.field('webhook').props.value, 'https://example.ngrok.app/webhook/feishu');
  f.edit('publicBaseUrl', 'https://random.trycloudflare.com');
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  const post = JSON.parse(f.requests.find(request => request.method === 'POST').body);
  assert.equal(post.tunnelProvider, 'cloudflare');
  assert.equal(post.publicBaseUrl, 'https://random.trycloudflare.com');
  assert.match(f.text(), /已保存配置的公网状态（Cloudflare Tunnel）：地址已配置，连接未验证/);
  assert.doesNotMatch(f.text(), /公网接入方式尚未保存|ngrok 未运行|已检测到 ngrok 隧道/);
  assert.equal(f.field('webhook').props.value, 'https://random.trycloudflare.com/webhook/feishu');
  assert.equal(f.requests.some(request => request.url.endsWith('/ngrok/status')), false);
});

test('Cloudflare and custom show unconfigured addresses, and websocket hides tunnel controls', async t => {
  const f = await fixture(t, { tunnelProvider: 'cloudflare' });
  assert.match(f.text(), /Cloudflare Tunnel）：地址未配置/);
  assert.equal(f.field('webhook').props.value, '');
  assert.doesNotMatch(f.text(), /ngrok 未运行/);
  f.edit('tunnelProvider', 'custom');
  assert.doesNotMatch(f.text(), /cloudflared tunnel --url/);
  f.edit('connectionMode', 'websocket');
  assert.equal(f.field('tunnelProvider'), undefined);
  assert.equal(f.field('publicBaseUrl'), undefined);
});

test('conversation settings explain Feishu access and mandatory name confirmation without user registration fields', async t => {
  const f = await fixture(t, { authorizedUsers: [{ openId: 'ou_existing', displayName: 'Existing User', permissionPreset: 'read-only' }] });
  assert.equal(f.field('authorizedUsers'), undefined);
  assert.equal(f.field('user-permission-0'), undefined);
  assert.equal(f.field('dailyResetHour').props.value, 4);
  assert.equal(f.field('dailyResetTimezone').props.value, 'Asia/Macau');
  assert.match(f.text(), /飞书后台设置应用可用范围/);
  assert.match(f.text(), /完成确认前只提示确认姓名，不处理其他问题/);
  assert.match(f.text(), /姓名相同也不会合并数据/);
  assert.match(f.text(), /不提供任意主机 Shell/);
  assert.match(f.text(), /发送 \/new 新开会话/);
  assert.doesNotMatch(f.text(), /留空会拒绝所有用户|Existing User|ou_existing|完全访问/);
  f.edit('dailyResetHour', '0');
  f.edit('dailyResetTimezone', 'UTC');
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  const body = JSON.parse(f.requests.find(request => request.method === 'POST').body);
  assert.equal('authorizedUsers' in body, false, 'saving current settings must not rewrite legacy identities');
  assert.equal(body.dailyResetHour, 0);
  assert.equal(body.dailyResetTimezone, 'UTC');
  assert.equal(f.field('dailyResetHour').props.value, 0);
});

test('empty legacy user settings allow configuration and shared workspace permissions remain editable', async t => {
  const f = await fixture(t);
  assert.equal(f.field('authorizedUsers'), undefined);
  f.edit('permissionPreset', 'read-only');
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  const body = JSON.parse(f.requests.find(request => request.method === 'POST').body);
  assert.equal(body.permissionPreset, 'read-only');
  assert.equal('authorizedUsers' in body, false);
  assert.match(f.text(), /配置已保存/);
});


function action(f, label) { return f.nodes().find(node => node.type === 'button' && f.text(node) === label); }
async function save(f) {
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
}
async function pollStatus(f) {
  const [id, poll] = [...f.timers][0];
  f.timers.delete(id);
  await poll();
  await f.settle();
}

test('watchdog is an accessible draft switch; save persists state and omitted credentials stay private', async t => {
  const f = await fixture(t);
  const toggle = f.field('tunnelAutoRestart');
  assert.equal(toggle.type, 'button');
  assert.equal(toggle.props.type, 'button', 'native button supports Enter and Space without form submit');
  assert.equal(toggle.props.role, 'switch');
  assert.equal(toggle.props['aria-checked'], false);
  assert.ok(toggle.props['aria-labelledby']);
  toggle.props.onClick();
  f.render();
  assert.equal(f.field('tunnelAutoRestart').props['aria-checked'], true);
  assert.match(f.text(), /已保存的守护设置：关闭/);
  assert.match(f.text(), /开关修改尚未保存/);
  assert.equal(action(f, '启动当前端口的隧道').props.disabled, true);
  assert.equal(f.requests.some(r => r.method === 'POST'), false);
  assert.equal(f.field('ngrokAuthtoken').props.type, 'password');
  f.edit('ngrokTrafficPolicyFile', '/home/example/policy.yaml');
  f.edit('ngrokExecutablePath', 'C:\\tools\\ngrok.exe');
  await save(f);
  const body = JSON.parse(f.requests.find(r => r.method === 'POST').body);
  assert.equal(body.tunnelAutoRestart, true);
  assert.equal(body.ngrokTrafficPolicyFile, '/home/example/policy.yaml');
  assert.equal(body.ngrokExecutablePath, 'C:\\tools\\ngrok.exe');
  assert.equal('ngrokAuthtoken' in body, false);
  assert.match(f.text(), /已保存的守护设置：开启/);
  assert.doesNotMatch(f.text(), /开关修改尚未保存/);
});

test('start uses saved configuration only and is blocked by tunnel drafts but not unrelated edits', async t => {
  const f = await fixture(t);
  assert.equal(action(f, '启动当前端口的隧道').props.disabled, false);
  f.edit('appId', 'cli_other_draft');
  assert.equal(action(f, '启动当前端口的隧道').props.disabled, false);
  f.edit('tunnelProvider', 'cloudflare');
  assert.equal(action(f, '启动当前端口的隧道').props.disabled, true);
  f.edit('cloudflareMode', 'named');
  assert.ok(f.field('cloudflareConfigFile'));
  assert.ok(f.field('cloudflareTunnelName'));
  f.edit('cloudflareTunnelName', 'feishu-production');
  f.edit('cloudflareConfigFile', 'C:\\Users\\Example\\config.yml');
  f.edit('publicBaseUrl', 'https://bot.example.com');
  await save(f);
  assert.equal(action(f, '启动当前端口的隧道').props.disabled, false);
  action(f, '启动当前端口的隧道').props.onClick();
  await f.settle();
  const start = f.requests.find(r => r.url.endsWith('/tunnel/start'));
  assert.equal(start.method, 'POST');
  assert.deepEqual(JSON.parse(start.body), {}, 'no draft fields can be passed into process launch');
  assert.match(f.text(), /已请求启动隧道/);
  const saved = JSON.parse(f.requests.find(r => r.method === 'POST' && r.url.endsWith('/config')).body);
  assert.equal(saved.cloudflareMode, 'named');
  assert.equal(saved.cloudflareTunnelName, 'feishu-production');
  assert.equal(saved.cloudflareConfigFile, 'C:\\Users\\Example\\config.yml');
});

test('polling reflects process readiness, retries, pause and request errors without overwriting drafts', async t => {
  const f = await fixture(t, { tunnelProvider: 'cloudflare', cloudflareMode: 'quick' });
  assert.match(f.text(), /每次重启可能更换地址/);
  assert.equal(action(f, '停止托管隧道'), undefined);
  f.edit('cloudflareExecutablePath', '/opt/cloudflared');
  f.setTunnel({ provider: 'cloudflare', mode: 'quick', state: 'starting', managed: true, running: true, restartCount: 0 });
  await pollStatus(f);
  assert.match(f.text(), /进程启动中，等待隧道就绪/);
  assert.doesNotMatch(f.text(), /Cloudflare Tunnel）：隧道已连接/);
  assert.ok(action(f, '停止托管隧道'));
  f.setTunnel({ provider: 'cloudflare', state: 'backoff', managed: true, running: false, restartCount: 2, nextRetryAt: Date.now() + 5000, message: '进程已退出' });
  await pollStatus(f);
  assert.match(f.text(), /隧道中断，等待自动重试/);
  assert.match(f.text(), /自动重试次数：2/);
  assert.equal(f.field('cloudflareExecutablePath').props.value, '/opt/cloudflared');
  f.fail('tunnel/status', 'status unavailable');
  await pollStatus(f);
  assert.match(f.text(), /status unavailable/);
  assert.equal(f.timers.size, 1, 'errors must retain the shared polling loop');
  f.fail('tunnel/status', '');
  f.setTunnel({ provider: 'cloudflare', state: 'idle', managed: true, running: false, paused: true });
  await pollStatus(f);
  assert.match(f.text(), /守护已暂停/);
  assert.doesNotMatch(f.text(), /status unavailable/);
  action(f, '停止托管隧道').props.onClick();
  await f.settle();
  const stop = f.requests.find(r => r.url.endsWith('/tunnel/stop'));
  assert.deepEqual(JSON.parse(stop.body), {});
  f.dispose();
  assert.equal(f.timers.size, 0);
});

test('launch errors are visible and custom or websocket transports have no process controls', async t => {
  const f = await fixture(t);
  f.fail('tunnel/start', '找不到 ngrok 程序');
  action(f, '启动当前端口的隧道').props.onClick();
  await f.settle();
  assert.match(f.text(), /找不到 ngrok 程序/);
  assert.equal(action(f, '启动当前端口的隧道').props.disabled, false);
  f.edit('tunnelProvider', 'custom');
  assert.equal(f.field('tunnelAutoRestart'), undefined);
  assert.equal(action(f, '启动当前端口的隧道'), undefined);
  f.edit('connectionMode', 'websocket');
  assert.equal(action(f, '停止托管隧道'), undefined);
});

test('bot selector remounts independent credentials and callback while secondary bots share read-only tunnel status', async t => {
  const f = await fixture(t, {}, { bots: [{ id: 'project-b', name: '项目 B', enabled: true,
    config: { appId: 'cli_project_b', workspacePath: '/projects/b' } }] });
  assert.equal(f.field('bot').props.value, 'default');
  assert.match(f.text(), /共享隧道设置/);
  f.edit('bot', 'project-b');
  await f.settle();
  assert.equal(f.field('appId').props.value, 'cli_project_b');
  assert.equal(f.field('workspacePath').props.value, '/projects/b');
  assert.equal(f.field('webhook').props.value, 'https://example.ngrok.app/webhook/feishu/project-b');
  assert.equal(f.field('tunnelProvider'), undefined);
  assert.equal(f.field('publicBaseUrl'), undefined);
  assert.equal(f.field('tunnelAutoRestart'), undefined);
  assert.equal(action(f, '启动当前端口的隧道'), undefined);
  assert.match(f.text(), /共享默认机器人的公网隧道/);
  assert.equal(f.timers.size, 1, 'switching bot disposes the previous poller');
  f.edit('appSecret', 'new-project-secret');
  await save(f);
  const post = f.requests.find(r => r.method === 'POST');
  assert.equal(post.url, '/api/feishu-bot/bots/project-b/config');
  const body = JSON.parse(post.body);
  assert.equal(body.appSecret, 'new-project-secret');
  assert.equal(body.workspacePath, '/projects/b');
  assert.equal(body.connectionMode, 'webhook');
  assert.equal('ngrokAuthtoken' in body, false);
  assert.equal('publicBaseUrl' in body, false);
  assert.equal('tunnelAutoRestart' in body, false);
  assert.equal('source' in body, false);
  assert.equal('path' in body, false);
  f.edit('bot', 'default');
  await f.settle();
  assert.equal(f.field('appId').props.value, 'cli_example');
  assert.equal(f.field('appSecret').props.value, '');
  assert.ok(f.field('tunnelProvider'));
  assert.equal(f.requests.every(r => r.url === '/api/feishu-bot/bots' || r.url.startsWith('/api/feishu-bot/bots/')), true);
});

test('switching bots requires a cancellable confirmation when credentials have unsaved edits', async t => {
  const f = await fixture(t, {}, { bots: [{ id: 'project-b', name: '项目 B', enabled: true }] });
  f.edit('appSecret', 'draft-secret');
  await f.settle();
  f.setConfirmation(false);
  f.edit('bot', 'project-b');
  await f.settle();
  assert.equal(f.confirmations(), 1);
  assert.equal(f.field('bot').props.value, 'default');
  assert.equal(f.field('appSecret').props.value, 'draft-secret');
  f.setConfirmation(true);
  f.edit('bot', 'project-b');
  await f.settle();
  assert.equal(f.field('bot').props.value, 'project-b');
  assert.equal(f.field('appSecret').props.value, '');
  assert.equal(f.requests.some(r => r.method === 'POST'), false, 'discarded credentials must never be sent');
});

test('create, rename and disable preserve configuration access without a delete action', async t => {
  const f = await fixture(t);
  action(f, '添加机器人').props.onClick();
  f.render();
  f.edit('new-bot-name', '客户项目');
  f.field('new-bot-path').props.onClick();
  await f.settle();
  f.nodes().find(node => node.props.role === 'option' && f.text(node).includes('/srv/customer')).props.onClick();
  f.render();
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  assert.equal(f.field('bot').props.value, 'bot-1');
  assert.equal(f.field('workspacePath').props.value, '/srv/customer');
  assert.deepEqual(JSON.parse(f.requests.find(r => r.method === 'POST').body), { name: '客户项目', workspacePath: '/srv/customer' });
  f.edit('bot-name', '客户服务');
  action(f, '重命名').props.onClick();
  await f.settle();
  assert.equal(f.field('bot-name').props.value, '客户服务');
  action(f, '已启用 · 点击停用').props.onClick();
  await f.settle();
  assert.ok(action(f, '已停用 · 点击启用'));
  assert.match(f.text(), /配置和历史数据继续保留/);
  assert.doesNotMatch(f.text(), /删除机器人/);
  f.edit('appId', 'cli_disabled_config');
  await save(f);
  assert.equal(f.field('appId').props.value, 'cli_disabled_config');
  assert.ok(f.requests.find(r => r.url === '/api/feishu-bot/bots/bot-1/meta' && JSON.parse(r.body).enabled === false));
});

test('websocket default bot still manages a tunnel required by another bot without showing its own webhook', async t => {
  const f = await fixture(t, { connectionMode: 'websocket', serverTunnelRequired: true });
  assert.equal(f.field('webhook'), undefined);
  assert.ok(f.field('tunnelProvider'));
  assert.ok(f.field('tunnelAutoRestart'));
  assert.equal(action(f, '启动当前端口的隧道').props.disabled, false);
  assert.match(f.text(), /服务器共享公网隧道/);
  assert.doesNotMatch(f.text(), /在飞书应用的「事件订阅」中填写公网可访问的请求地址/);
  action(f, '启动当前端口的隧道').props.onClick();
  await f.settle();
  assert.ok(f.requests.find(r => r.url === '/api/feishu-bot/bots/default/tunnel/start'));
});

test('secondary websocket bot hides tunnel and callback controls entirely', async t => {
  const f = await fixture(t, {}, { bots: [{ id: 'project-b', name: '项目 B', enabled: true,
    config: { connectionMode: 'websocket', serverTunnelRequired: true } }] });
  f.edit('bot', 'project-b');
  await f.settle();
  assert.equal(f.field('webhook'), undefined);
  assert.equal(f.field('tunnelProvider'), undefined);
  assert.equal(f.field('tunnelAutoRestart'), undefined);
});

test('late configuration and status responses from an unmounted bot cannot overwrite the newly selected bot', async t => {
  const f = await fixture(t, {}, { bots: [{ id: 'project-b', name: '项目 B', enabled: true,
    config: { appId: 'cli_project_b', workspacePath: '/projects/b' } }] });
  const resumeConfig = f.pause('bots/project-b/config');
  const resumeWebhook = f.pause('bots/project-b/webhook-url');
  f.edit('bot', 'project-b');
  await f.settle();
  assert.match(f.text(), /正在读取配置/);
  f.edit('bot', 'default');
  await f.settle();
  f.edit('appId', 'cli_default_draft');
  resumeConfig(); resumeWebhook();
  await f.settle();
  assert.equal(f.field('bot').props.value, 'default');
  assert.equal(f.field('appId').props.value, 'cli_default_draft');
  assert.equal(f.field('webhook').props.value, 'https://example.ngrok.app/webhook/feishu');
  assert.equal(f.timers.size, 1, 'completed stale requests must not restart an old poller');
});

test('busy-bot disable rejection keeps enabled state and configuration intact', async t => {
  const f = await fixture(t);
  f.fail('bots/default/meta', '机器人正在处理任务，请完成后再停用');
  action(f, '已启用 · 点击停用').props.onClick();
  await f.settle();
  assert.match(f.text(), /机器人正在处理任务，请完成后再停用/);
  assert.equal(action(f, '已启用 · 点击停用').props['aria-checked'], true);
  assert.equal(action(f, '已停用 · 点击启用'), undefined);
  assert.equal(f.field('appId').props.value, 'cli_example');
});

test('bound App ID is read-only with accurate guidance while unbound apps remain editable', async t => {
  const bound = await fixture(t, { configured: { appId: true, appSecret: true } });
  assert.equal(bound.field('appId').props.readOnly, true);
  assert.equal(bound.field('appSecret').props.readOnly, false);
  assert.match(bound.text(), /已绑定此应用；切换应用请新增机器人/);
  assert.match(bound.text(), /已保存凭证；填写新值可替换/);
  await save(bound);
  assert.equal(JSON.parse(bound.requests.find(r => r.method === 'POST').body).appId, 'cli_example');
  const fresh = await fixture(t, { appId: '', configured: {} });
  assert.equal(fresh.field('appId').props.readOnly, false);
  assert.doesNotMatch(fresh.text(), /已绑定此应用/);
  fresh.edit('appId', 'cli_new_application');
  await save(fresh);
  assert.equal(JSON.parse(fresh.requests.find(r => r.method === 'POST').body).appId, 'cli_new_application');
});


async function openProjects(f, key = 'workspacePath') {
  f.field(`${key}-search`).props.onClick();
  await f.settle();
}
function projectOptions(f) { return f.nodes().filter(node => node.props.role === 'option'); }
function keypress(f, key, event = {}) {
  let prevented = false;
  f.field('workspacePath-query').props.onKeyDown({ key, preventDefault() { prevented = true; }, stopPropagation() {}, ...event });
  f.render();
  return prevented;
}

test('project picker filters Harness names and paths without changing saved selection until a result is chosen', async t => {
  const f = await fixture(t, { workspacePath: '/projects/old' }, { projects: [
    { path: '/projects/old', name: '原项目', available: true, botId: 'default' },
    { path: '/projects/Alpha', name: '课程研发', available: true },
    { path: 'C:\\Projects\\Beta', name: '招生平台', available: true }
  ] });
  assert.equal(f.field('workspacePath').props.value, '/projects/old');
  assert.equal(f.field('workspacePath').props['aria-expanded'], false);
  await openProjects(f);
  assert.equal(projectOptions(f).length, 3);
  f.edit('workspacePath-query', '课程 ALPHA');
  assert.equal(projectOptions(f).length, 1);
  assert.equal(f.field('workspacePath').props.value, '/projects/old');
  projectOptions(f)[0].props.onClick();
  f.render();
  assert.equal(f.field('workspacePath').props.value, '/projects/Alpha');
  assert.equal(f.field('workspacePath-query'), undefined);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  await save(f);
  const posted = JSON.parse(f.requests.find(r => r.method === 'POST').body);
  assert.equal(posted.workspacePath, '/projects/Alpha');
});

test('project picker skips occupied and missing directories with keyboard and keeps current bot selectable', async t => {
  const f = await fixture(t, { workspacePath: '/projects/current' }, { projects: [
    { path: '/projects/other', name: '其他项目', available: true, botId: 'other', botName: '客服' },
    { path: '/projects/missing', name: '已删除项目', available: false },
    { path: '/projects/current', name: '当前项目', available: true, botId: 'default' },
    { path: '/projects/next', name: '下个项目', available: true }
  ] });
  await openProjects(f);
  assert.deepEqual(projectOptions(f).map(node => node.props.disabled), [true, true, false, false]);
  assert.match(f.text(), /已由「客服」使用/);
  assert.equal(keypress(f, 'ArrowDown'), true);
  assert.match(f.field('workspacePath-query').props['aria-activedescendant'], /-2$/);
  keypress(f, 'ArrowDown');
  assert.match(f.field('workspacePath-query').props['aria-activedescendant'], /-3$/);
  keypress(f, 'Enter', { isComposing: true });
  assert.equal(f.field('workspacePath').props.value, '/projects/current');
  keypress(f, 'Enter');
  assert.equal(f.field('workspacePath').props.value, '/projects/next');
  await openProjects(f);
  keypress(f, 'Home');
  keypress(f, 'Escape');
  assert.equal(f.field('workspacePath').props.value, '/projects/next');
  assert.equal(f.field('workspacePath').props['aria-expanded'], false);
});

test('project picker preserves selection on no matches and recovers from a failed list request', async t => {
  const f = await fixture(t, { workspacePath: '/projects/current' }, { projects: [] });
  f.fail('projects', '暂时无法读取项目');
  await openProjects(f);
  assert.match(f.text(), /暂时无法读取项目/);
  assert.equal(f.field('workspacePath').props.value, '/projects/current');
  f.fail('projects', null);
  action(f, '重试').props.onClick();
  await f.settle();
  assert.match(f.text(), /请先在 Harness 中添加项目/);
  assert.equal(projectOptions(f).length, 0);
  keypress(f, 'ArrowDown'); keypress(f, 'Enter');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('project picker reports unmatched searches and stale requests cannot switch another bot project', async t => {
  const f = await fixture(t, { workspacePath: '/projects/a' }, { projects: [{ path: '/projects/a', name: '甲', available: true }],
    bots: [{ id: 'b', name: '乙', enabled: true, config: { workspacePath: '/projects/b' } }] });
  await openProjects(f);
  f.edit('workspacePath-query', '没有这个项目');
  assert.match(f.text(), /没有匹配的项目/);
  assert.equal(projectOptions(f).length, 0);
  keypress(f, 'Escape');
  const resume = f.pause('projects');
  await openProjects(f);
  assert.match(f.text(), /正在读取 Harness 项目/);
  f.edit('bot', 'b'); await f.settle();
  resume(); await f.settle();
  assert.equal(f.field('workspacePath').props.value, '/projects/b');
  assert.equal(f.field('workspacePath').props['aria-expanded'], false);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});


test('directory field opens only the list; the separate search icon reveals and filters that list', async t => {
  const f = await fixture(t, { workspacePath: '/projects/a' }, { projects: [
    { path: '/projects/a', name: '甲项目', available: true, botId: 'default' },
    { path: '/projects/b', name: '乙项目', available: true }
  ] });
  f.field('workspacePath').props.onClick();
  await f.settle();
  assert.equal(f.field('workspacePath').props['aria-expanded'], true);
  assert.equal(f.field('workspacePath-query'), undefined);
  assert.equal(projectOptions(f).length, 2);
  assert.equal(f.field('workspacePath-search').props['aria-expanded'], false);
  f.field('workspacePath-search').props.onClick();
  await f.settle();
  assert.ok(f.field('workspacePath-query'));
  f.edit('workspacePath-query', '乙');
  assert.equal(projectOptions(f).length, 1);
  assert.match(f.text(projectOptions(f)[0]), /乙项目/);
  // Clicking the directory field exits search and shows every option again.
  f.field('workspacePath').props.onClick();
  f.render();
  assert.equal(f.field('workspacePath-query'), undefined);
  assert.equal(projectOptions(f).length, 2);
  assert.equal(f.field('workspacePath').props.value, '/projects/a');
  f.field('workspacePath').props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  f.render();
  projectOptions(f)[0].props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  f.render();
  projectOptions(f)[1].props.onKeyDown({ key: 'Enter', preventDefault() {} });
  f.render();
  assert.equal(f.field('workspacePath').props.value, '/projects/b');
  assert.equal(f.field('workspacePath').props['aria-expanded'], false);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});


test('connection diagnostics stay collapsed until requested and never save or start tunnels', async t => {
  const f = await fixture(t);
  const check = () => f.nodes().find(node => node.type === 'button' && f.text(node) === '检查连接问题');
  assert.doesNotMatch(f.text(), /快速配置|保存并一键配置|检查完成/);
  assert.equal(check().props['aria-expanded'], false);
  assert.equal(f.requests.some(item => item.method === 'POST'), false);
  assert.equal(f.nodes().filter(node => node.type === 'button' && f.text(node) === '保存配置').length, 1);
  await check().props.onClick(); await f.settle();
  const posts = f.requests.filter(item => item.method === 'POST');
  assert.deepEqual(posts.map(item => item.url), ['/api/feishu-bot/bots/default/setup/check']);
  assert.equal(posts[0].body, '{}');
  assert.equal(check().props['aria-expanded'], true);
  assert.match(f.text(), /1 项通过，1 项需要处理或确认/);
  assert.match(f.text(), /实际收发仍需验收/);
  await f.nodes().find(node => node.type === 'button' && f.text(node) === '收起检查结果').props.onClick();
  await f.settle();
  assert.equal(check().props['aria-expanded'], false);
  assert.doesNotMatch(f.text(), /检查完成/);
  assert.equal(f.requests.filter(item => item.method === 'POST').length, 1);
});

test('unsaved edits disable diagnostics and preserve credentials until the normal save action', async t => {
  const f = await fixture(t);
  f.edit('appSecret', 'draft-secret');
  const check = f.nodes().find(node => node.type === 'button' && f.text(node) === '检查连接问题');
  assert.equal(check.props.disabled, true);
  assert.equal(f.field('appSecret').props.value, 'draft-secret');
  assert.match(f.text(), /请先保存配置，再检查连接问题/);
  assert.equal(f.requests.some(item => item.method === 'POST'), false);
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  assert.equal(f.nodes().find(node => node.type === 'button' && f.text(node) === '检查连接问题').props.disabled, false);
  assert.equal(f.requests.some(item => item.url.endsWith('/setup/repair')), false);
});

test('diagnostics hide stale results on edit and never render unsafe action links', async t => {
  const f = await fixture(t, {}, { setupReport: { ready: false, checks: [
    { id: 'unsafe', title: '外部内容', state: 'action', message: '<script>not HTML</script>', action: { label: 'bad link', url: 'javascript:alert(1)' } },
  ] } });
  await f.nodes().find(node => node.type === 'button' && f.text(node) === '检查连接问题').props.onClick(); await f.settle();
  assert.equal(f.nodes().some(node => node.type === 'a' && node.props.href?.startsWith('javascript:')), false);
  assert.equal(f.nodes().some(node => node.type === 'script'), false);
  assert.match(f.text(), /检查完成/);
  f.edit('connectionMode', 'websocket');
  assert.doesNotMatch(f.text(), /检查完成|收起检查结果/);
});

test('diagnostic errors can be retried within the selected bot without saving or repair calls', async t => {
  const f = await fixture(t, {}, { bots: [{ id: 'project-b', name: '项目 B', enabled: true }] });
  f.field('bot').props.onChange({ target: { value: 'project-b' } }); await f.settle();
  const check = () => f.nodes().find(node => node.type === 'button' && f.text(node) === '检查连接问题');
  f.fail('bots/project-b/setup/check', '检查暂不可用');
  await check().props.onClick(); await f.settle();
  assert.match(f.text(), /检查暂不可用/);
  f.fail('bots/project-b/setup/check', '');
  await check().props.onClick(); await f.settle();
  assert.match(f.text(), /检查完成/);
  assert.deepEqual(f.requests.filter(item => item.method === 'POST').map(item => item.url), ['/api/feishu-bot/bots/project-b/setup/check', '/api/feishu-bot/bots/project-b/setup/check']);
});

test('connection failures are prominent without automatically opening or running diagnostics', async t => {
  const f = await fixture(t, { connectionMode: 'websocket' });
  f.setRuntime({ mode: 'websocket', state: 'error', message: '连接已断开' });
  const [id, poll] = [...f.timers][0]; f.timers.delete(id); await poll(); await f.settle();
  assert.ok(f.nodes().some(node => node.props.className === 'feishu-state-banner is-error' && /当前运行/.test(f.text(node))));
  assert.match(f.text(), /查看具体待办/);
  assert.equal(f.requests.some(item => item.method === 'POST'), false);
  assert.doesNotMatch(f.text(), /检查完成/);
});
