import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeUserTool } from '../lib/user-tools.js';

// 最小合法 xlsx（两个工作表头 + 一行记录），提取逻辑依赖宿主 python3 标准库
const XLSX_B64 = 'UEsDBBQAAAAAABUbSV38PpA2kwIAAJMCAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCI/PjxUeXBlcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9jb250ZW50LXR5cGVzIj48RGVmYXVsdCBFeHRlbnNpb249InJlbHMiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtcGFja2FnZS5yZWxhdGlvbnNoaXBzK3htbCIvPjxEZWZhdWx0IEV4dGVuc2lvbj0ieG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24veG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvd29ya2Jvb2sueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwuc2hlZXQubWFpbit4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC93b3Jrc2hlZXRzL3NoZWV0MS54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC53b3Jrc2hlZXQreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvc2hhcmVkU3RyaW5ncy54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zaGFyZWRTdHJpbmdzK3htbCIvPjwvVHlwZXM+UEsDBBQAAAAAABUbSV1Lg6M6BQEAAAUBAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiPz48UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL29mZmljZURvY3VtZW50IiBUYXJnZXQ9InhsL3dvcmtib29rLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAFRtJXXYTHD/8AAAA/AAAAA8AAAB4bC93b3JrYm9vay54bWw8P3htbCB2ZXJzaW9uPSIxLjAiPz48d29ya2Jvb2sgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PHNoZWV0cz48c2hlZXQgbmFtZT0i5Lu75Yqh6KGoIiBzaGVldElkPSIxIiByOmlkPSJySWQxIi8+PC9zaGVldHM+PC93b3JrYm9vaz5QSwMEFAAAAAAAFRtJXW026XQGAQAABgEAABoAAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsczw/eG1sIHZlcnNpb249IjEuMCI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvd29ya3NoZWV0IiBUYXJnZXQ9IndvcmtzaGVldHMvc2hlZXQxLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAFRtJXX7QLa3AAAAAwAAAABQAAAB4bC9zaGFyZWRTdHJpbmdzLnhtbDw/eG1sIHZlcnNpb249IjEuMCI/Pjxzc3QgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiI+PHNpPjx0Puagh+mimDwvdD48L3NpPjxzaT48dD7nirbmgIE8L3Q+PC9zaT48c2k+PHQ+5YaZ5ZGo5oqlPC90Pjwvc2k+PHNpPjx0Pui/m+ihjOS4rTwvdD48L3NpPjwvc3N0PlBLAwQUAAAAAAAVG0ldQMKUZRcBAAAXAQAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbDw/eG1sIHZlcnNpb249IjEuMCI/Pjx3b3Jrc2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiI+PHNoZWV0RGF0YT48cm93IHI9IjEiPjxjIHI9IkExIiB0PSJzIj48dj4wPC92PjwvYz48YyByPSJCMSIgdD0icyI+PHY+MTwvdj48L2M+PC9yb3c+PHJvdyByPSIyIj48YyByPSJBMiIgdD0icyI+PHY+Mjwvdj48L2M+PGMgcj0iQjIiIHQ9InMiPjx2PjM8L3Y+PC9jPjwvcm93Pjwvc2hlZXREYXRhPjwvd29ya3NoZWV0PlBLAQIUAxQAAAAAABUbSV38PpA2kwIAAJMCAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAAAFRtJXUuDozoFAQAABQEAAAsAAAAAAAAAAAAAAIABxAIAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAAAFRtJXXYTHD/8AAAA/AAAAA8AAAAAAAAAAAAAAIAB8gMAAHhsL3dvcmtib29rLnhtbFBLAQIUAxQAAAAAABUbSV1tNul0BgEAAAYBAAAaAAAAAAAAAAAAAACAARsFAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUAxQAAAAAABUbSV1+0C2twAAAAMAAAAAUAAAAAAAAAAAAAACAAVkGAAB4bC9zaGFyZWRTdHJpbmdzLnhtbFBLAQIUAxQAAAAAABUbSV1AwpRlFwEAABcBAAAYAAAAAAAAAAAAAACAAUsHAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAYABgCHAQAAmAgAAAAA';

async function fixture(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'extract-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof content === 'string' ? content : Buffer.from(content));
  }
  return { workspacePath: dir };
}

test('xlsx 附件提取为工作表文本', async t => {
  const binding = await fixture(t, { '任务表.xlsx': Buffer.from(XLSX_B64, 'base64') });
  const out = await executeUserTool('feishu_workspace_extract_text', { path: '任务表.xlsx' }, binding, {});
  assert.match(out.text, /工作表「任务表」/);
  assert.match(out.text, /标题\t状态/);
  assert.match(out.text, /写周报\t进行中/);
  assert.equal(out.truncated, false);
});

test('CSV 附件直接读取并剥掉 UTF-8 BOM', async t => {
  const binding = await fixture(t, { 'data.csv': Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('姓名,数量\n苹果,3\n')]) });
  const out = await executeUserTool('feishu_workspace_extract_text', { path: 'data.csv' }, binding, {});
  assert.equal(out.text, '姓名,数量\n苹果,3\n');
});

test('不支持的文档类型给出可操作的提示', async t => {
  const binding = await fixture(t, { 'slides.pptx': Buffer.from('PK') });
  await assert.rejects(
    () => executeUserTool('feishu_workspace_extract_text', { path: 'slides.pptx' }, binding, {}),
    /暂不支持.*PDF.*xlsx.*CSV/,
  );
});
