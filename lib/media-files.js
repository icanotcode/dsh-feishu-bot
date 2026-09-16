import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkedPath, ensurePrivateDirectory } from './user-tools.js';

const INCOMING_MAX_BYTES = 100 * 1024 * 1024;
const OUTGOING_MAX_BYTES = 30 * 1024 * 1024;
const DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i;

function safeFilename(filename, kind) {
  const value = filename ?? `${['image', 'video', 'audio'].includes(kind) ? kind : 'attachment'}.bin`;
  if (typeof value !== 'string' || !value || /[\\/:\0]/.test(value) || value === '.' || value === '..' || /[. ]$/.test(value) || DEVICE_NAME.test(value)) {
    throw new Error('Unsupported attachment filename');
  }
  // Keep useful Unicode names while removing characters forbidden on Windows.
  let safe = value.replace(/[<>"|?*\x01-\x1f\x7f]/g, '_');
  const extension = /\.[a-zA-Z0-9]{1,12}$/.exec(safe)?.[0] ?? '';
  if (Buffer.byteLength(safe) > 180) {
    const characters = [...safe.slice(0, extension ? -extension.length : undefined)];
    while (Buffer.byteLength(characters.join('') + extension) > 180) characters.pop();
    safe = characters.join('') + extension;
  }
  if (!safe || DEVICE_NAME.test(safe) || /[. ]$/.test(safe)) throw new Error('Unsupported attachment filename');
  return safe;
}

/** Save only user-provided upload bytes; agent workspace-write permissions do not apply here. */
export async function saveIncomingFile(workspacePath, { data, filename, kind, messageId }) {
  if (!(data instanceof Uint8Array)) throw new Error('Attachment data must be binary bytes');
  if (data.byteLength > INCOMING_MAX_BYTES) throw new Error('Attachment exceeds 100 MiB');
  if (typeof messageId !== 'string' || !messageId) throw new Error('Attachment message ID is required');
  const name = safeFilename(filename, kind);
  const messageDirectory = createHash('sha256').update(messageId).digest('hex').slice(0, 16);
  // Validate the supplied canonical user root before creating any directories.
  await checkedPath(workspacePath, '');
  await ensurePrivateDirectory(join(workspacePath, 'incoming', messageDirectory));
  const relativePath = `incoming/${messageDirectory}/${randomUUID()}-${name}`;
  const absolute = await checkedPath(workspacePath, relativePath);
  const file = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  let complete = false;
  try {
    await file.writeFile(data);
    await file.sync();
    complete = true;
  } finally {
    await file.close();
    if (!complete) await unlink(absolute).catch(() => {});
  }
  return { path: relativePath, size: data.byteLength, name };
}

/** Read one file from the current user's directory, never following links. */
export async function readOutgoingFile(workspacePath, input, { maxBytes = OUTGOING_MAX_BYTES, signal } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > INCOMING_MAX_BYTES) throw new Error('Invalid attachment byte limit');
  signal?.throwIfAborted();
  const absolute = await checkedPath(workspacePath, input);
  // checkedPath also protects other tools; these extra aliases are media-specific.
  if (typeof input !== 'string' || input.split('/').some(part => DEVICE_NAME.test(part))) throw new Error('Unsupported attachment filename');
  signal?.throwIfAborted();
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected a regular attachment file without hard links');
    if (stat.size > maxBytes) throw new Error(`Attachment exceeds ${maxBytes} bytes`);
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Attachment exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (!after.isFile() || after.nlink !== 1 || after.size > maxBytes) throw new Error('Attachment changed while reading');
    signal?.throwIfAborted();
    return { data: Buffer.concat(chunks, total), filename: basename(absolute), size: total };
  } finally {
    await file.close();
  }
}

export const mediaToolDefinitions = [{
  name: 'feishu_send_file',
  description: 'Send a file from your own workspace to the current Feishu chat only, when requested by the user. Paths must be relative to your workspace. Other users’ files, absolute paths and linked files are forbidden. kind defaults to file. Images: at most 10 MiB; files/video/audio: at most 30 MiB; empty files cannot be sent. Video messages require MP4, audio messages require OPUS; use kind=file for other formats. Generate text documents with feishu_workspace_write first. Only claim successful delivery when sent=true.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file in your own workspace.' },
      kind: { type: 'string', enum: ['file', 'image', 'video', 'audio'], description: 'Message media kind; omitted means file.' },
      coverPath: { type: 'string', description: 'Optional image cover in your own workspace, for video.' },
      duration: { type: 'integer', description: 'Optional media duration in milliseconds; non-negative.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}];
