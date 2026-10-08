import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderTemplate, escapeHtml } from '../lib/poster-templates.js';
import { executePosterTool } from '../lib/poster-tools.js';

const hasChromium = spawnSync(process.env.FEISHU_POSTER_CHROMIUM || 'chromium', ['--version'], { stdio: 'ignore' }).status === 0;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'poster-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { workspacePath: dir };
}

test('槽位文本统一 HTML 转义，模板不注入标记', () => {
  const html = renderTemplate('business-navy', { title: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
});

test('模板参数校验：未知模板、缺标题、坏 sections', () => {
  assert.throws(() => renderTemplate('nope', { title: 'x' }), /未知模板/);
  assert.throws(() => renderTemplate('business-navy', {}), /title 必填/);
  assert.throws(() => renderTemplate('business-navy', { title: 'x', sections: [{ heading: 'a' }] }), /heading 与 body/);
});

test('三套模板都能渲染出完整 HTML', () => {
  for (const id of ['business-navy', 'stage-gold', 'magazine-fresh']) {
    const html = renderTemplate(id, { title: '标题', sections: [{ heading: '节', body: '内容' }] });
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /标题/);
  }
});

test('执行参数校验：二选一、坏 JSON、路径逃逸', async t => {
  const binding = await fixture(t);
  await assert.rejects(() => executePosterTool('feishu_poster_render', {}, binding), /需要 template 或 htmlPath/);
  await assert.rejects(() => executePosterTool('feishu_poster_render', { template: 'business-navy', htmlPath: 'a.html' }, binding), /二选一/);
  await assert.rejects(() => executePosterTool('feishu_poster_render', { template: 'business-navy', slots: '{bad' }, binding), /合法 JSON/);
  await assert.rejects(() => executePosterTool('feishu_poster_render', { htmlPath: '../x.html' }, binding), /escapes/);
  await assert.rejects(() => executePosterTool('feishu_poster_render', { htmlPath: 'a.pdf' }, binding), /仅支持渲染 .html/);
});

test('模板渲染出 PNG 并写回工作区', { skip: !hasChromium && 'chromium 不可用' }, async t => {
  const binding = await fixture(t);
  const out = await executePosterTool('feishu_poster_render', {
    template: 'magazine-fresh',
    slots: JSON.stringify({ title: '测试标题', footer: '页脚', brand: '品牌' }),
    outputName: 'test-poster',
  }, binding);
  assert.equal(out.path, 'test-poster.png');
  const info = await stat(join(binding.workspacePath, out.path));
  assert.ok(info.size > 10000, `PNG 应有实质内容，实际 ${info.size} 字节`);
});

test('htmlPath 模式渲染工作区 HTML', { skip: !hasChromium && 'chromium 不可用' }, async t => {
  const binding = await fixture(t);
  await writeFile(join(binding.workspacePath, 'page.html'), '<!DOCTYPE html><html><body style="width:1080px;height:1500px;background:#123"></body></html>');
  const out = await executePosterTool('feishu_poster_render', { htmlPath: 'page.html' }, binding);
  assert.match(out.path, /^海报-.*\.png$/);
  assert.ok(out.bytes > 1000);
});
