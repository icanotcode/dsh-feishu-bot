import { mkdir, readFile, rename, writeFile, unlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createManagement, ManagementError, readJsonBody, sendJson } from './management.js';

const DEFAULT_ID = 'default';
const validId = id => id === DEFAULT_ID || /^bot_[a-f0-9]{32}$/.test(id);
const botName = value => {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 80 || /[\p{Cc}\u2028\u2029]/u.test(value)) throw new ManagementError(400, '机器人名称须为 1–80 个字符，不能包含控制字符');
  return value.trim();
};
async function saveJson(filename, data) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** One server owns a catalog, one public tunnel, and independently routed bots.
 * The legacy default keeps its source, credentials, callback and history paths.
 */
export async function createBotManager(ctx, baseConfig, dependencies) {
  const { createClient, installRuntime, createReceiver, createHandler, createTransport, hub } = dependencies;
  const managementFactory = dependencies.createManagement ?? createManagement;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const catalogFile = baseConfig.botsFile || (baseConfig.configFile ? `${baseConfig.configFile}.bots.json` : join(home, 'feishu-bots.json'));
  const storageRoot = `${catalogFile}.data`;
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
    if (catalog?.version !== 1 || !Array.isArray(catalog.bots) || !catalog.bots.length || catalog.bots.length > 50) throw new Error('Invalid catalog');
    const ids = new Set();
    catalog.bots = catalog.bots.map(row => {
      if (!validId(row?.id) || ids.has(row.id) || typeof row.enabled !== 'boolean') throw new Error('Invalid bot identity');
      ids.add(row.id);
      return { id: row.id, name: botName(row.name), enabled: row.enabled };
    });
    if (!ids.has(DEFAULT_ID)) throw new Error('Missing default bot');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('飞书机器人列表无法读取，请检查本机配置文件');
    catalog = { version: 1, bots: [{ id: DEFAULT_ID, name: '默认机器人', enabled: true }] };
  }
  const slots = new Map();
  const routes = [];
  let chain = Promise.resolve();
  let closing = false;
  let disposal;
  function serialize(operation) {
    const result = chain.then(() => {
      if (closing) throw new ManagementError(503, '飞书插件正在停止');
      return operation();
    });
    chain = result.catch(() => {});
    return result;
  }
  const isTunnelRequired = () => [...slots.values()].some(slot => slot.row.enabled && slot.config.connectionMode === 'webhook');
  const defaultService = () => slots.get(DEFAULT_ID)?.management;
  const reconcileTunnel = async () => { await defaultService()?.reconcileTunnel(); };
  const isBusy = slot => slot.queued.size > 0 || slot.runtime?.isBusy?.() === true;
  async function withIngressPaused(slot, operation) {
    slot.pauses++;
    slot.accepting = false;
    try {
      // Already-dispatched rule microtasks can enter runtime accounting before
      // the busy check; queued additionally covers dispatch-to-rule gaps.
      await Promise.resolve();
      return await operation();
    } finally {
      slot.pauses--;
      slot.accepting = !closing && !slot.pauses && slot.row.enabled && Boolean(slot.runtime) && !slot.error;
    }
  }
  async function directory(value) {
    if (typeof value !== 'string' || !isAbsolute(value.trim())) throw new ManagementError(400, '项目目录必须为已存在的绝对路径');
    try {
      const path = await realpath(value.trim());
      if (!(await stat(path)).isDirectory()) throw new Error();
      return path;
    } catch { throw new ManagementError(400, '项目目录不存在或无法访问'); }
  }
  async function uniqueProject(id, value) {
    const path = await directory(value);
    for (const slot of slots.values()) {
      if (slot.row.id === id) continue;
      // Compare canonical paths so aliases cannot silently bind one project twice.
      const other = await realpath(slot.config.workspacePath).catch(() => null);
      if (other === path) throw new ManagementError(409, '此项目目录已绑定其他机器人，请选择独立项目目录');
    }
    return path;
  }
  async function uniqueApp(id, appId) {
    if (!appId) return;
    for (const slot of slots.values()) {
      if (slot.row.id === id) continue;
      const existing = (await ctx.credentials.resolve(credentialRef(slot.config.appIdEnv)))?.value;
      if (existing === appId) throw new ManagementError(409, '此 App ID 已绑定其他机器人，不能重复接收同一应用的消息');
    }
  }
  const status = slot => !slot.row.enabled
    ? { mode: slot.config.connectionMode, state: 'disabled', message: '机器人已停用；项目、凭据和历史仍保留。' }
    : slot.error ? { mode: slot.config.connectionMode, state: 'error', message: slot.error }
      : slot.transport?.status() ?? { mode: slot.config.connectionMode, state: 'starting', message: '正在初始化机器人' };
  const view = slot => ({ ...slot.row, workspacePath: slot.config.workspacePath, connectionMode: slot.config.connectionMode, status: status(slot) });

  async function stop(slot) {
    // Reject new ingress before detaching its own connection and runtime.
    slot.accepting = false;
    const errors = [];
    try { await slot.transport?.dispose(); } catch (error) { errors.push(error); }
    slot.transport = undefined;
    const runtime = slot.runtime;
    slot.runtime = undefined;
    try { if (runtime) await runtime(); } catch (error) { errors.push(error); }
    slot.queued.clear();
    if (errors.length) throw new AggregateError(errors, 'Feishu bot could not fully stop');
  }
  async function start(slot) {
    if (!slot.row.enabled || closing || slot.runtime) return;
    slot.error = '';
    try {
      const appId = (await ctx.credentials.resolve(credentialRef(slot.config.appIdEnv)))?.value;
      await uniqueApp(slot.row.id, appId);
      slot.config.expectedAppId = appId || '';
      slot.runtime = await installRuntime(ctx, slot.config, slot.client, {
        hub, allowLegacyHistory: slot.row.id === DEFAULT_ID,
        onDeliveryStart: delivery => slot.queued.delete(delivery.deliveryId),
      });
      slot.receive = createReceiver({ logger: ctx.logger, webhookRuntime: {
        dispatch(delivery) {
          slot.queued.add(delivery.deliveryId);
          try { return ctx.webhookRuntime.dispatch(delivery); }
          catch (error) { slot.queued.delete(delivery.deliveryId); throw error; }
        },
      } }, slot.config);
      slot.transport = createTransport(ctx, slot.config, (...args) => {
        if (!slot.accepting) throw new Error('Feishu bot is temporarily unavailable');
        return slot.receive(...args);
      });
      slot.handler = createHandler(ctx, slot.config, (...args) => {
        if (!slot.accepting) throw new ManagementError(503, '机器人正在停止');
        return slot.receive(...args);
      });
      slot.accepting = !slot.pauses;
      await slot.transport.reconcile();
    } catch {
      await stop(slot);
      slot.error = '机器人启动失败，请检查项目目录、应用凭据和模型配置后保存重试。';
      ctx.logger.warn('feishu-bot: one bot could not start; other bots remain available');
    }
  }
  function protect(path, actions) {
    const dispose = ctx.webServer.register({ kind: 'exact', path, handler: async (request, response) => {
      try {
        const rejection = ctx.connection.requestRejection(request);
        if (rejection !== undefined) { sendJson(response, rejection, { success: false, message: '请从已登录的 Harness 页面访问此管理接口' }); return; }
        const action = actions[request.method];
        if (!action) { response.setHeader('allow', Object.keys(actions).join(', ')); throw new ManagementError(405, '请求方法不支持'); }
        const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
        sendJson(response, 200, await action(body));
      } catch (error) {
        sendJson(response, error instanceof ManagementError ? error.status : 500, { success: false, message: error instanceof ManagementError ? error.message : '机器人操作失败，请检查本机配置后重试' });
      }
    } });
    routes.push(dispose);
    return dispose;
  }
  async function createSlot(row, initialConfig) {
    const primary = row.id === DEFAULT_ID;
    const config = primary ? baseConfig : {
      ...baseConfig,
      source: `${baseConfig.source}:${row.id}`,
      path: `${baseConfig.path}/${row.id}`,
      configFile: join(storageRoot, row.id, 'config.json'),
      historyRoot: join(storageRoot, row.id, 'history'),
      authorizedUsers: [],
      appIdEnv: `FEISHU_${row.id.toUpperCase()}_APP_ID`,
      appSecretEnv: `FEISHU_${row.id.toUpperCase()}_APP_SECRET`,
      verificationToken: `FEISHU_${row.id.toUpperCase()}_VERIFICATION_TOKEN`,
      encryptKey: `FEISHU_${row.id.toUpperCase()}_ENCRYPT_KEY`,
      ...initialConfig,
    };
    if (!primary) {
      // A missing secondary configuration must never inherit the default
      // project's directory, even if an administrator accidentally removes it.
      const saved = JSON.parse(await readFile(config.configFile, 'utf8'));
      if (saved?.version !== 1 || typeof saved.workspacePath !== 'string' || !isAbsolute(saved.workspacePath)) throw new Error('Invalid saved bot project');
      config.workspacePath = saved.workspacePath;
      await uniqueProject(row.id, config.workspacePath);
    }
    config.botName = row.name;
    const slot = { row, config, client: createClient(ctx, config), effects: [], queued: new Set(), pauses: 0, accepting: false, error: '' };
    slots.set(row.id, slot);
    // Management lives while disabled; only connection/runtime are suspended.
    // Each explicit scope can also roll back a failed catalog addition.
    const managementContext = {
      credentials: ctx.credentials, connection: ctx.connection, webServer: ctx.webServer, logger: ctx.logger,
      effect(run) { const dispose = run(); slot.effects.push(dispose); return dispose; },
    };
    slot.management = await managementFactory(managementContext, config, slot.client, {
      routePrefix: `/api/feishu-bot/bots/${row.id}`,
      ...(primary ? { isTunnelRequired } : { sharedTunnel: defaultService() }),
      serializeUpdate: operation => serialize(() => withIngressPaused(slot, operation)),
      beforeUpdate: async (input, updates) => {
        if (updates.workspacePath && updates.workspacePath !== config.workspacePath) await uniqueProject(row.id, updates.workspacePath);
        const credentialFields = { appId: 'appIdEnv', appSecret: 'appSecretEnv', verificationToken: 'verificationToken', encryptKey: 'encryptKey' };
        let changesCredentials = false;
        for (const [field, ref] of Object.entries(credentialFields)) {
          if (typeof input[field] !== 'string' || !input[field].trim()) continue;
          const saved = (await ctx.credentials.resolve(credentialRef(config[ref])))?.value;
          if (field === 'appId' && saved && saved !== input[field].trim()) throw new ManagementError(409, '已绑定的 App ID 不能替换；请为另一个飞书应用新增机器人，保留各自的历史');
          if (saved !== input[field].trim()) changesCredentials = true;
        }
        if (isBusy(slot) && (changesCredentials || updates.connectionMode && updates.connectionMode !== config.connectionMode)) throw new ManagementError(409, '机器人正在处理任务，请完成后再修改凭据或连接方式');
        if (typeof input.appId === 'string' && input.appId.trim()) await uniqueApp(row.id, input.appId.trim());
      },
      onConfigChanged: async () => {
        config.expectedAppId = (await ctx.credentials.resolve(credentialRef(config.appIdEnv)))?.value || '';
        if (row.enabled) {
          if (!slot.runtime) await start(slot);
          else { await slot.runtime.reconcile?.(); await slot.transport?.reconcile(); }
        }
        // Default management reconciles itself after this hook; secondaries
        // notify the shared server when their transport mode changes.
        if (!primary) await reconcileTunnel();
      },
      getConnectionStatus: () => status(slot),
    });
    slot.effects.push(ctx.webServer.register({ kind: 'exact', path: config.path, handler: async (request, response) => {
      if (!slot.accepting || !slot.handler) {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' });
        response.end(JSON.stringify({ error: 'Feishu bot is disabled or unavailable' }));
        return;
      }
      return slot.handler(request, response);
    } }));
    slot.effects.push(protect(`/api/feishu-bot/bots/${row.id}/meta`, { POST: input => serialize(() => withIngressPaused(slot, async () => {
      if ('enabled' in input && typeof input.enabled !== 'boolean') throw new ManagementError(400, '启用状态必须为布尔值');
      const nextName = 'name' in input ? botName(input.name) : row.name;
      const nextEnabled = input.enabled ?? row.enabled;
      if (!nextEnabled && row.enabled && isBusy(slot)) throw new ManagementError(409, '机器人正在处理任务，请完成后再停用');
      if (nextEnabled && !row.enabled) await uniqueApp(row.id, (await ctx.credentials.resolve(credentialRef(config.appIdEnv)))?.value);
      const next = { ...catalog, bots: catalog.bots.map(item => item.id === row.id ? { ...item, name: nextName, enabled: nextEnabled } : item) };
      await saveJson(catalogFile, next);
      row.name = nextName; row.enabled = nextEnabled; config.botName = nextName;
      if (nextEnabled) await start(slot); else await stop(slot);
      await reconcileTunnel();
      return { success: true, bot: view(slot) };
    })) }));
    return slot;
  }
  const service = {
    list() { return { defaultBotId: DEFAULT_ID, bots: [...slots.values()].map(view) }; },
    create(input) { return serialize(async () => {
      if (catalog.bots.length >= 50) throw new ManagementError(400, '单个实例最多配置 50 个机器人');
      const name = botName(input.name);
      const id = `bot_${randomUUID().replaceAll('-', '')}`;
      const workspacePath = await uniqueProject(id, input.workspacePath);
      const connectionMode = input.connectionMode ?? 'webhook';
      if (!['webhook', 'websocket'].includes(connectionMode)) throw new ManagementError(400, '请选择开发者服务器或长连接');
      const row = { id, name, enabled: true };
      const filename = join(storageRoot, id, 'config.json');
      await saveJson(filename, { version: 1, workspacePath, connectionMode });
      const next = { ...catalog, bots: [...catalog.bots, row] };
      let slot;
      try {
        slot = await createSlot(row, { workspacePath, connectionMode });
        await saveJson(catalogFile, next);
        catalog = next;
      } catch (error) {
        const failed = slots.get(id);
        if (failed) {
          await stop(failed);
          for (const dispose of failed.effects.reverse()) await dispose?.();
          slots.delete(id);
        }
        await unlink(filename).catch(() => {});
        throw error;
      }
      await start(slot);
      await reconcileTunnel();
      return { success: true, bot: view(slot) };
    }); },
    get default() { return defaultService(); },
    dispose() {
      disposal ??= (async () => {
        closing = true;
        await chain;
        const errors = [];
        for (const dispose of routes.reverse()) {
          try { await dispose?.(); } catch (error) { errors.push(error); }
        }
        for (const slot of [...slots.values()].reverse()) {
          try { await stop(slot); } catch (error) { errors.push(error); }
          for (const dispose of slot.effects.reverse()) {
            try { await dispose?.(); } catch (error) { errors.push(error); }
          }
        }
        try { await hub?.dispose(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Some Feishu resources could not be closed');
      })();
      return disposal;
    },
  };
  try {
    await createSlot(catalog.bots.find(row => row.id === DEFAULT_ID));
    for (const row of catalog.bots) if (row.id !== DEFAULT_ID) await createSlot(row);
    for (const slot of slots.values()) await start(slot);
    protect('/api/feishu-bot/bots', { GET: () => service.list(), POST: input => service.create(input) });
    // Preserve URLs used by existing deployments and external local tooling.
    const aliases = {
      '/config': { GET: () => defaultService().getConfig(), POST: body => defaultService().updateConfig(body) },
      '/test': { POST: body => defaultService().testConnection(body) },
      '/connection/status': { GET: () => status(slots.get(DEFAULT_ID)) },
      '/webhook-url': { GET: async () => ({ url: await defaultService().getWebhookUrl() }) },
      '/tunnel/status': { GET: () => defaultService().getTunnelStatus() },
      '/tunnel/start': { POST: () => defaultService().startTunnel() },
      '/tunnel/stop': { POST: () => defaultService().stopTunnel() },
      '/ngrok/status': { GET: () => defaultService().getNgrokStatus() },
      '/ngrok/start': { POST: () => defaultService().startNgrok() },
      '/ngrok/stop': { POST: () => defaultService().stopNgrok() },
    };
    for (const [path, actions] of Object.entries(aliases)) protect(`/api/feishu-bot${path}`, actions);
    await reconcileTunnel();
    return service;
  } catch (error) {
    await service.dispose();
    throw error;
  }
}
