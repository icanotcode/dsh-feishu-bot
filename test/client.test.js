import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client/index.js', import.meta.url), 'utf8');

async function fixture(t, initial = {}) {
  const hooks = [];
  const effects = [];
  const timers = new Map();
  const requests = [];
  const registrations = [];
  let cursor = 0;
  let tree;
  let component;
  let plugin;
  let timerId = 0;
  let saved = { connectionMode: 'webhook', appId: 'cli_example', configured: { appSecret: true, verificationToken: true }, ...initial };
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
    window: { __ModuleLoader__: { load: definition => { plugin = definition.factory(() => React); } } },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (url.endsWith('/config') && options.method === 'POST') {
        saved = { ...saved, ...JSON.parse(options.body) };
        runtime = { mode: saved.connectionMode, state: saved.connectionMode === 'webhook' ? 'listening' : 'connecting', message: '' };
      }
      const data = url.endsWith('/config') ? saved
        : url.endsWith('/connection/status') ? runtime
          : url.endsWith('/webhook-url') ? { url: 'https://example.ngrok.app/webhook/feishu' }
            : { running: true, url: 'https://example.ngrok.app' };
      return { ok: true, status: 200, json: async () => data };
    },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  plugin.apply({ effect() {}, slots: {
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
  function dispose() { hooks.forEach(hook => hook?.cleanup?.()); }
  t.after(dispose);
  render();
  await settle();
  return { render, settle, nodes, text, field, edit, dispose, timers, requests, registrations,
    setRuntime: value => { runtime = value; } };
}

test('both settings entries expose transport choice; unsaved selection does not claim runtime switched', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.registrations.map(entry => entry.name), ['settings.plugins.tab', 'settings.section']);
  assert.equal(f.field('connectionMode').props.value, 'webhook');
  assert.ok(f.field('verificationToken'));
  assert.equal(f.field('webhook').props.value, 'https://example.ngrok.app/webhook/feishu');
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
  assert.equal(f.requests.filter(request => request.url.endsWith('/ngrok/status')).length, 1);
  f.dispose();
  assert.equal(f.timers.size, 0);
});
