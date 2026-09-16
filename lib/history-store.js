import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_TEXT_BYTES = 512 * 1024;

function messageText(value) {
  if (typeof value !== 'string') throw new TypeError('text must be a string');
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw new TypeError('History text must not exceed 512 KiB');
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function iso(value = new Date(), name = 'timestamp') {
  if (!(value instanceof Date) && typeof value !== 'string') throw new TypeError(`${name} must be an ISO timestamp`);
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new TypeError(`${name} must include a timezone`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} is invalid`);
  return date.toISOString();
}

function rejectLink(filename) {
  try {
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('History storage must not use symbolic links');
    if (stat.isFile() && stat.nlink > 1) throw new Error('History storage must not use hard links');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function checkDirectoryAncestors(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('History storage ancestors must be directories without symbolic links');
  }
}

function privateDirectory(directory) {
  rejectLink(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  rejectLink(directory);
  if (!lstatSync(directory).isDirectory()) throw new Error('History storage is not a directory');
  chmodSync(directory, 0o700);
}

function record(row) { return row ? { ...row } : null; }

export function userKey({ source, tenantId = '', openId }) {
  required(source, 'source'); required(openId, 'openId');
  if (typeof tenantId !== 'string') throw new TypeError('tenantId must be a string');
  return createHash('sha256').update(JSON.stringify([source, tenantId, openId])).digest('hex');
}

/** One manager per plugin process. Callers bind a trusted platform identity before exposing any tools. */
export async function createHistoryStore({ root }) {
  required(root, 'root');
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (cause) {
    throw new Error('Feishu conversation history requires Node.js 22.13 or newer with node:sqlite enabled.', { cause });
  }
  const directory = path.resolve(root);
  privateDirectory(directory);
  const canonicalRoot = realpathSync(directory);
  const cache = new Map();
  let closed = false;
  return {
    forUser({ source, tenantId = '', openId }) {
      if (closed) throw new Error('History store is closed');
      checkDirectoryAncestors(canonicalRoot);
      const key = userKey({ source, tenantId, openId });
      if (cache.has(key)) return cache.get(key);
      const userDirectory = path.join(canonicalRoot, key);
      privateDirectory(userDirectory);
      const databasePath = path.join(userDirectory, 'history.sqlite');
      // Recheck paths before each database operation, including cached handles:
      // SQLite may create journal files later. Concurrent filesystem mutation
      // by a local administrator is outside this same-process trust boundary.
      const checkStorage = () => {
        checkDirectoryAncestors(userDirectory);
        for (const suffix of ['', '-journal', '-wal', '-shm']) rejectLink(databasePath + suffix);
      };
      checkStorage();
      if (existsSync(databasePath) && !lstatSync(databasePath).isFile()) throw new Error('History database is not a regular file');
      const descriptor = openSync(databasePath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
      closeSync(descriptor);
      chmodSync(databasePath, 0o600);
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`
          PRAGMA foreign_keys = ON;
          PRAGMA busy_timeout = 5000;
          PRAGMA journal_mode = DELETE;
          CREATE TABLE IF NOT EXISTS sessions (
            sessionId TEXT PRIMARY KEY, chatId TEXT NOT NULL, createdAt TEXT NOT NULL,
            closedAt TEXT, closeReason TEXT, dayKey TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS bindings (
            chatId TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(sessionId)
          );
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(sessionId),
            role TEXT NOT NULL CHECK(role IN ('user','assistant','note')), text TEXT NOT NULL,
            timestamp TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT,
            feishuMessageId TEXT, turn TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS messages_feishu_id ON messages(feishuMessageId) WHERE feishuMessageId IS NOT NULL;
          CREATE INDEX IF NOT EXISTS messages_time ON messages(timestamp, id);
          CREATE INDEX IF NOT EXISTS messages_session_time ON messages(sessionId, timestamp, id);
          CREATE TABLE IF NOT EXISTS deliveries (messageId TEXT PRIMARY KEY, receivedAt TEXT NOT NULL);
        `);
        const store = userStore(database, checkStorage);
        cache.set(key, store);
        return store;
      } catch (error) { database.close(); throw error; }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const store of cache.values()) store.close();
      cache.clear();
    },
  };
}

function userStore(database, checkStorage) {
  let closed = false;
  const statements = new Map();
  function statement(sql) {
    if (closed) throw new Error('User history store is closed');
    checkStorage();
    if (!statements.has(sql)) statements.set(sql, database.prepare(sql));
    return statements.get(sql);
  }
  function transaction(run) {
    if (closed) throw new Error('User history store is closed');
    checkStorage();
    database.exec('BEGIN IMMEDIATE');
    try { const result = run(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  const getSession = sessionId => record(statement('SELECT * FROM sessions WHERE sessionId = ?').get(required(sessionId, 'sessionId')));
  const getMessage = id => record(statement('SELECT * FROM messages WHERE id = ? AND deletedAt IS NULL').get(required(id, 'id')));
  const api = {
    getSession,
    ensureSession({ sessionId, chatId, dayKey, createdAt }) {
      required(sessionId, 'sessionId'); required(chatId, 'chatId'); required(dayKey, 'dayKey');
      return transaction(() => {
        statement('INSERT OR IGNORE INTO sessions(sessionId, chatId, createdAt, dayKey) VALUES (?, ?, ?, ?)').run(sessionId, chatId, iso(createdAt, 'createdAt'), dayKey);
        const session = getSession(sessionId);
        if (session.chatId !== chatId) throw new Error('Session already belongs to a different chat');
        return session;
      });
    },
    getCurrentSession(chatId) {
      return record(statement('SELECT sessions.* FROM bindings JOIN sessions USING(sessionId) WHERE bindings.chatId = ? AND sessions.closedAt IS NULL').get(required(chatId, 'chatId')));
    },
    listCurrentSessions() {
      return statement('SELECT sessions.* FROM bindings JOIN sessions USING(sessionId) WHERE sessions.closedAt IS NULL ORDER BY sessions.createdAt').all().map(record);
    },
    setCurrentSession(chatId, sessionId) {
      required(chatId, 'chatId');
      return transaction(() => {
        const session = getSession(sessionId);
        if (!session || session.chatId !== chatId || session.closedAt) throw new Error('Cannot bind an unknown, closed, or different-chat session');
        statement('INSERT INTO bindings(chatId,sessionId) VALUES (?,?) ON CONFLICT(chatId) DO UPDATE SET sessionId=excluded.sessionId').run(chatId, sessionId);
        return session;
      });
    },
    closeSession(sessionId, { reason = 'new', closedAt } = {}) {
      return transaction(() => {
        statement('UPDATE sessions SET closedAt=?, closeReason=? WHERE sessionId=? AND closedAt IS NULL').run(iso(closedAt, 'closedAt'), required(reason, 'reason'), required(sessionId, 'sessionId'));
        statement('DELETE FROM bindings WHERE sessionId=?').run(sessionId);
        return getSession(sessionId);
      });
    },
    claimMessage(feishuMessageId) {
      return statement('INSERT OR IGNORE INTO deliveries(messageId, receivedAt) VALUES (?, ?)').run(required(feishuMessageId, 'feishuMessageId'), iso()).changes === 1;
    },
    appendMessage({ id = randomUUID(), sessionId, role, text, timestamp, feishuMessageId = null, turn = null }) {
      required(id, 'id'); required(sessionId, 'sessionId');
      if (!['user', 'assistant', 'note'].includes(role)) throw new TypeError('Invalid history message role');
      messageText(text);
      if (feishuMessageId !== null) required(feishuMessageId, 'feishuMessageId');
      if (turn !== null && !['string', 'number'].includes(typeof turn)) throw new TypeError('turn must be a string or number');
      const time = iso(timestamp);
      return transaction(() => {
        if (feishuMessageId !== null) {
          const previous = record(statement('SELECT * FROM messages WHERE feishuMessageId=?').get(feishuMessageId));
          if (previous) return previous;
        }
        statement('INSERT INTO messages(id,sessionId,role,text,timestamp,updatedAt,feishuMessageId,turn) VALUES (?,?,?,?,?,?,?,?)').run(id, sessionId, role, text, time, time, feishuMessageId, turn === null ? null : String(turn));
        return getMessage(id);
      });
    },
    searchMessages({ query, from, to, sessionId, chatId, limit = 50, offset = 0 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be between 1 and 200');
      if (!Number.isInteger(offset) || offset < 0) throw new TypeError('offset must be non-negative');
      const clauses = ['deletedAt IS NULL']; const values = [];
      if (query !== undefined) {
        if (typeof query !== 'string') throw new TypeError('query must be a string');
        clauses.push("text LIKE ? ESCAPE '\\'"); values.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`);
      }
      if (from !== undefined) { clauses.push('timestamp >= ?'); values.push(iso(from, 'from')); }
      if (to !== undefined) { clauses.push('timestamp <= ?'); values.push(iso(to, 'to')); }
      if (sessionId !== undefined) { clauses.push('sessionId = ?'); values.push(required(sessionId, 'sessionId')); }
      if (chatId !== undefined) { clauses.push('sessionId IN (SELECT sessionId FROM sessions WHERE chatId = ?)'); values.push(required(chatId, 'chatId')); }
      return statement(`SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset).map(record);
    },
    getMessage,
    getMessageByFeishuId(feishuMessageId) {
      return record(statement("SELECT * FROM messages WHERE feishuMessageId=? AND role='user' AND deletedAt IS NULL").get(required(feishuMessageId, 'feishuMessageId')));
    },
    moveUserMessage(feishuMessageId, sessionId) {
      required(feishuMessageId, 'feishuMessageId'); required(sessionId, 'sessionId');
      return transaction(() => {
        const message = api.getMessageByFeishuId(feishuMessageId);
        const destination = getSession(sessionId);
        if (!message || !destination || getSession(message.sessionId)?.chatId !== destination.chatId) {
          throw new Error('Cannot move an unknown message or move history between chats');
        }
        statement("UPDATE messages SET sessionId=?, updatedAt=? WHERE id=? AND role='user' AND deletedAt IS NULL").run(sessionId, iso(), message.id);
        return getMessage(message.id);
      });
    },
    updateMessage(id, { text }) {
      messageText(text);
      statement('UPDATE messages SET text=?, updatedAt=? WHERE id=? AND deletedAt IS NULL').run(text, iso(), required(id, 'id'));
      return getMessage(id);
    },
    deleteMessage(id) {
      const time = iso();
      return statement('UPDATE messages SET deletedAt=?, updatedAt=? WHERE id=? AND deletedAt IS NULL').run(time, time, required(id, 'id')).changes === 1;
    },
    close() { if (!closed) { closed = true; statements.clear(); database.close(); } },
  };
  return api;
}
