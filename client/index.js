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
      tunnelAutoRestart: false, ngrokTrafficPolicyFile: '', ngrokExecutablePath: '',
      cloudflareExecutablePath: '', cloudflareMode: 'quick', cloudflareTunnelName: '', cloudflareConfigFile: '',
      dailyResetHour: 4, dailyResetTimezone: 'Asia/Macau'
    };
    const secrets = ['appSecret', 'verificationToken', 'encryptKey', 'ngrokAuthtoken'];
    const tunnelFields = ['connectionMode', 'tunnelProvider', 'publicBaseUrl', 'tunnelAutoRestart',
      'ngrokAuthtoken', 'ngrokDomain', 'ngrokTrafficPolicyFile', 'ngrokExecutablePath',
      'cloudflareExecutablePath', 'cloudflareMode', 'cloudflareTunnelName', 'cloudflareConfigFile'];

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

    function ProjectPicker({ id, label, value, onChange, botId, disabled }) {
      const [open, setOpen] = useState(false);
      const [searchMode, setSearchMode] = useState(false);
      const [query, setQuery] = useState('');
      const [projects, setProjects] = useState([]);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [warning, setWarning] = useState('');
      const [reload, setReload] = useState(0);
      const [activeIndex, setActiveIndex] = useState(-1);
      const listId = `${id}-results`;
      useEffect(() => {
        if (!open) return;
        let active = true;
        setLoading(true); setError(''); setWarning('');
        request('projects').then(data => {
          if (!active) return;
          setProjects(data.projects); setWarning(data.warning || '');
        }).catch(cause => { if (active) setError(cause.message); })
          .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
      }, [open, reload]);
      useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
      const tokens = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      const filtered = projects.filter(project => {
        const text = `${project.name} ${project.path}`.normalize('NFKC').toLocaleLowerCase();
        return tokens.every(token => text.includes(token));
      });
      const unavailable = project => project.available === false || Boolean(project.botId && project.botId !== botId);
      function close(restoreFocus = false) {
        setOpen(false); setSearchMode(false); setQuery(''); setActiveIndex(-1);
        if (restoreFocus) document.getElementById(id)?.focus?.();
      }
      function choose(project) {
        if (disabled || loading || error || unavailable(project)) return;
        onChange(project.path); close(true);
      }
      function navigate(event) {
        if (event.nativeEvent?.isComposing || event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!loading && !error && filtered[activeIndex]) choose(filtered[activeIndex]);
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || loading || error) return;
        event.preventDefault();
        const indices = filtered.map((project, index) => unavailable(project) ? -1 : index).filter(index => index >= 0);
        if (!indices.length) return;
        const previous = indices.indexOf(activeIndex);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? indices.length - 1
          : event.key === 'ArrowDown' ? (previous + 1) % indices.length
            : previous <= 0 ? indices.length - 1 : previous - 1;
        setActiveIndex(indices[next]);
        const option = document.getElementById(`${listId}-${indices[next]}`);
        option?.scrollIntoView?.({ block: 'nearest' });
        if (!searchMode) option?.focus?.();
      }
      return h('div', { className: 'feishu-field feishu-project-picker',
        onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); } },
        h('label', { htmlFor: id }, label),
        h('div', { className: 'feishu-project-control' },
          h('button', { id, type: 'button', value: value || '', disabled,
            className: 'feishu-project-trigger', 'aria-expanded': open, 'aria-controls': listId, 'aria-haspopup': 'listbox',
            'aria-label': `${label}：${value || '未选择'}，展开项目列表`,
            onKeyDown: event => { if (open && !searchMode && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) navigate(event); },
            onClick: () => {
              if (open && !searchMode) close();
              else { setSearchMode(false); setQuery(''); setActiveIndex(-1); setOpen(true); }
            } },
            h('span', { className: value ? 'feishu-project-value' : 'feishu-project-value feishu-muted' }, value || '请选择 Harness 项目目录'),
            h('span', { 'aria-hidden': true }, open ? '▴' : '▾')),
          h('button', { id: `${id}-search`, type: 'button', disabled, className: 'feishu-project-search',
            title: '搜索项目', 'aria-label': `搜索${label}`, 'aria-expanded': open && searchMode, 'aria-controls': `${id}-panel`,
            onClick: () => {
              setSearchMode(true); setOpen(true); setActiveIndex(-1);
              document.getElementById(`${id}-query`)?.focus?.();
            } },
            h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
              h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }), h('path', { d: 'm16 16 5 5', strokeLinecap: 'round' })))),
        open && h('div', { id: `${id}-panel`, className: 'feishu-project-panel', onKeyDown: event => { if (event.key === 'Escape') navigate(event); } },
          searchMode && h(React.Fragment, null,
            h('label', { htmlFor: `${id}-query`, className: 'feishu-sr-only' }, `搜索${label}`),
            h('input', { id: `${id}-query`, type: 'search', role: 'combobox', value: query, autoFocus: true,
              onKeyDown: navigate, autoComplete: 'off', placeholder: '搜索项目名称或目录路径…', 'aria-autocomplete': 'list',
              'aria-expanded': true, 'aria-controls': listId,
              'aria-activedescendant': !loading && !error && filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined,
              onChange: event => { setQuery(event.target.value); setActiveIndex(-1); } })),
          h('div', { className: 'feishu-project-summary' },
            h('span', { role: 'status' }, loading ? '正在读取 Harness 项目…' : error ? '项目列表读取失败' : `${filtered.length} 个${searchMode && query.trim() ? '匹配' : ''}项目`),
            h('button', { type: 'button', disabled: loading, onClick: () => { setActiveIndex(-1); setReload(reload + 1); } }, error ? '重试' : '刷新列表')),
          error && h('p', { role: 'alert', className: 'feishu-error' }, error),
          warning && h('p', { role: 'status', className: 'feishu-muted' }, warning),
          h('div', { id: listId, role: 'listbox', 'aria-label': 'Harness 项目目录', 'aria-busy': loading, className: 'feishu-project-results' },
            !loading && !error && filtered.map((project, index) => h('button', {
              key: project.path, id: `${listId}-${index}`, type: 'button', role: 'option', tabIndex: searchMode ? -1 : 0,
              onFocus: () => setActiveIndex(index), onKeyDown: searchMode ? undefined : navigate,
              disabled: unavailable(project), 'aria-selected': project.path === value,
              className: `feishu-project-option${activeIndex === index ? ' is-active' : ''}`,
              onMouseDown: event => event.preventDefault(), onClick: () => choose(project)
            }, h('span', { className: 'feishu-project-option-title' }, project.name,
              project.path === value ? h('span', null, '当前选择') : project.botId === botId && botId ? h('span', null, '此机器人已绑定') : null),
              h('span', { className: 'feishu-project-path' }, project.path),
              project.available === false ? h('small', null, '目录不存在或无法访问')
                : project.botId && project.botId !== botId ? h('small', null, `已由「${project.botName || '其他机器人'}」使用`)
                  : null))),
          !loading && !error && !filtered.length && h('p', { className: 'feishu-muted' }, projects.length ? '没有匹配的项目，请换个名称或路径关键词。' : '暂无项目。请先在 Harness 中添加项目，再刷新列表。')),
        h('small', null, '从 Harness 已添加的项目中选择；每个机器人独占一个目录，用户文件保存在其独立子目录中。选择后保存配置生效。'));
    }

    function FeishuSettings() {
      const prefix = useId();
      const [bots, setBots] = useState([]);
      const [selectedId, setSelectedId] = useState('');
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [draft, setDraft] = useState({ dirty: false, busy: false });
      const [adding, setAdding] = useState(false);
      const [newName, setNewName] = useState('');
      const [newPath, setNewPath] = useState('');
      const [rename, setRename] = useState('');
      const [reload, setReload] = useState(0);
      useEffect(() => {
        let active = true;
        setLoading(true);
        request('bots').then(data => {
          if (!active) return;
          setBots(data.bots);
          const id = data.bots.some(bot => bot.id === selectedId) ? selectedId : data.defaultBotId;
          setSelectedId(id);
          setRename(data.bots.find(bot => bot.id === id)?.name || '');
          setError('');
        }).catch(cause => { if (active) setError(cause.message); })
          .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
      }, [reload]);
      const selected = bots.find(bot => bot.id === selectedId);
      const blocked = busy || draft.busy;
      function discardDraft() {
        return !draft.dirty || window.confirm('当前机器人有未保存的配置，是否放弃这些修改？');
      }
      function selectBot(id) {
        if (blocked || id === selectedId || !discardDraft()) return;
        setSelectedId(id);
        setRename(bots.find(bot => bot.id === id)?.name || '');
        setDraft({ dirty: false, busy: false });
        setError('');
      }
      async function updateMeta(patch) {
        setBusy(true); setError('');
        try {
          const data = await request(`bots/${encodeURIComponent(selectedId)}/meta`, patch);
          setBots(previous => previous.map(bot => bot.id === selectedId ? { ...bot, ...data.bot } : bot));
          setRename(data.bot.name);
        } catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
      }
      return h('div', { className: 'feishu-settings' },
        h('h2', null, '飞书机器人'),
        h('p', { className: 'feishu-muted' }, '一个 Harness 可连接多个飞书机器人，每个机器人使用独立的项目目录、凭据、用户会话和历史数据库。'),
        loading ? h('p', { role: 'status' }, '正在读取机器人列表…') : h('section', null,
          h('div', { className: 'feishu-field' },
            h('label', { htmlFor: `${prefix}-bot` }, '当前机器人'),
            h('select', { id: `${prefix}-bot`, value: selectedId, disabled: blocked,
              onChange: event => selectBot(event.target.value) }, bots.map(bot => h('option', { key: bot.id, value: bot.id }, `${bot.name}${bot.id === 'default' ? '（共享隧道设置）' : ''}${bot.enabled ? '' : '（已停用）'}`)))),
          selected && h(React.Fragment, null,
            h('div', { className: 'feishu-field' },
              h('label', { htmlFor: `${prefix}-bot-name` }, '机器人名称'),
              h('input', { id: `${prefix}-bot-name`, value: rename, disabled: blocked, maxLength: 80,
                onChange: event => setRename(event.target.value) })),
            h('div', { className: 'feishu-actions' },
              h('button', { type: 'button', disabled: blocked || !rename.trim() || rename.trim() === selected.name,
                onClick: () => updateMeta({ name: rename.trim() }) }, '重命名'),
              h('button', { type: 'button', role: 'switch', 'aria-checked': selected.enabled,
                'aria-label': '启用当前机器人', disabled: blocked,
                onClick: () => updateMeta({ enabled: !selected.enabled }) }, selected.enabled ? '已启用 · 点击停用' : '已停用 · 点击启用')),
            !selected.enabled && h('p', { role: 'status', className: 'feishu-muted' }, '此机器人已停用，不接收消息或执行新任务；配置和历史数据继续保留。')),
          h('div', { className: 'feishu-actions' }, h('button', { type: 'button', disabled: blocked,
            onClick: () => { setAdding(!adding); setError(''); } }, adding ? '取消添加' : '添加机器人')),
          adding && h('form', { onSubmit: async event => {
            event.preventDefault();
            if (blocked || !newName.trim() || !newPath.trim() || !discardDraft()) return;
            setBusy(true); setError('');
            try {
              const data = await request('bots', { name: newName.trim(), workspacePath: newPath.trim() });
              setBots(previous => [...previous, data.bot]);
              setSelectedId(data.bot.id); setRename(data.bot.name);
              setDraft({ dirty: false, busy: false });
              setAdding(false); setNewName(''); setNewPath('');
            } catch (cause) { setError(cause.message); }
            finally { setBusy(false); }
          } },
            h('div', { className: 'feishu-field' },
              h('label', { htmlFor: `${prefix}-new-bot-name` }, '新机器人名称'),
              h('input', { id: `${prefix}-new-bot-name`, value: newName, required: true, maxLength: 80, disabled: blocked,
                onChange: event => setNewName(event.target.value) })),
            h(ProjectPicker, { id: `${prefix}-new-bot-path`, label: '新机器人项目目录', value: newPath, onChange: setNewPath, disabled: blocked }),
            h('button', { type: 'submit', disabled: blocked || !newName.trim() || !newPath.trim(), className: 'feishu-primary' }, busy ? '添加中…' : '创建机器人'))),
        error && h('div', { role: 'alert', className: 'feishu-error' }, error,
          !bots.length && h('button', { type: 'button', onClick: () => setReload(reload + 1) }, '重新加载机器人列表')),
        !loading && selected && h(BotSettings, { key: selected.id, botId: selected.id, onDraftState: setDraft }));
    }

    function BotSettings({ botId, onDraftState }) {
      const botRequest = (path, body) => request(`bots/${encodeURIComponent(botId)}/${path}`, body);
      const tunnelRequest = (path, body) => request(`bots/default/${path}`, body);
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
      const [savedConfig, setSavedConfig] = useState(defaults);
      const [reload, setReload] = useState(0);
      const [connected, setConnected] = useState(false);
      const [setupReport, setSetupReport] = useState(null);
      const [setupPhase, setSetupPhase] = useState('');
      const [secretFlags, setSecretFlags] = useState({});
      const [sharedTunnel, setSharedTunnel] = useState(botId !== 'default');
      const dirty = Object.keys(defaults).some(key => config[key] !== savedConfig[key]);
      useEffect(() => { onDraftState({ dirty, busy: Boolean(busy) }); }, [dirty, busy]);

      function applyConfig(data) {
        const value = data.config || data;
        setSharedTunnel(data.sharedTunnel ?? value.sharedTunnel ?? botId !== 'default');
        const safe = { ...defaults, ...value };
        secrets.forEach(key => { safe[key] = ''; });
        setConfig(safe);
        setSavedConfig(safe);
        setSavedMode(safe.connectionMode);
        setSavedProvider(safe.tunnelProvider);
        setSecretFlags(data.configured || data.secrets || value.configured || {});
      }

      useEffect(() => {
        let active = true;
        setLoading(true);
        setLoadError('');
        botRequest('config').then(data => {
          if (active) applyConfig(data);
        }).catch(error => { if (active) setLoadError(error.message); })
          .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
      }, [reload]);

      async function refreshStatus(isActive = () => true) {
        const results = await Promise.allSettled([botRequest('webhook-url'), tunnelRequest('tunnel/status'), botRequest('connection/status')]);
        if (!isActive()) return;
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
        let timer;
        async function poll() {
          await refreshStatus(() => active);
          // Schedule after completion so a slow request cannot overlap the next poll.
          if (active) timer = setTimeout(poll, 5000);
        }
        poll();
        return () => { active = false; clearTimeout(timer); };
      }, [reload]);

      function payload() {
        // Omit empty secret fields: the server retains previously saved credentials.
        return Object.fromEntries(Object.keys(defaults)
          .filter(key => (!sharedTunnel || key === 'connectionMode' || !tunnelFields.includes(key)) && (!secrets.includes(key) || config[key]))
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
        setSetupReport(null);
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
            : h('input', { ...shared, readOnly: key === 'appId' && Boolean(secretFlags.appId), type: options.numeric ? 'number' : secrets.includes(key) ? 'password' : 'text',
              ...(options.numeric ? { min: 0, max: 23, step: 1 } : {}),
              autoComplete: secrets.includes(key) ? 'new-password' : 'off',
              placeholder: options.placeholder || (secrets.includes(key) ? '留空保留已保存的值' : '') }),
          options.hint && h('small', null, options.hint),
          secretFlags[key] && h('small', null, key === 'appId' ? '已绑定此应用；切换应用请新增机器人。' : '已保存凭证；填写新值可替换。'));
      }
      async function configureSetup() {
        setSetupReport(null);
        try {
          setSetupPhase('正在验证应用凭据…');
          // Validate before binding App ID permanently. Failed authentication
          // leaves the draft intact and never starts a tunnel.
          await botRequest('test', payload());
          setSetupPhase('正在保存配置…');
          await botRequest('config', payload());
          applyConfig(await botRequest('config'));
          setSetupPhase('正在检查配置，并尝试启动所选隧道…');
          setSetupReport(await botRequest('setup/repair', {}));
          await refreshStatus();
        } finally { setSetupPhase(''); }
      }
      async function recheckSetup() {
        setSetupReport(null);
        setSetupPhase('正在重新检查已保存的配置…');
        try {
          setSetupReport(await botRequest('setup/check', {}));
          await refreshStatus();
        } finally { setSetupPhase(''); }
      }
      function safeSetupLink(value) {
        // Reports are text, never HTML. Do not render arbitrary schemes or
        // destinations if a future backend error supplies an unexpected URL.
        return typeof value === 'string' && /^https:\/\/(?:open\.feishu\.cn|github\.com)\//.test(value) ? value : undefined;
      }
      function button(label, onClick, action, primary = false) {
        return h('button', { type: 'button', disabled: Boolean(busy), onClick,
          className: primary ? 'feishu-primary' : '' }, busy === action ? '处理中…' : label);
      }
      const tunnelDirty = tunnelFields.some(key => config[key] !== savedConfig[key]);
      const managedProvider = ['ngrok', 'cloudflare'].includes(config.tunnelProvider);
      const modeName = mode => mode === 'websocket' ? '长连接' : '开发者服务器（Webhook）';
      const providerNames = { ngrok: 'ngrok', cloudflare: 'Cloudflare Tunnel', custom: '自定义公网地址' };
      const stateNames = {
        disabled: '未启用', starting: '正在启动', connecting: '正在连接', connected: '已连接',
        reconnecting: '正在重连', stopped: '已停止', error: '连接异常',
        waiting_configuration: '等待配置', listening: '等待事件', ready: '已就绪', disconnected: '已断开'
      };

      const tunnelStateNames = {
        idle: '未启动托管隧道', stopped: '已停止', starting: '进程启动中，等待隧道就绪', running: '隧道已连接',
        backoff: '隧道中断，等待自动重试', error: '启动或连接异常', external: '检测到外部隧道（插件未托管）',
        not_required: '长连接无需隧道', unsupported: '此接入方式不支持进程管理',
        detected: '已检测到外部隧道', configured: '地址已配置，连接未验证', unconfigured: '地址未配置'
      };

      return h('div', { className: 'feishu-settings' },

        loading ? h('p', { role: 'status' }, '正在读取配置…') : loadError
          ? h('div', { role: 'alert' }, h('p', null, loadError), button('重新加载', () => setReload(reload + 1), 'reload'))
          : h(React.Fragment, null,
            h('section', { className: 'feishu-setup', 'aria-labelledby': `${prefix}-setup-title` },
              h('h3', { id: `${prefix}-setup-title` }, '快速配置'),
              h('p', null, '先填写应用凭证、选择项目与接收方式，再一键保存、检查并尝试启动已配置的隧道。已有配置可直接重新检查。'),
              h('ol', { className: 'feishu-setup-steps' },
                h('li', null, h('a', { href: `#${prefix}-app-section` }, '填写飞书应用凭证'), '，应用需由管理员在飞书后台创建。'),
                h('li', null, h('a', { href: `#${prefix}-connection-section` }, '选择接收方式'), '和', h('a', { href: `#${prefix}-project-section` }, '项目目录'), '；Webhook 还需配置公网入口，长连接无需隧道。'),
                h('li', null, '执行配置后，按下方检查结果完成飞书后台待办，并实际发送消息验收。')),
              h('div', { className: 'feishu-actions' },
                button('保存并一键配置', () => run('setup', configureSetup), 'setup', true),
                h('button', { type: 'button', disabled: Boolean(busy) || dirty, onClick: () => run('setup-check', recheckSetup) }, busy === 'setup-check' ? '检查中…' : '重新检查')),
              dirty && h('p', { className: 'feishu-muted' }, '有未保存的修改，请点击「保存并一键配置」后再复检。'),
              setupPhase && h('p', { role: 'status', 'aria-live': 'polite' }, setupPhase),
              h('p', { className: 'feishu-muted' }, '自动步骤不会代替你开通飞书权限、发布应用或验证真实消息；不会发送测试消息、邮件或付费模型请求。'),
              setupReport && h('div', { className: 'feishu-setup-report', 'aria-live': 'polite' },
                h('p', { role: 'status' }, `检查完成：${setupReport.checks.filter(item => item.state === 'ok').length} 项通过，${setupReport.checks.filter(item => item.state !== 'ok').length} 项需要处理或确认。实际收发仍需验收。`),
                setupReport.callbackUrl && h('div', { className: 'feishu-field' },
                  h('label', { htmlFor: `${prefix}-setup-callback` }, '当前机器人的飞书回调地址'),
                  h('div', { className: 'feishu-actions' },
                    h('input', { id: `${prefix}-setup-callback`, readOnly: true, value: setupReport.callbackUrl }),
                    button('复制回调地址', () => run('setup-copy', async () => { await navigator.clipboard.writeText(setupReport.callbackUrl); setNotice({ text: '回调地址已复制，请在飞书后台保存并验证。' }); }), 'setup-copy'))),
                h('ul', { className: 'feishu-setup-checks' }, setupReport.checks.map(item => h('li', { key: item.id, 'data-check-state': item.state },
                  h('div', { className: 'feishu-setup-check-heading' }, h('strong', null, item.title), h('span', null, ({ ok: '已通过', action: '待处理', warning: '待确认', error: '检查失败' })[item.state] || '待确认')),
                  h('p', null, item.message),
                  safeSetupLink(item.action?.url) && h('a', { href: safeSetupLink(item.action.url), target: '_blank', rel: 'noopener noreferrer' }, item.action.label))))),
              notice && h('p', { role: notice.error ? 'alert' : 'status', className: notice.error ? 'feishu-error' : 'feishu-success' }, notice.text)),
            h('form', { onSubmit: event => {
              event.preventDefault();
              run('save', async () => {
                setSetupReport(null);
                await botRequest('config', payload());
                applyConfig(await botRequest('config'));
                await refreshStatus();
                setNotice({ text: '配置已保存。' });
              });
            } },
              h('section', { id: `${prefix}-connection-section` },
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
              h('section', { id: `${prefix}-app-section` },
                h('h3', null, '应用凭证'),
                field('appId', 'App ID', { placeholder: 'cli_xxxxxxxxxxxxxxxx', hint: '在飞书开放平台的「凭证与基础信息」中获取。' }),
                field('appSecret', 'App Secret'),
                config.connectionMode === 'webhook' && field('verificationToken', 'Verification Token', { hint: '接收消息前请配置事件订阅中的 Token，或启用下方的加密签名验证。' }),
                config.connectionMode === 'webhook' && field('encryptKey', 'Encrypt Key（启用事件加密时填写）'),
                h('div', { className: 'feishu-actions' },
                  button('测试连接', () => run('test', async () => {
                    setConnected(false);
                    await botRequest('test', payload());
                    setConnected(true);
                    setNotice({ text: '飞书凭证验证成功。修改后的配置仍需保存。' });
                  }), 'test'),
                  h('span', { className: 'feishu-muted' }, connected ? '凭证验证成功' : '尚未验证当前配置'))),
              h('section', { id: `${prefix}-project-section` },
                h('h3', null, '任务处理'),
                h('p', { className: 'feishu-muted' }, '处理任务时会给原消息添加 Typing（敲键盘）表情，结束后移除。需要应用权限 im:message.reactions:write_only；请在飞书开放平台开通并发布生效。缺少权限时仍会处理消息，但无法显示状态表情。'),
                h(ProjectPicker, { id: `${prefix}-workspacePath`, label: '项目目录（用户工作目录根路径）', value: config.workspacePath, botId, disabled: Boolean(busy), onChange: value => edit('workspacePath', value) }),
                field('agentPreset', 'Agent 预设', { hint: '填写当前 Harness 已安装的预设名称，例如 standard。' }),
                field('permissionPreset', '权限预设', { choices: [
                  ['read-only', '只读'], ['workspace-write', '工作区写入']
                ] }),
                h('p', { className: 'feishu-muted' }, '飞书会话仅使用本用户的历史记录工具和受限工作区文件工具，不提供任意主机 Shell 或通用文件访问。只读模式禁止修改工作区文件。')),
              h('section', null,
                h('h3', null, '用户身份与会话'),
                h('p', { className: 'feishu-muted' }, '请在飞书后台设置应用可用范围，控制谁能使用机器人；插件无需预填 open_id 或用户名。'),
                h('p', { className: 'feishu-muted' }, '首次对话会先确认用户姓名；完成确认前只提示确认姓名，不处理其他问题。确认后的姓名用于会话标题和个人历史资料。'),
                h('p', { className: 'feishu-muted' }, '用户身份由飞书消息自动识别，每位用户的工作目录和历史数据库仍独立隔离；姓名相同也不会合并数据。新用户使用上方工作区权限预设，旧配置中的个人权限设置继续保留。'),
                h('p', { className: 'feishu-muted' }, '同一用户在同一聊天中默认延续当前会话，发送 /new 新开会话；不同用户、不同群聊的上下文分开，历史数据库仅供所属用户查询和管理。'),
                field('dailyResetHour', '每日上下文切换时间（小时）', { numeric: true, hint: '默认凌晨 4 点。正在执行的任务完成后再切换，历史记录继续保留。' }),
                field('dailyResetTimezone', '每日上下文切换时区', { placeholder: 'Asia/Macau', hint: '使用 IANA 时区名称，例如 Asia/Macau。/new 和每日切换只重置当前上下文，不删除历史；提及旧内容时可从个人历史数据库查找。' })),
              h('section', null,
                h('h3', null, '个人邮箱（SMTP）'),
                h('p', { className: 'feishu-muted' }, '每位飞书用户独立绑定自己的邮箱。首次要求发邮件时，输入邮箱后由智能体自动查找发信配置，再询问授权码并继续当前发送任务；无需填写服务器、端口或加密方式，普通聊天无需配置。'),
                h('p', null, '在机器人私聊中发送 ', h('code', null, '/mail'), ' 也可单独配置邮箱。已明确的收件人无需重复填写，缺少时再补问；仅配置邮箱不会自动发信。'),
                h('p', { className: 'feishu-muted' }, h('code', null, '/mail status'), ' 查看状态；', h('code', null, '/mail retry'), ' 重新查找发信配置；', h('code', null, '/mail to 收件邮箱'), ' 更换收件人；', h('code', null, '/mail reset'), ' 清除自己的邮箱绑定。'),
                h('p', { className: 'feishu-muted' }, '未知域名先查询公开配置，未找到时由智能体搜索服务商官网，核实资料并验证连接后使用。网页搜索需要 Harness 已配置可用的搜索服务；搜索不可用、暂无可靠资料或网络不通时保留发送任务并支持重试，不能保证所有邮箱都能识别。高级用户仍可手动覆盖。邮箱服务须支持授权码认证，不支持 OAuth 登录或收件箱读取。授权码在进入模型和普通历史前由插件截取；飞书聊天记录本身不由插件清除。')),
              (config.connectionMode === 'webhook' || (!sharedTunnel && config.serverTunnelRequired)) && h('section', null,
                h('h3', null, config.connectionMode === 'webhook' ? 'Webhook 与公网地址' : '服务器共享公网隧道'),
                h('label', { htmlFor: `${prefix}-harness-port` }, '当前 Harness 监听端口'),
                h('input', { id: `${prefix}-harness-port`, readOnly: true, value: config.harnessPort || '', placeholder: '等待获取实际端口' }),
                h('p', { className: 'feishu-muted' }, '端口由 Harness 管理，插件自动读取。需要更换时，停止原实例，再用 dsh web --port 新端口 启动；插件启动隧道时自动使用当前端口。保存插件配置不会更改监听端口。'),
                sharedTunnel && h('p', { className: 'feishu-muted' }, '此机器人共享默认机器人的公网隧道。请切换到默认机器人管理隧道；每个机器人的 Webhook 地址不同，请分别填写到对应飞书应用。'),
                sharedTunnel && h('p', { className: 'feishu-muted' }, '如果 ngrok、Cloudflare 或反向代理策略只放行了默认回调，还需放行此机器人的 POST 回调路径；管理页面继续保留原有访问保护。'),
                !sharedTunnel && h(React.Fragment, null,
                field('tunnelProvider', '公网接入方式', { choices: [
                  ['ngrok', 'ngrok'], ['cloudflare', 'Cloudflare Tunnel'], ['custom', '自定义公网地址 / 反向代理']
                ], hint: '选择后保存生效。ngrok 和 Cloudflare 支持一键启动与自动重启；自定义接入由你自行维护。' }),
                config.tunnelProvider !== savedProvider && h('p', { role: 'status', className: 'feishu-muted' },
                  `公网接入方式尚未保存；已保存的方式为 ${providerNames[savedProvider]}。原公网地址会保留，请更新为所选服务提供的地址后保存。`),
                field('publicBaseUrl', config.tunnelProvider === 'ngrok' || (config.tunnelProvider === 'cloudflare' && config.cloudflareMode === 'quick') ? '公网服务地址（可选）' : '公网服务地址', {
                  placeholder: config.tunnelProvider === 'cloudflare' ? 'https://your-tunnel.trycloudflare.com' : 'https://your-host.example',
                  hint: config.tunnelProvider === 'ngrok' ? '填写 HTTPS 根地址；留空时检测指向当前 Harness 端口的 ngrok 隧道。' : config.tunnelProvider === 'cloudflare' && config.cloudflareMode === 'quick' ? '临时隧道启动后自动使用检测到的最新地址；这里可以留空。' : '填写隧道或反向代理提供的 HTTPS 根地址，不包含 /webhook/feishu；保存后生成完整回调地址。'
                }),
                config.tunnelProvider === 'ngrok' && h(React.Fragment, null,
                  field('ngrokDomain', 'ngrok 固定域名（可选）', { placeholder: 'your-domain.ngrok.app', hint: '留空时使用 ngrok 分配的地址；指定固定域名时应与公网服务地址一致。' }),
                  field('ngrokAuthtoken', 'ngrok Authtoken（可选）', { hint: '留空使用已保存凭证或系统中的 ngrok 配置；输入值不会回显。' }),
                  field('ngrokTrafficPolicyFile', 'ngrok Traffic Policy 文件（可选）', { hint: '留空时检测 ~/.config/ngrok/policy.yaml；只使用现有文件，不修改策略内容。' }),
                  field('ngrokExecutablePath', 'ngrok 程序路径（可选）', { placeholder: '/usr/local/bin/ngrok 或 C:\\tools\\ngrok.exe', hint: '留空从 PATH 查找 ngrok。填写程序本身的路径，不要填写命令或额外参数。' })),
                config.tunnelProvider === 'cloudflare' && h(React.Fragment, null,
                  field('cloudflareMode', 'Cloudflare 隧道类型', { choices: [
                    ['quick', '临时隧道（Quick Tunnel）'], ['named', '固定域名（本地命名隧道）']
                  ] }),
                  field('cloudflareExecutablePath', 'cloudflared 程序路径（可选）', { placeholder: '/usr/local/bin/cloudflared 或 C:\\tools\\cloudflared.exe', hint: '留空从 PATH 查找 cloudflared。' }),
                  config.cloudflareMode === 'named' && h(React.Fragment, null,
                    field('cloudflareTunnelName', '命名隧道名称或 UUID', { hint: '填写已创建的本地命名隧道名称或 UUID。' }),
                    field('cloudflareConfigFile', 'Cloudflare 配置文件路径', { hint: '必填本地 YAML 文件，包含 credentials-file 和与公网域名对应的 ingress；插件在临时副本中使用当前 Harness 端口，不改源文件。' })),
                  config.cloudflareMode === 'quick' && h('div', { className: 'feishu-muted' },
                    h('p', null, '临时隧道自动获取 HTTPS 地址，无需预填公网服务地址。每次重启可能更换地址；请复制下方最新地址，手动更新飞书事件与回调配置。插件不会修改飞书后台。'),
                    h('p', null, '也可手动启动：'),
                    h('code', null, Number.isInteger(config.harnessPort) && config.harnessPort > 0
                      ? `cloudflared tunnel --url http://127.0.0.1:${config.harnessPort}` : '请先刷新页面以获取当前 Harness 端口'))),
                managedProvider && h('div', { className: 'feishu-field' },
                  h('div', { className: 'feishu-actions' },
                    h('button', { type: 'button', id: `${prefix}-tunnelAutoRestart`, role: 'switch',
                      'aria-checked': Boolean(config.tunnelAutoRestart), 'aria-labelledby': `${prefix}-tunnelAutoRestart-label`,
                      'aria-describedby': `${prefix}-tunnelAutoRestart-hint`, className: 'feishu-switch', disabled: Boolean(busy),
                      onClick: () => edit('tunnelAutoRestart', !config.tunnelAutoRestart) }, h('span', { 'aria-hidden': true })),
                    h('label', { id: `${prefix}-tunnelAutoRestart-label`, htmlFor: `${prefix}-tunnelAutoRestart` }, '隧道守护：异常退出后自动拉起')),
                  h('small', { id: `${prefix}-tunnelAutoRestart-hint` }, '保存后生效：开启时缺少隧道会自动启动，异常退出后自动重试；关闭仅停止自动重试，不停止已运行进程。守护随 Harness 运行，Harness 退出后不会继续守护。'),
                  h('small', null, `已保存的守护设置：${savedConfig.tunnelAutoRestart ? '开启' : '关闭'}。${config.tunnelAutoRestart !== savedConfig.tunnelAutoRestart ? '开关修改尚未保存。' : ''}`),
                  h('small', null, 'Linux、Windows、macOS 均需先安装对应的 ngrok 或 cloudflared；支持 PATH 和自定义程序路径，Windows 可使用 .exe，无需 Bash。')),
                ),
                config.connectionMode === 'webhook' && h(React.Fragment, null,
                h('label', { htmlFor: `${prefix}-webhook` }, '已保存配置的 Webhook 地址'),
                h('div', { className: 'feishu-actions' },
                  h('input', { id: `${prefix}-webhook`, readOnly: true, value: webhook, placeholder: '配置公网地址后显示' }),
                  h('button', { type: 'button', disabled: !webhook || Boolean(busy), onClick: () => run('copy', async () => {
                    await navigator.clipboard.writeText(webhook);
                    setNotice({ text: 'Webhook 地址已复制。' });
                  }) }, '复制')),
                h('p', { className: 'feishu-muted' }, '在飞书应用的「事件订阅」中填写公网可访问的请求地址，并添加 im.message.receive_v1 事件。'),
                ),
                h('p', { role: 'status' }, tunnel
                  ? `已保存配置的公网状态（${providerNames[tunnel.provider] || tunnel.provider}）：${tunnelStateNames[tunnel.state] || tunnel.state || '状态未知'}`
                  : '尚未取得公网接入状态'),
                tunnel?.message && h('p', { className: 'feishu-muted' }, tunnel.message),
                statusError && h('p', { role: 'alert', className: 'feishu-error' }, statusError),
                !sharedTunnel && config.tunnelProvider === 'ngrok' && h('div', { className: 'feishu-muted' },
                  h('p', null, '也可在本机手动启动 ngrok；插件会检测指向当前 Harness 端口的已有隧道。手动命令示例（按需保留 --traffic-policy-file）：'),
                  h('code', null, Number.isInteger(config.harnessPort) && config.harnessPort > 0
                    ? `ngrok http ${config.harnessPort} --url https://YOUR-NGROK-DOMAIN` : '请先刷新页面以获取当前 Harness 端口'),
                  h('p', null, '飞书 POST 回调不能完成浏览器登录。入口策略需要允许它到达 /webhook/feishu，由插件校验飞书凭据；管理页面保留访问保护。')),
                !sharedTunnel && tunnel?.paused && h('p', { role: 'status', className: 'feishu-muted' }, '守护已暂停；点击启动，或关闭守护并保存后重新开启并保存，即可恢复。'),
                !sharedTunnel && tunnel?.managed && h('p', { className: 'feishu-muted' }, `插件托管进程 · 自动重试次数：${tunnel.restartCount || 0}${tunnel.nextRetryAt ? ` · 下次重试：${new Date(tunnel.nextRetryAt).toLocaleTimeString()}` : ''}`),
                !sharedTunnel && tunnelDirty && managedProvider && h('p', { role: 'status', className: 'feishu-muted' }, '隧道相关配置尚未保存，请先保存，再启动隧道。启动按钮仅使用已保存的配置。'),
                h('div', { className: 'feishu-actions' },
                  !sharedTunnel && managedProvider && h('button', { type: 'button', disabled: Boolean(busy) || loading || tunnelDirty || (savedMode !== 'webhook' && !savedConfig.serverTunnelRequired) || tunnel?.state === 'starting' || Boolean(tunnel?.managed && tunnel?.running),
                    onClick: () => run('tunnel-start', async () => {
                      await tunnelRequest('tunnel/start', {});
                      await refreshStatus();
                      setNotice({ text: '已请求启动隧道，请查看运行状态与 Webhook 地址。' });
                    }) }, busy === 'tunnel-start' ? '启动中…' : '启动当前端口的隧道'),
                  !sharedTunnel && tunnel?.managed && h('button', { type: 'button', disabled: Boolean(busy),
                    onClick: () => run('tunnel-stop', async () => {
                      await tunnelRequest('tunnel/stop', {});
                      await refreshStatus();
                      setNotice({ text: '已停止插件托管的隧道并暂停自动重试；点击启动或重新开启守护可恢复。' });
                    }) }, busy === 'tunnel-stop' ? '停止中…' : '停止托管隧道'),
                  button('刷新状态', () => run('status', refreshStatus), 'status'))),
              h('div', { className: 'feishu-actions' },
                h('button', { type: 'submit', disabled: Boolean(busy), className: 'feishu-primary' }, busy === 'save' ? '保存中…' : '保存配置'))),
            h('p', { className: 'feishu-muted' }, '每日上下文切换由插件管理，其他通用定时任务尚未接入执行器。'),
            h('a', { href: 'https://open.feishu.cn/app', target: '_blank', rel: 'noopener noreferrer' }, '打开飞书开放平台')));
    }

    const css = `
      [data-feishu-settings="true"]{grid-column:1/-1}
      .feishu-inventory-settings{border-top:1px solid var(--dsw-alias-border-l2,#ddd);margin-top:16px;padding-top:16px}
      .feishu-settings{max-width:760px;padding:8px 4px 24px;color:var(--dsw-alias-label-primary,#202124);font-size:14px;line-height:1.6}
      .feishu-settings *{box-sizing:border-box}.feishu-settings h2{margin:0 0 4px;font-size:21px}.feishu-settings h3{margin:0 0 16px;font-size:16px}
      .feishu-settings section{border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;padding:18px;margin:20px 0}
      .feishu-setup{background:var(--dsw-alias-bg-layer-2,#f6f8fc)}.feishu-setup-steps{padding-left:22px}.feishu-setup-steps li{margin:8px 0}
      .feishu-setup-checks{list-style:none;padding:0 4px 0 0;margin:12px 0;max-height:420px;overflow:auto;overscroll-behavior:contain}.feishu-setup-checks>li{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,#ddd)}.feishu-setup-checks p{margin:5px 0;overflow-wrap:anywhere}
      .feishu-setup-check-heading{display:flex;gap:12px;justify-content:space-between}.feishu-setup-check-heading span{flex-shrink:0;color:var(--dsw-alias-label-secondary,#686a70)}.feishu-setup-checks [data-check-state=ok] .feishu-setup-check-heading span{color:#258047}.feishu-setup-checks [data-check-state=error] .feishu-setup-check-heading span{color:var(--dsw-alias-label-error,#ba3030)}
      .feishu-field{display:flex;flex-direction:column;gap:6px;margin:14px 0}.feishu-settings label{font-weight:500}
      .feishu-settings input,.feishu-settings select,.feishu-settings textarea{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;padding:9px 11px;font:inherit}
      .feishu-settings textarea{resize:vertical}
      .feishu-settings .feishu-switch{width:46px;height:26px;padding:3px;border-radius:20px;display:inline-flex;align-items:center;flex-shrink:0;background:var(--dsw-alias-bg-layer-3,#ddd)}
      .feishu-switch span{width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-secondary,#686a70);transition:transform .15s}
      .feishu-settings .feishu-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4d6bfe)}.feishu-switch[aria-checked="true"] span{transform:translateX(20px);background:white}
      .feishu-settings button{border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:8px;padding:8px 14px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
      .feishu-settings button:disabled{opacity:.55;cursor:default}.feishu-settings .feishu-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:white}
      .feishu-settings :is(input,select,textarea,button,a):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
      .feishu-project-control{display:flex;align-items:stretch;width:100%;border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff)}
      .feishu-settings .feishu-project-trigger{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:1;min-width:0;border:0;border-radius:8px 0 0 8px;text-align:left;white-space:normal}
      .feishu-project-value{min-width:0;overflow-wrap:anywhere}
      .feishu-settings .feishu-project-search{display:flex;align-items:center;justify-content:center;flex:0 0 44px;padding:8px;border:0;border-left:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:0 8px 8px 0;color:var(--dsw-alias-brand-primary,#4d6bfe)}
      .feishu-project-search[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2,#f2f4f8)}
      .feishu-project-panel{border:1px solid var(--dsw-alias-border-l4,#ccc);border-radius:10px;padding:10px;background:var(--dsw-alias-bg-layer-3,#fff)}
      .feishu-project-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0;color:var(--dsw-alias-label-secondary,#686a70);font-size:12px}
      .feishu-settings .feishu-project-summary button{font-size:12px;padding:4px 8px}
      .feishu-project-results{max-height:260px;overflow:auto;overscroll-behavior:contain}
      .feishu-settings .feishu-project-option{display:flex;flex-direction:column;gap:3px;width:100%;border:1px solid transparent;border-radius:6px;padding:9px 10px;text-align:left;white-space:normal;overflow-wrap:anywhere}
      .feishu-project-option-title{display:flex;justify-content:space-between;gap:10px;width:100%;font-weight:500}.feishu-project-option-title>span{font-size:12px;font-weight:400;flex-shrink:0}
      .feishu-project-path{font-size:12px;color:var(--dsw-alias-label-secondary,#686a70)}
      .feishu-settings .feishu-project-option:is(.is-active,[aria-selected="true"]){border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
      .feishu-settings .feishu-project-option:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2,#f2f4f8)}
      .feishu-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
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
