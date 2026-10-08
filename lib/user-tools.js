import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 512 * 1024;
const string = { type: 'string' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = [
  ['feishu_history_search', 'Search your own history in this chat, including archived sessions. Use before answering questions about earlier conversations; dates are ISO timestamps. The query supports multiple whitespace-separated keywords matched with AND (each keyword may appear anywhere in the text) — prefer 1-3 distinctive keywords over long phrases. Each text is a preview of at most 500 Unicode characters, with truncated and fullLength fields. Read longer records with feishu_history_get.', schema({ query: string, from: string, to: string, sessionId: string, limit: { type: 'integer', description: 'Maximum records, from 1 to 100.' }, offset: { type: 'integer', description: 'Non-negative number of records to skip.' } })],
  ['feishu_history_get', 'Read a page of one record from your own history in this chat. Offsets and lengths count Unicode characters. Returns nextOffset (null at the end), fullLength, and truncated (true when the returned text is only part of the record).', schema({ id: string, offset: { type: 'integer', description: 'Non-negative character offset; defaults to 0.' }, limit: { type: 'integer', description: 'Characters to return, from 1 to 20000; defaults to 8000.' } }, ['id'])],
  ['feishu_history_create', 'Save a note in your own history. Only do this at the user’s request.', schema({ text: string }, ['text'])],
  ['feishu_history_update', 'Correct one history record at the user’s request. This does not rewrite already loaded context or Harness logs.', schema({ id: string, text: string }, ['id', 'text'])],
  ['feishu_history_delete', 'Soft-delete one history record at the user’s request. Backups and Harness logs are not erased.', schema({ id: string }, ['id'])],
  ['feishu_workspace_list', 'List entries inside your own workspace. Paths must be relative; symbolic links cannot be followed.', schema({ path: string })],
  ['feishu_workspace_read', 'Read a UTF-8 file in your own workspace, at most 512 KiB. No absolute paths or symbolic links.', schema({ path: string }, ['path'])],
  ['feishu_workspace_write', 'Write a UTF-8 file in your own workspace. Requires workspace-write permission. No absolute paths or symbolic links.', schema({ path: string, text: string }, ['path', 'text'])],
  ['feishu_workspace_extract_text', 'Extract readable text from a document in your own workspace (PDF via server-side pdftotext; Excel .xlsx; CSV/TSV; plain text). Use this to read document attachments before answering questions about them. Paths must be relative. Returns UTF-8 text capped at 100,000 characters; when truncated, say so and offer to continue by page/row range.', schema({ path: string, maxPages: { type: 'integer', description: 'Extract only the first N pages (1-200, PDF only). Omit for the whole document.' } }, ['path'])],
];
export const userTools = definitions.map(([name, description, parameters]) => ({ name, description, parameters }));
export const userToolNames = userTools.map(tool => tool.name);

// The plugin exposes no shell, symlink or raw filesystem tool to remote agents.
// Every operation checks each component; filesystem mutation by the local OS
// administrator is outside this shared-process isolation boundary.
const escapes = value => value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);

async function checkAncestors(absolute, create = false, start = parse(absolute).root) {
  const parts = relative(start, absolute).split(sep);
  let current = start;
  const startStat = await lstat(start);
  if (!startStat.isDirectory() || startStat.isSymbolicLink()) throw new Error('Invalid workspace root');
  for (const part of parts) {
    if (!part) continue;
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Workspace must not contain symbolic links');
  }
}

// Only the administrator-configured root may resolve through system aliases
// (e.g. macOS /var -> /private/var). User directories below it never may.
export async function ensurePrivateDirectory(path, { trustedRoot } = {}) {
  let absolute = resolve(path);
  if (trustedRoot !== undefined) {
    const relativePath = relative(resolve(trustedRoot), absolute);
    if (escapes(relativePath)) throw new Error('Path escapes the workspace');
    const canonicalRoot = await realpath(resolve(trustedRoot));
    absolute = resolve(canonicalRoot, relativePath);
    await checkAncestors(absolute, true, canonicalRoot);
  } else {
    await checkAncestors(absolute, true);
  }
  return absolute;
}
export async function checkedPath(root, input = '', createParents = false) {
  if (typeof input !== 'string' || input.includes('\0') || input.includes('\\') || input.includes(':') || isAbsolute(input)) throw new Error('Use a relative workspace path');
  const parts = input.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) throw new Error('Path escapes the workspace');
  if (parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsupported workspace filename');
  if (!isAbsolute(root)) throw new Error('Invalid workspace root');
  // The root was canonicalized during authorization. Reject changed ancestor
  // links as well as links below the root on every subsequent operation.
  await checkAncestors(root);
  let path = root;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    let stat;
    try { stat = await lstat(path); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (i < parts.length - 1 && createParents) { await mkdir(path, { mode: 0o700 }); stat = await lstat(path); }
      else if (i === parts.length - 1) return path;
      else throw new Error('Directory does not exist');
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Linked files are not accessible');
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Expected a regular file or directory');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('Not a directory');
  }
  if (escapes(relative(root, path))) throw new Error('Path escapes the workspace');
  return path;
}
const EXTRACT_MAX_FILE_BYTES = 30 * 1024 * 1024;  // 源文档上限 30MB
const EXTRACT_MAX_CHARS = 100_000;                  // 返回文本上限（字符）
const EXTRACT_TIMEOUT_MS = 30_000;
const XLSX_SCRIPT = fileURLToPath(new URL('../scripts/xlsx-to-text.py', import.meta.url));

/** 服务端文档文本提取。path 必须是 checkedPath 返回的绝对路径。 */
async function extractDocumentText(path, args) {
  const ext = (parse(path).ext || '').toLowerCase();
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file');
  if (stat.size > EXTRACT_MAX_FILE_BYTES) throw new Error('文档超过 30MB，无法解析');
  const maxPages = args.maxPages;
  if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200)) throw new Error('maxPages 必须是 1-200 的整数');
  if (ext === '.pdf') {
    const argv = ['-enc', 'UTF-8', '-nopgbrk'];
    if (maxPages) argv.push('-l', String(maxPages));
    argv.push(path, '-');  // path 为绝对路径（以 / 开头），不会被误认为选项
    return await runExtractor('pdftotext', argv);
  }
  if (ext === '.xlsx') return await runExtractor('python3', [XLSX_SCRIPT, path]);
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt' || ext === '.md') return await readPlainText(path);
  throw new Error(`暂不支持的文档类型「${ext || '无扩展名'}」，目前支持 PDF、Excel(.xlsx)、CSV/TSV、纯文本；其他格式请导出为这些格式后重试`);
}

async function readPlainText(path) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.alloc(EXTRACT_MAX_CHARS * 4 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    let raw = buffer.subarray(0, bytesRead);
    // UTF-8 BOM 与 UTF-16 探测（飞书导出 CSV 可能带 BOM）
    let text;
    if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) text = raw.subarray(2).toString('utf16le');
    else if (raw.length >= 2 && raw[0] === 0xFE && raw[1] === 0xFF) { const swapped = Buffer.from(raw.subarray(2)); for (let i = 0; i + 1 < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t; } text = swapped.toString('utf16le'); }
    else { if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.subarray(3); text = raw.toString('utf8'); }
    const truncated = text.length > EXTRACT_MAX_CHARS;
    return { text: truncated ? text.slice(0, EXTRACT_MAX_CHARS) : text, truncated };
  } finally { await file.close(); }
}

function runExtractor(command, argv) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', truncated = false, settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(reject, new Error('文档解析超时（30 秒）')); }, EXTRACT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (out.length <= EXTRACT_MAX_CHARS) out += chunk;
      if (out.length > EXTRACT_MAX_CHARS) { out = out.slice(0, EXTRACT_MAX_CHARS); truncated = true; }
      // 超限后继续吞掉输出，避免背压挂起子进程
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (err.length < 2000) err += chunk; });
    child.on('error', e => done(reject, new Error(`文档解析器不可用：${e.message}`)));
    child.on('close', code => {
      if (code !== 0) return done(reject, new Error(`文档解析失败（退出码 ${code}）：${err.trim().slice(0, 300) || '未知错误'}`));
      done(resolvePromise, { text: out, truncated });
    });
  });
}

export async function executeUserTool(name, args, binding, config) {
  if (!userToolNames.includes(name)) throw new Error('Tool unavailable');
  const { store, chatId, sessionId, workspacePath } = binding;
  const ownedRecord = id => {
    const record = store.getMessage(id);
    if (!record || store.getSession(record.sessionId)?.chatId !== chatId) throw new Error('History record not found in this chat');
    return record;
  };
  if (name === 'feishu_history_search') {
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new Error('History search limit must be between 1 and 100');
    return store.searchMessages({ ...args, chatId }).map(record => {
      const characters = [...record.text];
      return { ...record, text: characters.slice(0, 500).join(''), truncated: characters.length > 500, fullLength: characters.length };
    });
  }
  if (name === 'feishu_history_get') {
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 8000;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('History character offset must be a non-negative safe integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20000) throw new Error('History character limit must be between 1 and 20000');
    const record = ownedRecord(args.id);
    const characters = [...record.text];
    const end = Math.min(offset + limit, characters.length);
    return {
      ...record,
      text: characters.slice(offset, end).join(''),
      nextOffset: end < characters.length ? end : null,
      fullLength: characters.length,
      truncated: characters.length > 0 && (offset > 0 || end < characters.length),
    };
  }
  if (name === 'feishu_history_create') {
    if (store.getSession(sessionId)?.chatId !== chatId) throw new Error('History session not found in this chat');
    return store.appendMessage({ sessionId, role: 'note', text: args.text });
  }
  if (name === 'feishu_history_update') { ownedRecord(args.id); return store.updateMessage(args.id, { text: args.text }); }
  if (name === 'feishu_history_delete') { ownedRecord(args.id); return store.deleteMessage(args.id); }
  if (name === 'feishu_workspace_write' && config.permissionPreset !== 'workspace-write') throw new Error('Workspace is read-only');
  const path = await checkedPath(workspacePath, args.path, name === 'feishu_workspace_write');
  if (name === 'feishu_workspace_list') {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.slice(0, 200).map(entry => ({ name: entry.name, type: entry.isSymbolicLink() ? 'blocked-link' : entry.isDirectory() ? 'directory' : 'file' }));
  }
  if (name === 'feishu_workspace_read') {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_BYTES) throw new Error('Expected a regular file no larger than 512 KiB');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_BYTES) throw new Error('File exceeds 512 KiB');
      return { text: buffer.subarray(0, total).toString('utf8') };
    } finally { await file.close(); }
  }
  if (name === 'feishu_workspace_write') {
    if (path === workspacePath || typeof args.text !== 'string' || Buffer.byteLength(args.text) > MAX_BYTES) throw new Error('Expected a file and text no larger than 512 KiB');
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(args.text, 'utf8'); await file.close(); await rename(temporary, path); }
    finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    return { written: true };
  }
  if (name === 'feishu_workspace_extract_text') {
    return await extractDocumentText(path, args);
  }
  throw new Error('Tool unavailable');
}
