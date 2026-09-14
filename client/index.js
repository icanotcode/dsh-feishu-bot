/* Browser entry for the Harness module loader. No Vue compiler or CDN required. */
window.__ModuleLoader__.load({
  id: '@icanotcode/dsh-feishu-bot',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useId } = React;
    const defaults = {
      connectionMode: 'webhook', appId: '', appSecret: '', verificationToken: '', encryptKey: '',
      workspacePath: '', agentPreset: 'standard', permissionPreset: 'workspace-write',
      ngrokAuthtoken: '', ngrokDomain: '', publicBaseUrl: ''
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
      const [reload, setReload] = useState(0);
      const [connected, setConnected] = useState(false);
      const [secretFlags, setSecretFlags] = useState({});

      function applyConfig(data) {
        const value = data.config || data;
        const safe = { ...defaults, ...value };
        secrets.forEach(key => { safe[key] = ''; });
        setConfig(safe);
        setSavedMode(safe.connectionMode);
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
        const results = await Promise.allSettled([request('webhook-url'), request('ngrok/status'), request('connection/status')]);
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
        Promise.allSettled([request('webhook-url'), request('ngrok/status')]).then(results => {
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
        // Omit empty secret fields: the server retains previously saved credentials.
        return Object.fromEntries(Object.keys(defaults)
          .filter(key => !secrets.includes(key) || config[key])
          .map(key => [key, config[key]]));
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
          id, value: config[key] || '', disabled: Boolean(busy),
          onChange: event => edit(key, event.target.value)
        };
        return h('div', { className: 'feishu-field', key },
          h('label', { htmlFor: id }, title),
          options.choices
            ? h('select', shared, options.choices.map(([value, label]) => h('option', { key: value, value }, label)))
            : h('input', { ...shared, type: secrets.includes(key) ? 'password' : 'text',
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
                  '长连接使用 App ID 和 App Secret，无需公网地址、ngrok、Verification Token 或 Encrypt Key。保存后由 Harness 建立连接；在飞书后台同步选择「使用长连接接收事件」，并订阅 im.message.receive_v1。'),
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
                field('workspacePath', '工作目录', { placeholder: '/path/to/workspace' }),
                field('agentPreset', 'Agent 预设', { hint: '填写当前 Harness 已安装的预设名称，例如 standard。' }),
                field('permissionPreset', '权限预设', { choices: [
                  ['read-only', '只读'], ['workspace-write', '工作区写入'], ['danger-full-access', '完全访问']
                ] })),
              config.connectionMode === 'webhook' && h('section', null,
                h('h3', null, 'Webhook 与公网地址'),
                h('label', { htmlFor: `${prefix}-webhook` }, 'Webhook 地址'),
                h('div', { className: 'feishu-actions' },
                  h('input', { id: `${prefix}-webhook`, readOnly: true, value: webhook, placeholder: '配置公网地址后显示' }),
                  h('button', { type: 'button', disabled: !webhook || Boolean(busy), onClick: () => run('copy', async () => {
                    await navigator.clipboard.writeText(webhook);
                    setNotice({ text: 'Webhook 地址已复制。' });
                  }) }, '复制')),
                h('p', { className: 'feishu-muted' }, '在飞书应用的「事件订阅」中填写公网可访问的请求地址，并添加 im.message.receive_v1 事件。'),
                field('publicBaseUrl', '公网服务地址（可选）', { placeholder: 'https://your-host.example', hint: '使用反向代理时填写公网 HTTPS 地址；留空时尝试使用已有 ngrok 隧道。' }),
                h('p', null, tunnel ? (tunnel.running ? `ngrok 运行中：${tunnel.url || ''}` : 'ngrok 未运行') : '尚未取得 ngrok 状态'),
                tunnel?.message && h('p', { className: 'feishu-muted' }, tunnel.message),
                statusError && h('p', { role: 'alert', className: 'feishu-error' }, statusError),
                h('p', { className: 'feishu-muted' }, '如需 ngrok，请在本机启动隧道。此处读取本机已有隧道的状态。'),
                button('刷新状态', () => run('status', refreshStatus), 'status')),
              h('div', { className: 'feishu-actions' },
                h('button', { type: 'submit', disabled: Boolean(busy), className: 'feishu-primary' }, busy === 'save' ? '保存中…' : '保存配置'))),
            notice && h('p', { role: notice.error ? 'alert' : 'status', className: notice.error ? 'feishu-error' : 'feishu-success' }, notice.text),
            h('p', { className: 'feishu-muted' }, '定时任务尚未接入执行器。'),
            h('a', { href: 'https://open.feishu.cn/app', target: '_blank', rel: 'noopener noreferrer' }, '打开飞书开放平台')));
    }

    const css = `
      .feishu-settings{max-width:760px;padding:8px 4px 24px;color:var(--dsw-alias-label-primary,#202124);font-size:14px;line-height:1.6}
      .feishu-settings *{box-sizing:border-box}.feishu-settings h2{margin:0 0 4px;font-size:21px}.feishu-settings h3{margin:0 0 16px;font-size:16px}
      .feishu-settings section{border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;padding:18px;margin:20px 0}
      .feishu-field{display:flex;flex-direction:column;gap:6px;margin:14px 0}.feishu-settings label{font-weight:500}
      .feishu-settings input,.feishu-settings select{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;padding:9px 11px;font:inherit}
      .feishu-settings button{border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:8px;padding:8px 14px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
      .feishu-settings button:disabled{opacity:.55;cursor:default}.feishu-settings .feishu-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:white}
      .feishu-settings :is(input,select,button,a):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
      .feishu-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.feishu-actions input{flex:1;min-width:160px}
      .feishu-muted,.feishu-field small{color:var(--dsw-alias-label-secondary,#686a70)}.feishu-settings .feishu-error{color:var(--dsw-alias-label-error,#ba3030);overflow-wrap:anywhere}.feishu-success{color:#258047}
      .feishu-settings a{color:var(--dsw-alias-brand-primary,#4d6bfe)}
      @media(max-width:480px){.feishu-settings section{padding:12px}.feishu-settings{padding:4px 0 18px}}
    `;

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = '@icanotcode/dsh-feishu-bot';
          style.textContent = css;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'feishu-bot: settings styles');
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'feishu-bot', order: 20, label: () => '飞书机器人'
        }, FeishuSettings));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'feishu-bot', order: 25, label: () => '飞书机器人'
        }, FeishuSettings));
      }
    };
  }
});
