/* Browser entry for the Harness module loader. No Vue compiler or CDN required. */
window.__ModuleLoader__.load({
  id: '@icanotcode/dsh-feishu-bot',
  factory: (require) => {
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const h = React.createElement;
    const { useEffect, useState, useId } = React;
    // Harness inventory currently has no configuration slot. Attach only to our
    // expanded cards, using its semantic attributes rather than generated CSS.
    function mountInventorySettings() {
      const selector = '[data-plugin-module="@icanotcode/dsh-feishu-bot"], [data-plugin-module="@deepseek-ai/dsh-feishu-bot"]';
      const mounted = new Map();
      function reconcile() {
        for (const [details, entry] of mounted) {
          if (details.isConnected && entry.card.dataset.open === 'true' && entry.card.contains(details)) continue;
          entry.root.unmount();
          entry.container.remove();
          entry.card.removeAttribute('data-feishu-settings');
          mounted.delete(details);
        }
        for (const card of document.querySelectorAll(selector)) {
          if (card.dataset.open !== 'true') continue;
          const trigger = card.querySelector('button[aria-controls]');
          const details = document.getElementById(trigger?.getAttribute('aria-controls'));
          if (!details || !card.contains(details) || mounted.has(details)) continue;
          const container = document.createElement('div');
          container.className = 'feishu-inventory-settings';
          details.appendChild(container);
          const root = createRoot(container);
          mounted.set(details, { card, container, root });
          card.setAttribute('data-feishu-settings', 'true');
          root.render(h(FeishuSettings));
        }
      }
      const observer = new MutationObserver(reconcile);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-open'] });
      reconcile();
      return () => {
        observer.disconnect();
        for (const { card, container, root } of mounted.values()) {
          root.unmount();
          container.remove();
          card.removeAttribute('data-feishu-settings');
        }
        mounted.clear();
      };
    }

    const defaults = {
      connectionMode: 'webhook', appId: '', appSecret: '', verificationToken: '', encryptKey: '',
      workspacePath: '', agentPreset: 'standard', permissionPreset: 'workspace-write',
      tunnelProvider: 'ngrok', ngrokAuthtoken: '', ngrokDomain: '', publicBaseUrl: '',
      authorizedUsers: [], dailyResetHour: 4, dailyResetTimezone: 'Asia/Macau'
    };
    const secrets = ['appSecret', 'verificationToken', 'encryptKey', 'ngrokAuthtoken'];

    async function request(path, body) {
      const response = await fetch(`/api/feishu-bot/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        })
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error(`服务响应异常（HTTP ${response.status}），请确认飞书插件已启动。`); }
      if (!response.ok || data.success === false) {
        throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（HTTP ${response.status}）`);
      }
      return data;
    }

    function FeishuSettings() {
      const prefix = useId();
      const [config, setConfig] = useState(defaults);
      const [loading, setLoading] = useState(true);
      const [loadError, setLoadError] = useState('');
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null);
      const [webhook, setWebhook] = useState('');
      const [tunnel, setTunnel] = useState(null);
      const [statusError, setStatusError] = useState('');
      const [connection, setConnection] = useState(null);
      const [connectionError, setConnectionError] = useState('');
      const [savedMode, setSavedMode] = useState('webhook');
      const [savedProvider, setSavedProvider] = useState('ngrok');
      const [reload, setReload] = useState(0);
      const [connected, setConnected] = useState(false);
      const [secretFlags, setSecretFlags] = useState({});
      const [authorizedUsersText, setAuthorizedUsersText] = useState('');

      function applyConfig(data) {
        const value = data.config || data;
        const safe = { ...defaults, ...value };
        secrets.forEach(key => { safe[key] = ''; });
        setConfig(safe);
        setAuthorizedUsersText(safe.authorizedUsers.map(user => `${user.openId} ${user.displayName}`).join('\n'));
        setSavedMode(safe.connectionMode);
        setSavedProvider(safe.tunnelProvider);
        setSecretFlags(data.configured || data.secrets || value.configured || {});
      }

      useEffect(() => {
        let active = true;
        setLoading(true);
        setLoadError('');
        request('config').then(data => {
          if (active) applyConfig(data);
        }).catch(error => { if (active) setLoadError(error.message); })
          .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
      }, [reload]);

      async function refreshStatus() {
        const results = await Promise.allSettled([request('webhook-url'), request('tunnel/status'), request('connection/status')]);
        if (results[0].status === 'fulfilled') setWebhook(results[0].value.url || '');
        if (results[1].status === 'fulfilled') setTunnel(results[1].value);
        setStatusError(results.slice(0, 2).filter(result => result.status === 'rejected').map(result => result.reason.message).join('；'));
        if (results[2].status === 'fulfilled') {
          setConnection(results[2].value);
          setConnectionError('');
        } else setConnectionError(results[2].reason.message);
      }
      useEffect(() => {
        let active = true;
        Promise.allSettled([request('webhook-url'), request('tunnel/status')]).then(results => {
          if (!active) return;
          if (results[0].status === 'fulfilled') setWebhook(results[0].value.url || '');
          if (results[1].status === 'fulfilled') setTunnel(results[1].value);
          setStatusError(results.filter(result => result.status === 'rejected').map(result => result.reason.message).join('；'));
        });
        return () => { active = false; };
      }, [reload]);

      useEffect(() => {
        let active = true;
        let timer;
        async function poll() {
          try {
            const data = await request('connection/status');
            if (active) { setConnection(data); setConnectionError(''); }
          } catch (error) { if (active) setConnectionError(error.message); }
          // Schedule after completion so a slow request cannot overlap the next poll.
          if (active) timer = setTimeout(poll, 10000);
        }
        poll();
        return () => { active = false; clearTimeout(timer); };
      }, [reload]);

      function payload() {
        const authorizedUsers = authorizedUsersText.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
          const match = line.trim().match(/^(\S+)\s+(.+)$/);
          if (!match) throw new Error(`授权用户第 ${index + 1} 行需要填写 open_id 和显示名称，用空格分隔。`);
          const permissionPreset = config.authorizedUsers.find(user => user.openId === match[1])?.permissionPreset;
          return { openId: match[1], displayName: match[2].trim(), ...(permissionPreset ? { permissionPreset } : {}) };
        });
        // Omit empty secret fields: the server retains previously saved credentials.
        return Object.fromEntries(Object.keys(defaults)
          .filter(key => !secrets.includes(key) || config[key])
          .map(key => [key, key === 'authorizedUsers' ? authorizedUsers : config[key]]));
      }
      async function run(action, task) {
        setBusy(action);
        setNotice(null);
        try { await task(); }
        catch (error) { setNotice({ error: true, text: error.message }); }
        finally { setBusy(''); }
      }
      function edit(key, value) {
        setConfig(previous => ({ ...previous, [key]: value }));
        setConnected(false);
        setNotice(null);
      }
      function field(key, title, options = {}) {
        const id = `${prefix}-${key}`;
        const shared = {
          id, value: config[key] ?? '', disabled: Boolean(busy),
          onChange: event => edit(key, options.numeric ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value)
        };
        return h('div', { className: 'feishu-field', key },
          h('label', { htmlFor: id }, title),
          options.choices
            ? h('select', shared, options.choices.map(([value, label]) => h('option', { key: value, value }, label)))
            : h('input', { ...shared, type: options.numeric ? 'number' : secrets.includes(key) ? 'password' : 'text',
              ...(options.numeric ? { min: 0, max: 23, step: 1 } : {}),
              autoComplete: secrets.includes(key) ? 'new-password' : 'off',
              placeholder: options.placeholder || (secrets.includes(key) ? '留空保留已保存的值' : '') }),
          options.hint && h('small', null, options.hint),
          secretFlags[key] && h('small', null, '已保存凭证；填写新值可替换。'));
      }
      function button(label, onClick, action, primary = false) {
        return h('button', { type: 'button', disabled: Boolean(busy), onClick,
          className: primary ? 'feishu-primary' : '' }, busy === action ? '处理中…' : label);
      }
      const modeName = mode => mode === 'websocket' ? '长连接' : '开发者服务器（Webhook）';
      const providerNames = { ngrok: 'ngrok', cloudflare: 'Cloudflare Tunnel', custom: '自定义公网地址' };
      const stateNames = {
        disabled: '未启用', starting: '正在启动', connecting: '正在连接', connected: '已连接',
        reconnecting: '正在重连', stopped: '已停止', error: '连接异常',
        waiting_configuration: '等待配置', listening: '等待事件', ready: '已就绪', disconnected: '已断开'
      };

      return h('div', { className: 'feishu-settings' },
        h('h2', null, '飞书机器人'),
        h('p', { className: 'feishu-muted' }, '连接飞书企业自建应用，让收到的消息交给 Harness 处理。'),
        loading ? h('p', { role: 'status' }, '正在读取配置…') : loadError
          ? h('div', { role: 'alert' }, h('p', null, loadError), button('重新加载', () => setReload(reload + 1), 'reload'))
          : h(React.Fragment, null,
            h('form', { onSubmit: event => {
              event.preventDefault();
              run('save', async () => {
                await request('config', payload());
                applyConfig(await request('config'));
                await refreshStatus();
                setNotice({ text: '配置已保存。' });
              });
            } },
              h('section', null,
                h('h3', null, '事件接收方式'),
                field('connectionMode', '连接方式', { choices: [
                  ['webhook', '将事件发送至开发者服务器（Webhook）'], ['websocket', '使用长连接接收事件']
                ], hint: '选择后保存生效，并在飞书开放平台的「事件与回调 → 事件配置」中选择相同的订阅方式。' }),
                config.connectionMode !== savedMode && h('p', { role: 'status', className: 'feishu-muted' },
                  `连接方式尚未保存；已保存的方式为${modeName(savedMode)}。`),
                h('p', { role: 'status' }, connection
                  ? `当前运行：${modeName(connection.mode)} · ${stateNames[connection.state] || connection.state || '状态未知'}`
                  : '正在读取当前连接状态…'),
                connection?.message && h('p', { className: 'feishu-muted' }, connection.message),
                connectionError && h('p', { role: 'alert', className: 'feishu-error' }, `连接状态暂不可用：${connectionError}`),
                config.connectionMode === 'websocket' && h('p', { className: 'feishu-muted' },
                  '长连接使用 App ID 和 App Secret，无需公网地址、公网隧道、Verification Token 或 Encrypt Key。保存后由 Harness 建立连接；在飞书后台同步选择「使用长连接接收事件」，并订阅 im.message.receive_v1。'),
                button('刷新连接状态', () => run('status', refreshStatus), 'status')),
              h('section', null,
                h('h3', null, '应用凭证'),
                field('appId', 'App ID', { placeholder: 'cli_xxxxxxxxxxxxxxxx', hint: '在飞书开放平台的「凭证与基础信息」中获取。' }),
                field('appSecret', 'App Secret'),
                config.connectionMode === 'webhook' && field('verificationToken', 'Verification Token', { hint: '接收消息前请配置事件订阅中的 Token，或启用下方的加密签名验证。' }),
                config.connectionMode === 'webhook' && field('encryptKey', 'Encrypt Key（启用事件加密时填写）'),
                h('div', { className: 'feishu-actions' },
                  button('测试连接', () => run('test', async () => {
                    setConnected(false);
                    await request('test', payload());
                    setConnected(true);
                    setNotice({ text: '飞书凭证验证成功。修改后的配置仍需保存。' });
                  }), 'test'),
                  h('span', { className: 'feishu-muted' }, connected ? '凭证验证成功' : '尚未验证当前配置'))),
              h('section', null,
                h('h3', null, '任务处理'),
                h('p', { className: 'feishu-muted' }, '处理任务时会给原消息添加 Typing（敲键盘）表情，结束后移除。需要应用权限 im:message.reactions:write_only；请在飞书开放平台开通并发布生效。缺少权限时仍会处理消息，但无法显示状态表情。'),
                field('workspacePath', '用户工作目录根路径', { placeholder: '/path/to/workspaces', hint: '必须是已存在的绝对路径。插件在此为每位用户创建独立子目录；请使用专门的空目录。' }),
                field('agentPreset', 'Agent 预设', { hint: '填写当前 Harness 已安装的预设名称，例如 standard。' }),
                field('permissionPreset', '权限预设', { choices: [
                  ['read-only', '只读'], ['workspace-write', '工作区写入']
                ] }),
                h('p', { className: 'feishu-muted' }, '飞书会话仅使用本用户的历史记录工具和受限工作区文件工具，不提供任意主机 Shell 或通用文件访问。只读模式禁止修改工作区文件。')),
              h('section', null,
                h('h3', null, '用户授权与会话'),
                h('div', { className: 'feishu-field' },
                  h('label', { htmlFor: `${prefix}-authorizedUsers` }, '授权用户（每行 open_id 显示名称）'),
                  h('textarea', { id: `${prefix}-authorizedUsers`, rows: 5, value: authorizedUsersText,
                    placeholder: 'ou_example 张三\nou_another 李四', disabled: Boolean(busy), spellCheck: false,
                    onChange: event => {
                      const value = event.target.value;
                      setAuthorizedUsersText(value);
                      setConfig(previous => ({ ...previous, authorizedUsers: value.split(/\r?\n/).filter(line => line.trim()).map(line => {
                        const [, openId, displayName = ''] = line.trim().match(/^(\S+)(?:\s+(.*))?$/);
                        const permissionPreset = previous.authorizedUsers.find(user => user.openId === openId)?.permissionPreset;
                        return { openId, displayName, ...(permissionPreset ? { permissionPreset } : {}) };
                      }) }));
                      setNotice(null);
                    } }),
                  h('small', null, '仅允许名单中的用户，留空会拒绝所有用户。open_id 是用户在当前飞书应用内的身份标识，不能用姓名代替；显示名称用于命名 Harness 会话。')),
                config.authorizedUsers.map((user, index) => h('div', { className: 'feishu-field', key: `${user.openId}-${index}` },
                  h('label', { htmlFor: `${prefix}-user-permission-${index}` }, `${user.displayName || user.openId} 的工作区权限`),
                  h('select', { id: `${prefix}-user-permission-${index}`, value: user.permissionPreset || '', disabled: Boolean(busy),
                    onChange: event => edit('authorizedUsers', config.authorizedUsers.map((entry, entryIndex) => {
                      if (entryIndex !== index) return entry;
                      const { permissionPreset: _oldPermission, ...identity } = entry;
                      return { ...identity, ...(event.target.value ? { permissionPreset: event.target.value } : {}) };
                    })) },
                  h('option', { value: '' }, '继承默认权限'),
                  h('option', { value: 'read-only' }, '只读'),
                  h('option', { value: 'workspace-write' }, '工作区写入')))),
                h('p', { className: 'feishu-muted' }, '可为每位用户单独设置工作区读写权限；继承默认时使用上方权限预设。姓名修改保留同一 open_id 的权限，移除用户会同时移除其权限设置。'),
                h('p', { className: 'feishu-muted' }, '同一用户在同一聊天中默认延续当前会话，发送 /new 新开会话；不同用户、不同群聊的上下文分开，历史数据库仅供所属用户查询和管理。'),
                field('dailyResetHour', '每日上下文切换时间（小时）', { numeric: true, hint: '默认凌晨 4 点。正在执行的任务完成后再切换，历史记录继续保留。' }),
                field('dailyResetTimezone', '每日上下文切换时区', { placeholder: 'Asia/Macau', hint: '使用 IANA 时区名称，例如 Asia/Macau。/new 和每日切换只重置当前上下文，不删除历史；提及旧内容时可从个人历史数据库查找。' })),
              config.connectionMode === 'webhook' && h('section', null,
                h('h3', null, 'Webhook 与公网地址'),
                h('label', { htmlFor: `${prefix}-harness-port` }, '当前 Harness 监听端口'),
                h('input', { id: `${prefix}-harness-port`, readOnly: true, value: config.harnessPort || '', placeholder: '等待获取实际端口' }),
                h('p', { className: 'feishu-muted' }, '端口由 Harness 管理，插件自动读取。需要更换时，停止原实例，再用 dsh web --port 新端口 启动，并同步修改隧道目标端口；保存插件配置不会更改监听端口。'),
                field('tunnelProvider', '公网接入方式', { choices: [
                  ['ngrok', 'ngrok'], ['cloudflare', 'Cloudflare Tunnel'], ['custom', '自定义公网地址 / 反向代理']
                ], hint: '选择后保存生效。隧道由你在本机或服务器上启动，插件不自动启动或停止。' }),
                config.tunnelProvider !== savedProvider && h('p', { role: 'status', className: 'feishu-muted' },
                  `公网接入方式尚未保存；已保存的方式为 ${providerNames[savedProvider]}。原公网地址会保留，请更新为所选服务提供的地址后保存。`),
                field('publicBaseUrl', config.tunnelProvider === 'ngrok' ? '公网服务地址（可选）' : '公网服务地址', {
                  placeholder: config.tunnelProvider === 'cloudflare' ? 'https://your-tunnel.trycloudflare.com' : 'https://your-host.example',
                  hint: config.tunnelProvider === 'ngrok' ? '填写 HTTPS 根地址；留空时检测指向当前 Harness 端口的 ngrok 隧道。' : '填写隧道或反向代理提供的 HTTPS 根地址，不包含 /webhook/feishu；保存后生成完整回调地址。'
                }),
                config.tunnelProvider === 'cloudflare' && h('div', { className: 'feishu-muted' },
                  h('p', null, '安装 cloudflared 后，可在终端启动 Quick Tunnel：'),
                  h('code', null, Number.isInteger(config.harnessPort) && config.harnessPort > 0
                    ? `cloudflared tunnel --url http://127.0.0.1:${config.harnessPort}` : '请先刷新页面以获取当前 Harness 端口'),
                  h('p', null, '将终端输出的 HTTPS 地址填入上方。Quick Tunnel 地址会变化，重启后需要重新保存并更新飞书回调地址。固定域名请使用已配置的命名隧道。')),
                h('label', { htmlFor: `${prefix}-webhook` }, '已保存配置的 Webhook 地址'),
                h('div', { className: 'feishu-actions' },
                  h('input', { id: `${prefix}-webhook`, readOnly: true, value: webhook, placeholder: '配置公网地址后显示' }),
                  h('button', { type: 'button', disabled: !webhook || Boolean(busy), onClick: () => run('copy', async () => {
                    await navigator.clipboard.writeText(webhook);
                    setNotice({ text: 'Webhook 地址已复制。' });
                  }) }, '复制')),
                h('p', { className: 'feishu-muted' }, '在飞书应用的「事件订阅」中填写公网可访问的请求地址，并添加 im.message.receive_v1 事件。'),
                h('p', { role: 'status' }, tunnel
                  ? `已保存配置的公网状态（${providerNames[tunnel.provider] || tunnel.provider}）：${tunnel.state === 'not_required' ? '长连接无需隧道' : tunnel.provider === 'ngrok' ? (tunnel.running ? '已检测到 ngrok 隧道' : '未检测到 ngrok 隧道') : tunnel.state === 'configured' ? '地址已配置，连接未验证' : '地址未配置'}`
                  : '尚未取得公网接入状态'),
                tunnel?.message && h('p', { className: 'feishu-muted' }, tunnel.message),
                statusError && h('p', { role: 'alert', className: 'feishu-error' }, statusError),
                config.tunnelProvider === 'ngrok' && h('div', { className: 'feishu-muted' },
                  h('p', null, '请在本机启动 ngrok；此处检测指向当前 Harness 端口的已有隧道。将 YOUR-NGROK-DOMAIN 替换为自己的域名，并按需保留现有的 --traffic-policy-file 参数：'),
                  h('code', null, Number.isInteger(config.harnessPort) && config.harnessPort > 0
                    ? `ngrok http ${config.harnessPort} --url https://YOUR-NGROK-DOMAIN` : '请先刷新页面以获取当前 Harness 端口'),
                  h('p', null, '飞书 POST 回调不能完成浏览器登录。入口策略需要允许它到达 /webhook/feishu，由插件校验飞书凭据；管理页面保留访问保护。')),
                button('刷新状态', () => run('status', refreshStatus), 'status')),
              h('div', { className: 'feishu-actions' },
                h('button', { type: 'submit', disabled: Boolean(busy), className: 'feishu-primary' }, busy === 'save' ? '保存中…' : '保存配置'))),
            notice && h('p', { role: notice.error ? 'alert' : 'status', className: notice.error ? 'feishu-error' : 'feishu-success' }, notice.text),
            h('p', { className: 'feishu-muted' }, '每日上下文切换由插件管理，其他通用定时任务尚未接入执行器。'),
            h('a', { href: 'https://open.feishu.cn/app', target: '_blank', rel: 'noopener noreferrer' }, '打开飞书开放平台')));
    }

    const css = `
      [data-feishu-settings="true"]{grid-column:1/-1}
      .feishu-inventory-settings{border-top:1px solid var(--dsw-alias-border-l2,#ddd);margin-top:16px;padding-top:16px}
      .feishu-settings{max-width:760px;padding:8px 4px 24px;color:var(--dsw-alias-label-primary,#202124);font-size:14px;line-height:1.6}
      .feishu-settings *{box-sizing:border-box}.feishu-settings h2{margin:0 0 4px;font-size:21px}.feishu-settings h3{margin:0 0 16px;font-size:16px}
      .feishu-settings section{border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;padding:18px;margin:20px 0}
      .feishu-field{display:flex;flex-direction:column;gap:6px;margin:14px 0}.feishu-settings label{font-weight:500}
      .feishu-settings input,.feishu-settings select,.feishu-settings textarea{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;padding:9px 11px;font:inherit}
      .feishu-settings textarea{resize:vertical}
      .feishu-settings button{border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:8px;padding:8px 14px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
      .feishu-settings button:disabled{opacity:.55;cursor:default}.feishu-settings .feishu-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:white}
      .feishu-settings :is(input,select,textarea,button,a):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
      .feishu-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.feishu-actions input{flex:1;min-width:160px}
      .feishu-muted,.feishu-field small{color:var(--dsw-alias-label-secondary,#686a70)}.feishu-settings .feishu-error{color:var(--dsw-alias-label-error,#ba3030);overflow-wrap:anywhere}.feishu-success{color:#258047}
      .feishu-settings a{color:var(--dsw-alias-brand-primary,#4d6bfe)}
      @media(max-width:480px){.feishu-settings section{padding:12px}.feishu-settings{padding:4px 0 18px}}
    `;

    return {
      inject: [],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = '@icanotcode/dsh-feishu-bot';
          style.textContent = css;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'feishu-bot: settings styles');
        ctx.effect(mountInventorySettings, 'feishu-bot: inventory settings');
      }
    };
  }
});
