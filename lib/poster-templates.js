// 海报模板库：固定 1080×1500 画布，槽位插值。
// 所有槽位文本统一 HTML 转义后注入；模板只用系统字体栈（渲染环境无网络）。

const FONT = `'Noto Sans CJK SC','Source Han Sans SC','PingFang SC','Microsoft YaHei','WenQuanYi Micro Hei',system-ui,sans-serif`;
const SERIF = `'Noto Serif CJK SC','Source Han Serif SC','SimSun',serif`;

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const section = (s, style = {}) => `
  <div style="margin-top:${style.gap ?? 44}px">
    <div style="font-size:30px;font-weight:700;color:${style.headingColor};display:flex;align-items:center;gap:14px">
      <span style="display:inline-block;width:8px;height:30px;background:${style.bar};border-radius:4px"></span>${escapeHtml(s.heading)}
    </div>
    <div style="font-size:24px;line-height:1.75;color:${style.bodyColor};margin-top:16px;white-space:pre-wrap">${escapeHtml(s.body)}</div>
  </div>`;

const page = (css, body) => `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1500px;font-family:${FONT};overflow:hidden}${css}</style>
</head><body>${body}</body></html>`;

const TEMPLATES = {
  'business-navy': {
    name: '深蓝商务简报',
    render(slots) {
      const sections = (slots.sections || []).slice(0, 4).map(s => section(s, {
        bar: '#E3B34C', headingColor: '#F5F0E4', bodyColor: 'rgba(230,236,245,.88)',
      })).join('');
      return page(`
        .bg{background:linear-gradient(160deg,#0E2240 0%,#12294D 55%,#0B1B33 100%);height:100%;padding:88px 84px;color:#fff;position:relative}
        .bg:before{content:'';position:absolute;left:0;top:0;right:0;height:10px;background:linear-gradient(90deg,#E3B34C,#C78A2E 60%,transparent)}
        .bg:after{content:'';position:absolute;right:-160px;bottom:-160px;width:480px;height:480px;border-radius:50%;background:radial-gradient(circle,rgba(227,179,76,.14),transparent 70%)}`, `
        <div class="bg">
          <div style="letter-spacing:6px;font-size:22px;color:#E3B34C;font-weight:600">${escapeHtml(slots.kicker || '内部资料 · 注意保存')}</div>
          <div style="font-size:64px;font-weight:800;line-height:1.3;margin-top:36px;letter-spacing:1px">${escapeHtml(slots.title)}</div>
          ${slots.subtitle ? `<div style="font-size:28px;color:rgba(214,224,238,.75);margin-top:24px;line-height:1.6">${escapeHtml(slots.subtitle)}</div>` : ''}
          ${slots.highlight ? `<div style="margin-top:52px;padding:30px 36px;background:rgba(227,179,76,.12);border-left:6px solid #E3B34C;border-radius:0 16px 16px 0;font-size:32px;font-weight:700;color:#F3D489;line-height:1.5">${escapeHtml(slots.highlight)}</div>` : ''}
          ${sections}
          <div style="position:absolute;left:84px;right:84px;bottom:64px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,.14);padding-top:26px;font-size:20px;color:rgba(214,224,238,.5)">
            <span>${escapeHtml(slots.footer || '')}</span><span style="color:#E3B34C;font-weight:600">${escapeHtml(slots.brand || '')}</span>
          </div>
        </div>`);
    },
  },

  'stage-gold': {
    name: '发布会金句海报',
    render(slots) {
      return page(`
        .bg{background:radial-gradient(1200px 700px at 50% -10%,#2A2416 0%,#141210 55%,#0C0B09 100%);height:100%;padding:110px 90px;color:#F5EDDC;position:relative;text-align:center}
        .bg:before,.bg:after{content:'';position:absolute;top:110px;bottom:110px;width:1px;background:linear-gradient(180deg,transparent,rgba(227,179,76,.5),transparent)}
        .bg:before{left:56px}.bg:after{right:56px}`, `
        <div class="bg">
          <div style="display:inline-block;padding:10px 34px;border:1px solid rgba(227,179,76,.55);border-radius:999px;font-size:22px;letter-spacing:8px;color:#E3B34C">${escapeHtml(slots.kicker || '主题发布')}</div>
          <div style="font-size:72px;font-weight:800;line-height:1.35;margin-top:90px;font-family:${SERIF}">${escapeHtml(slots.title)}</div>
          ${slots.subtitle ? `<div style="font-size:30px;color:rgba(245,237,220,.72);margin-top:44px;line-height:1.7">${escapeHtml(slots.subtitle)}</div>` : ''}
          ${slots.highlight ? `<div style="margin-top:80px;font-size:40px;font-weight:700;color:#F3D489;line-height:1.6;font-family:${SERIF}">「 ${escapeHtml(slots.highlight)} 」</div>` : ''}
          ${(slots.sections || []).slice(0, 3).map(s => `
            <div style="margin-top:56px;font-size:26px;line-height:1.8;color:rgba(245,237,220,.85)">
              <span style="color:#E3B34C;font-weight:700">${escapeHtml(s.heading)}</span>　${escapeHtml(s.body)}
            </div>`).join('')}
          <div style="position:absolute;left:90px;right:90px;bottom:70px;font-size:20px;letter-spacing:4px;color:rgba(227,179,76,.6);display:flex;justify-content:space-between">
            <span>${escapeHtml(slots.footer || '')}</span><span>${escapeHtml(slots.brand || '')}</span>
          </div>
        </div>`);
    },
  },

  'magazine-fresh': {
    name: '清新杂志风',
    render(slots) {
      const sections = (slots.sections || []).slice(0, 4).map(s => section(s, {
        bar: '#2F8F5B', headingColor: '#1E3A2A', bodyColor: 'rgba(40,55,48,.82)',
      })).join('');
      return page(`
        .bg{background:#FAF7F0;height:100%;padding:80px 78px;position:relative}
        .bg:before{content:'';position:absolute;right:-120px;top:-120px;width:380px;height:380px;border-radius:50%;background:#E4EFE6}
        .bg:after{content:'';position:absolute;left:-80px;bottom:180px;width:220px;height:220px;border-radius:50%;background:#F3E9D2}`, `
        <div class="bg">
          <div style="position:relative;z-index:1">
            <div style="display:flex;align-items:center;gap:18px">
              <span style="background:#2F8F5B;color:#fff;font-size:20px;letter-spacing:4px;padding:8px 22px;border-radius:6px">${escapeHtml(slots.kicker || '专题')}</span>
              <span style="font-size:20px;color:#8A927F;letter-spacing:2px">${escapeHtml(slots.brand || '')}</span>
            </div>
            <div style="font-size:58px;font-weight:800;line-height:1.32;color:#17301F;margin-top:40px">${escapeHtml(slots.title)}</div>
            ${slots.subtitle ? `<div style="font-size:26px;color:#6E7A6C;margin-top:20px;line-height:1.65">${escapeHtml(slots.subtitle)}</div>` : ''}
            ${slots.highlight ? `<div style="margin-top:44px;background:#fff;border-radius:18px;padding:28px 34px;box-shadow:0 8px 30px rgba(30,58,42,.08);font-size:30px;font-weight:700;color:#2F8F5B;line-height:1.55">${escapeHtml(slots.highlight)}</div>` : ''}
            ${sections}
            <div style="margin-top:56px;border-top:2px dashed #D8D2C2;padding-top:24px;font-size:19px;color:#9AA091;display:flex;justify-content:space-between">
              <span>${escapeHtml(slots.footer || '')}</span><span>${escapeHtml(slots.edition || '')}</span>
            </div>
          </div>
        </div>`);
    },
  },
};

export function listTemplates() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name }));
}

export function renderTemplate(id, slots) {
  const template = TEMPLATES[id];
  if (!template) throw new Error(`未知模板「${id}」，可选：${Object.keys(TEMPLATES).join('、')}`);
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) throw new Error('slots 必须是对象');
  if (!slots.title || typeof slots.title !== 'string') throw new Error('slots.title 必填（海报主标题）');
  for (const s of slots.sections || []) {
    if (!s || typeof s.heading !== 'string' || typeof s.body !== 'string') throw new Error('sections 的每一项都需要 heading 与 body 字符串');
  }
  return template.render(slots);
}
