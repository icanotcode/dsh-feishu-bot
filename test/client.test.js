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

async function fixture(t, initial = {}) {
  const hooks = [];
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
  let runtime = { mode: saved.connectionMode, state: saved.connectionMode === 'webhook' ? 'listening' : 'connected', message: '' };
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }),
    useId: () => 'feishu-test',
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = value;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        effects.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: callback() }; });
      }
    }
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: definition => { plugin = definition.factory(name => {
      if (name === 'react') return React;
      if (name === 'react-dom/client') return dom.reactDOM;
      throw new Error(`Unexpected client dependency: ${name}`);
    }); } } },
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (url.endsWith('/config') && options.method === 'POST') {
        saved = { ...saved, ...JSON.parse(options.body) };
        runtime = { mode: saved.connectionMode, state: saved.connectionMode === 'webhook' ? 'listening' : 'connecting', message: '' };
      }
      const data = url.endsWith('/config') ? saved
        : url.endsWith('/connection/status') ? runtime
          : url.endsWith('/webhook-url') ? { url: saved.connectionMode === 'websocket' ? null : saved.publicBaseUrl ? `${saved.publicBaseUrl}/webhook/feishu` : saved.tunnelProvider === 'ngrok' ? 'https://example.ngrok.app/webhook/feishu' : null }
            : { provider: saved.tunnelProvider, state: saved.connectionMode === 'websocket' ? 'not_required' : saved.tunnelProvider === 'ngrok' ? 'detected' : saved.publicBaseUrl ? 'configured' : 'unconfigured', running: saved.tunnelProvider === 'ngrok' ? true : null, url: saved.publicBaseUrl || null, port: 4321 };
      return { ok: true, status: 200, json: async () => data };
    },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  plugin.apply({ effect(callback) { disposers.push(callback()); }, slots: {
    inject: (_name, register) => register(),
    register: (metadata, view) => { registrations.push(metadata); component = view; }
  } });
  function render() { cursor = 0; tree = component(); effects.splice(0).forEach(effect => effect()); return tree; }
  async function settle() { await new Promise(resolve => setImmediate(resolve)); render(); }
  function nodes(node = tree) {
    return typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  }
  function text(node = tree) { return typeof node === 'object' ? node.children.map(text).join(' ') : String(node); }
  function field(key) { return nodes().find(node => node.props.id === `feishu-test-${key}`); }
  function edit(key, value) { field(key).props.onChange({ target: { value } }); render(); }
  function dispose() { hooks.forEach(hook => hook?.cleanup?.()); disposers.splice(0).reverse().forEach(cleanup => cleanup?.()); }
  t.after(dispose);
  render();
  await settle();
  return { render, settle, nodes, text, field, edit, dispose, timers, requests, registrations,
    setRuntime: value => { runtime = value; } };
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
  assert.equal(f.requests.filter(request => request.url.endsWith('/tunnel/status')).length, 1);
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

test('user settings show deny-by-default and restricted capabilities, save parsed names and numeric midnight', async t => {
  const f = await fixture(t, { authorizedUsers: [{ openId: 'ou_existing', displayName: 'Existing User' }] });
  assert.equal(f.field('authorizedUsers').props.value, 'ou_existing Existing User');
  assert.equal(f.field('dailyResetHour').props.value, 4);
  assert.equal(f.field('dailyResetTimezone').props.value, 'Asia/Macau');
  assert.match(f.text(), /留空会拒绝所有用户/);
  assert.match(f.text(), /不提供任意主机 Shell/);
  assert.match(f.text(), /发送 \/new 新开会话/);
  assert.doesNotMatch(f.text(), /完全访问/);
  f.edit('authorizedUsers', 'ou_alice Alice Example\n\nou_bob 李四');
  f.edit('dailyResetHour', '0');
  f.edit('dailyResetTimezone', 'UTC');
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  const body = JSON.parse(f.requests.find(request => request.method === 'POST').body);
  assert.deepEqual(body.authorizedUsers, [{ openId: 'ou_alice', displayName: 'Alice Example' }, { openId: 'ou_bob', displayName: '李四' }]);
  assert.equal(body.dailyResetHour, 0);
  assert.equal(body.dailyResetTimezone, 'UTC');
  assert.equal(f.field('dailyResetHour').props.value, 0);
  assert.equal(f.field('authorizedUsers').props.value, 'ou_alice Alice Example\nou_bob 李四');
});

test('malformed user text prevents saving and an empty list explicitly clears authorizations', async t => {
  const f = await fixture(t);
  f.edit('authorizedUsers', 'ou_no_name');
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
  assert.match(f.text(), /需要填写 open_id 和显示名称/);
  f.edit('authorizedUsers', ' \n ');
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  assert.deepEqual(JSON.parse(f.requests.find(request => request.method === 'POST').body).authorizedUsers, []);
  assert.match(f.text(), /配置已保存/);
});

test('individual permissions survive name edits and reload, inherit explicitly and disappear with removed users', async t => {
  const f = await fixture(t, { authorizedUsers: [
    { openId: 'ou_alice', displayName: 'Alice', permissionPreset: 'read-only' },
    { openId: 'ou_bob', displayName: 'Bob' },
  ] });
  assert.equal(f.field('user-permission-0').props.value, 'read-only');
  assert.equal(f.field('user-permission-1').props.value, '');
  f.edit('user-permission-1', 'workspace-write');
  f.edit('authorizedUsers', 'ou_alice\nou_bob Bob');
  f.edit('authorizedUsers', 'ou_alice Alice Renamed\nou_bob Bob');
  assert.equal(f.field('user-permission-0').props.value, 'read-only');
  assert.equal(f.field('user-permission-1').props.value, 'workspace-write');
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  let body = JSON.parse(f.requests.filter(request => request.method === 'POST').at(-1).body);
  assert.deepEqual(body.authorizedUsers, [
    { openId: 'ou_alice', displayName: 'Alice Renamed', permissionPreset: 'read-only' },
    { openId: 'ou_bob', displayName: 'Bob', permissionPreset: 'workspace-write' },
  ]);
  assert.equal(f.field('user-permission-0').props.value, 'read-only');
  assert.equal(f.field('user-permission-1').props.value, 'workspace-write');
  f.edit('user-permission-0', '');
  f.edit('authorizedUsers', 'ou_alice Alice Renamed');
  assert.equal(f.field('user-permission-1'), undefined);
  f.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await f.settle();
  body = JSON.parse(f.requests.filter(request => request.method === 'POST').at(-1).body);
  assert.deepEqual(body.authorizedUsers, [{ openId: 'ou_alice', displayName: 'Alice Renamed' }]);
  f.edit('authorizedUsers', 'ou_alice Alice Renamed\nou_bob Bob Again');
  assert.equal(f.field('user-permission-1').props.value, '', 'removed users must not retain a hidden old override');
});
