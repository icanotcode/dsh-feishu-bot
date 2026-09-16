import { createTransport } from './transport.js';
import { createManagement } from './management.js';
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createDecipheriv, timingSafeEqual } from "node:crypto";
import { installFeishuRuntime } from "./runtime.js";
import z from "@deepseek-ai/schemastery";
import { snapshotJsonValue } from "@deepseek-ai/dsh-util-values";
import { WebhookDeliveryId, WebhookSourceId } from "@deepseek-ai/dsh-webhook";

// ===== HTTP Body Reading =====

class WebhookHttpError extends Error {
  status;
  name = "WebhookHttpError";
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function contentLength(request) {
  const value = request.headers["content-length"];
  if (value === void 0) return void 0;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new WebhookHttpError(400, "invalid Content-Length");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new WebhookHttpError(413, "request body is too large");
  return length;
}

async function readBoundedUtf8Body(request, maxBodyBytes) {
  const declared = contentLength(request);
  if (declared !== void 0 && declared > maxBodyBytes) {
    request.resume();
    throw new WebhookHttpError(413, "request body is too large");
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      if (size > maxBodyBytes) {
        request.resume();
        throw new WebhookHttpError(413, "request body is too large");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof WebhookHttpError) throw error;
    throw new WebhookHttpError(400, "request body was aborted");
  }
  if (!request.complete) throw new WebhookHttpError(400, "request body was aborted");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    throw new WebhookHttpError(400, "request body is not valid UTF-8");
  }
}

// ===== Feishu API Client =====

export class FeishuClient {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.baseUrl = 'https://open.feishu.cn';
    this.cachedToken = null;
    this.tokenExpireTime = 0;
    this.requests = new AsyncLocalStorage();
  }

  withSignal(signal, run) {
    return this.requests.run(signal, run);
  }

  invalidateToken() {
    this.cachedToken = null;
    this.tokenExpireTime = 0;
  }

  async getTenantToken() {
    const [appId, appSecret] = await Promise.all([
      this.ctx.credentials.resolve(credentialRef(this.config.appIdEnv)),
      this.ctx.credentials.resolve(credentialRef(this.config.appSecretEnv))
    ]);
    const identity = createHash('sha256').update(JSON.stringify([appId?.value, appSecret?.value])).digest('hex');
    if (this.cachedToken && identity === this.tokenIdentity && Date.now() < this.tokenExpireTime - 60 * 1000) {
      return this.cachedToken;
    }

    if (!appId?.value || !appSecret?.value) {
      throw new Error('Feishu credentials not configured');
    }

    const response = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      signal: this.requests.getStore() ? AbortSignal.any([this.requests.getStore(), AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: appId.value,
        app_secret: appSecret.value
      })
    });

    const data = await response.json();
    if (!response.ok || data.code !== 0 || typeof data.tenant_access_token !== 'string') {
      throw new Error(`Failed to get Feishu token: ${data.msg}`);
    }

    this.cachedToken = data.tenant_access_token;
    this.tokenIdentity = identity;
    this.tokenExpireTime = Date.now() + data.expire * 1000;
    return this.cachedToken;
  }

  async request(method, endpoint, body = null, queryParams = {}) {
    const token = await this.getTenantToken();

    let url = `${this.baseUrl}${endpoint}`;
    if (Object.keys(queryParams).length > 0) {
      const searchParams = new URLSearchParams(queryParams);
      url += `?${searchParams.toString()}`;
    }

    const options = {
      method,
      signal: this.requests.getStore() ? AbortSignal.any([this.requests.getStore(), AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu API error [${data.code}]: ${data.msg}`);
    }

    return data.data;
  }

  // ===== Messaging APIs =====

  async addMessageReaction(messageId, emojiType = 'Typing') {
    return this.request('POST', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      reaction_type: { emoji_type: emojiType }
    });
  }

  async deleteMessageReaction(messageId, reactionId) {
    return this.request('DELETE', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`);
  }

  async replyMessage(messageId, content, msgType = 'text') {
    return this.request('POST', `/open-apis/im/v1/messages/${messageId}/reply`, {
      msg_type: msgType,
      content: JSON.stringify(typeof content === 'string' ? { text: content } : content)
    });
  }

  async sendTextMessage(receiveId, text, receiveType = 'open_id') {
    return this.request('POST', `/open-apis/im/v1/messages?receive_id_type=${receiveType}`, {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text })
    });
  }

  async sendRichText(receiveId, postContent, receiveType = 'open_id') {
    return this.request('POST', `/open-apis/im/v1/messages?receive_id_type=${receiveType}`, {
      receive_id: receiveId,
      msg_type: 'post',
      content: JSON.stringify({
        zh_cn: {
          title: '',
          content: postContent
        }
      })
    });
  }

  async sendImage(receiveId, imageKey, receiveType = 'open_id') {
    return this.request('POST', `/open-apis/im/v1/messages?receive_id_type=${receiveType}`, {
      receive_id: receiveId,
      msg_type: 'image',
      content: JSON.stringify({ image_key: imageKey })
    });
  }

  async sendCard(receiveId, cardContent, receiveType = 'open_id') {
    return this.request('POST', `/open-apis/im/v1/messages?receive_id_type=${receiveType}`, {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(cardContent)
    });
  }

  async recallMessage(messageId) {
    return this.request('DELETE', `/open-apis/im/v1/messages/${messageId}`);
  }

  async getMessage(messageId) {
    return this.request('GET', `/open-apis/im/v1/messages/${messageId}`);
  }

  async getMessageReadUsers(messageId) {
    return this.request('GET', `/open-apis/im/v1/messages/${messageId}/read_users`);
  }

  // ===== Chat/Group APIs =====

  async createChat(name, description = '') {
    return this.request('POST', '/open-apis/im/v1/chats', {
      name,
      description
    });
  }

  async getChat(chatId) {
    return this.request('GET', `/open-apis/im/v1/chats/${chatId}`);
  }

  async updateChat(chatId, updates) {
    return this.request('PUT', `/open-apis/im/v1/chats/${chatId}`, updates);
  }

  async addChatMembers(chatId, memberIds) {
    return this.request('POST', `/open-apis/im/v1/chats/${chatId}/members`, {
      member_ids: memberIds
    });
  }

  async removeChatMembers(chatId, memberIds) {
    return this.request('DELETE', `/open-apis/im/v1/chats/${chatId}/members`, {
      member_ids: memberIds
    });
  }

  async getChatMembers(chatId) {
    return this.request('GET', `/open-apis/im/v1/chats/${chatId}/members`);
  }

  async getChatList() {
    return this.request('GET', '/open-apis/im/v1/chats');
  }

  // ===== User/Contact APIs =====

  async getUserInfo(userId) {
    return this.request('GET', `/open-apis/contact/v3/users/${userId}`);
  }

  async getUserList(departmentId = '0') {
    return this.request('GET', `/open-apis/contact/v3/users`, null, {
      department_id: departmentId
    });
  }

  async searchUsers(query) {
    return this.request('GET', '/open-apis/search/v1/user', null, {
      query
    });
  }

  // ===== Document APIs =====

  async createDocument(title, folderToken = '') {
    return this.request('POST', '/open-apis/docx/v1/documents', {
      title,
      folder_token: folderToken
    });
  }

  async getDocument(documentId) {
    return this.request('GET', `/open-apis/docx/v1/documents/${documentId}`);
  }

  async getDocumentContent(documentId) {
    return this.request('GET', `/open-apis/docx/v1/documents/${documentId}/raw_content`);
  }

  async updateDocument(documentId, updates) {
    return this.request('PATCH', `/open-apis/docx/v1/documents/${documentId}`, updates);
  }

  async createDocumentBlock(documentId, block) {
    return this.request('POST', `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
      children: [block], index: -1
    });
  }

  async getDocumentBlocks(documentId) {
    return this.request('GET', `/open-apis/docx/v1/documents/${documentId}/blocks`);
  }

  // ===== Sheet APIs =====

  async createSheet(title, folderToken = '') {
    return this.request('POST', '/open-apis/sheets/v3/spreadsheets', {
      title,
      folder_token: folderToken
    });
  }

  async getSheet(spreadsheetToken) {
    return this.request('GET', `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}`);
  }

  async getSheetValues(spreadsheetToken, range) {
    return this.request('GET', `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`);
  }

  async updateSheetValues(spreadsheetToken, range, values) {
    return this.request('PUT', `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`, {
      valueRange: {
        range,
        values
      }
    });
  }

  async appendSheetValues(spreadsheetToken, range, values) {
    return this.request('POST', `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_append`, {
      valueRange: {
        range,
        values
      }
    });
  }

  // ===== Calendar APIs =====

  async createCalendar(summary, description = '') {
    return this.request('POST', '/open-apis/calendar/v4/calendars', {
      summary,
      description
    });
  }

  async getCalendarList() {
    return this.request('GET', '/open-apis/calendar/v4/calendars');
  }

  async createEvent(calendarId, event) {
    return this.request('POST', `/open-apis/calendar/v4/calendars/${calendarId}/events`, event);
  }

  async getEvent(calendarId, eventId) {
    return this.request('GET', `/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}`);
  }

  async updateEvent(calendarId, eventId, updates) {
    return this.request('PATCH', `/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}`, updates);
  }

  async deleteEvent(calendarId, eventId) {
    return this.request('DELETE', `/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}`);
  }

  // ===== Task APIs =====

  async createTask(summary, description = '') {
    return this.request('POST', '/open-apis/task/v2/tasks', {
      summary,
      description
    });
  }

  async getTask(taskId) {
    return this.request('GET', `/open-apis/task/v2/tasks/${taskId}`);
  }

  async updateTask(taskId, updates) {
    return this.request('PATCH', `/open-apis/task/v2/tasks/${taskId}`, {
      task: updates, update_fields: Object.keys(updates)
    });
  }

  async completeTask(taskId) {
    return this.updateTask(taskId, { completed_at: String(Date.now()) });
  }

  async getTaskList() {
    return this.request('GET', '/open-apis/task/v2/tasks');
  }

  // ===== Drive APIs =====

  async uploadFile(fileName, parentType, parentNode, file) {
    const token = await this.getTenantToken();

    const formData = new FormData();
    formData.append('file_name', fileName);
    formData.append('parent_type', parentType);
    formData.append('parent_node', parentNode);
    formData.append('file', file);

    const response = await fetch(`${this.baseUrl}/open-apis/drive/v1/files/upload_all`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Feishu API error [${data.code}]: ${data.msg}`);
    }

    return data.data;
  }

  async downloadFile(fileToken) {
    const token = await this.getTenantToken();

    const response = await fetch(`${this.baseUrl}/open-apis/drive/v1/files/${fileToken}/download`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    return response.arrayBuffer();
  }

  async getFileList(folderToken = '') {
    return this.request('GET', '/open-apis/drive/v1/files', null, {
      folder_token: folderToken
    });
  }

  // ===== Wiki APIs =====

  async getWikiNode(nodeToken) {
    return this.request('GET', `/open-apis/wiki/v2/spaces/get_node`, null, {
      token: nodeToken
    });
  }

  async createWikiNode(spaceId, parentNodeToken, nodeType, title, objToken = '') {
    return this.request('POST', `/open-apis/wiki/v2/spaces/${spaceId}/nodes`, {
      parent_node_token: parentNodeToken,
      node_type: nodeType,
      title,
      obj_token: objToken
    });
  }

  // ===== Bitable APIs =====

  async createBitable(name, folderToken = '') {
    return this.request('POST', '/open-apis/bitable/v1/apps', {
      name,
      folder_token: folderToken
    });
  }

  async getBitable(appToken) {
    return this.request('GET', `/open-apis/bitable/v1/apps/${appToken}`);
  }

  async createBitableTable(appToken, tableName) {
    return this.request('POST', `/open-apis/bitable/v1/apps/${appToken}/tables`, {
      table_name: tableName
    });
  }

  async getBitableRecords(appToken, tableId) {
    return this.request('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`);
  }

  async createBitableRecord(appToken, tableId, fields) {
    return this.request('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
      fields
    });
  }

  async updateBitableRecord(appToken, tableId, recordId, fields) {
    return this.request('PUT', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
      fields
    });
  }

  async deleteBitableRecord(appToken, tableId, recordId) {
    return this.request('DELETE', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`);
  }

  // ===== Approval APIs =====

  async createApproval(approvalCode, userId, form) {
    return this.request('POST', '/open-apis/approval/v4/instances', {
      approval_code: approvalCode,
      user_id: userId,
      form
    });
  }

  async getApprovalInstance(instanceId) {
    return this.request('GET', `/open-apis/approval/v4/instances/${instanceId}`);
  }

  // ===== Search APIs =====

  async searchDocs(query, count = 20) {
    return this.request('POST', '/open-apis/search/v2/doc_wiki/search', {
      query, doc_filter: { only_title: false }, page_size: count
    });
  }

  async searchMessages(query, count = 20) {
    throw new Error('Message search requires a Feishu user OAuth token; this plugin currently uses application credentials.');
  }
}

// ===== Feishu Message Parser =====

function parseFeishuMessage(event) {
  const { message, sender } = event;

  if (!message || !sender) {
    return null;
  }

  const chatType = message.chat_type;
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id;

  let userText = '';
  let msgType = message.message_type;
  let content = {};

  try {
    content = JSON.parse(message.content);
    userText = content.text || '';
  } catch {
    userText = message.content || '';
  }

  if (chatType === 'group' && message.mentions) {
    for (const mention of message.mentions) {
      userText = userText.replace(mention.key, '').trim();
    }
  }

  return {
    chatType: chatType || "",
    messageId: messageId || "",
    chatId: chatId || "",
    senderId: senderId || "",
    userText,
    msgType: msgType || "",
    content,
    sender
  };
}

// ===== Feishu Webhook Handler =====

function requiredHeader(request, name) {
  const values = request.headersDistinct?.[name] || [request.headers[name]];
  const value = values?.[0];
  if (values?.length !== 1 || value === undefined || value.trim() === "") {
    throw new WebhookHttpError(400, `missing ${name} header`);
  }
  return value;
}

function isJsonContentType(value) {
  if (value === undefined) return false;
  const [mediaType, parameter, ...extra] = value.split(";").map((part) => part.trim());
  if (mediaType?.toLowerCase() !== "application/json") return false;
  if (parameter === undefined) return true;
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter);
}

function respond(response, status, message) {
  if (message === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function parsePayload(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WebhookHttpError(400, "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebhookHttpError(400, "Feishu webhook payload must be a JSON object");
  }
  const snapshot = snapshotJsonValue(parsed);
  if (snapshot === undefined) throw new WebhookHttpError(400, "Feishu webhook payload is not lossless JSON");
  return snapshot;
}

function constantTimeEqual(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function decodeFeishuPayload(ctx, config, request, body) {
  let payload = parsePayload(body);
  let authenticated = false;
  if (payload.encrypt !== undefined) {
    const key = config.encryptKey && await ctx.credentials.resolve(credentialRef(config.encryptKey));
    if (!key?.value) throw new WebhookHttpError(503, 'Feishu encrypt key is not configured');
    try {
      const ciphertext = Buffer.from(payload.encrypt, 'base64');
      const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(key.value).digest(), ciphertext.subarray(0, 16));
      payload = parsePayload(Buffer.concat([decipher.update(ciphertext.subarray(16)), decipher.final()]).toString('utf8'));
    } catch {
      throw new WebhookHttpError(400, 'invalid encrypted webhook payload');
    }
    // Feishu's initial encrypted URL verification is sent without X-Lark
    // headers. Only the decrypted challenge envelope gets this exception;
    // ordinary events and any partially signed request must still verify.
    const signatureHeaders = ['x-lark-request-timestamp', 'x-lark-request-nonce', 'x-lark-signature'];
    const hasSignatureHeader = signatureHeaders.some(name => request.headers[name] !== undefined || request.headersDistinct?.[name] !== undefined);
    if (payload.type !== 'url_verification' || hasSignatureHeader) {
      const timestamp = requiredHeader(request, 'x-lark-request-timestamp');
      const nonce = requiredHeader(request, 'x-lark-request-nonce');
      const signature = requiredHeader(request, 'x-lark-signature');
      const expected = createHash('sha256').update(timestamp + nonce + key.value + body).digest('hex');
      if (!constantTimeEqual(signature, expected)) throw new WebhookHttpError(401, 'invalid webhook signature');
      authenticated = true;
    }
  }
  if (config.verificationToken) {
    const credential = await ctx.credentials.resolve(credentialRef(config.verificationToken));
    if (credential?.value && !constantTimeEqual(payload.header?.token ?? payload.token, credential.value)) {
      throw new WebhookHttpError(401, 'invalid verification token');
    }
    if (credential?.value) authenticated = true;
  }
  return { payload, authenticated };
}

/** Both authenticated transports share parsing, delivery identity and retry deduplication. */
export function createFeishuEventReceiver(ctx, config) {
  const received = new Map();
  return (payload, { authenticated = false } = {}) => {
    const eventType = payload.header?.event_type || payload.type;
    if (eventType !== 'im.message.receive_v1') {
      return;
    }
    if (!authenticated) throw new WebhookHttpError(503, 'Configure a Feishu verification token or encrypt key before receiving messages');
    const parsed = parseFeishuMessage(payload.event || payload);
    if (!parsed || !parsed.userText || parsed.sender.sender_type === 'app') {
      return;
    }
    if (!parsed.messageId || !parsed.chatId || !parsed.senderId) throw new WebhookHttpError(400, 'missing message identity');
    const eventId = payload.header?.event_id || payload.uuid || parsed.messageId;
    const now = Date.now();
    for (const [id, expires] of received) {
      if (expires <= now) received.delete(id);
    }
    if (received.has(eventId)) {
      return;
    }
    const delivery = {
      kind: 'feishu',
      source: WebhookSourceId(config.source),
      deliveryId: WebhookDeliveryId(eventId),
      event: { name: eventType, payload: { parsed, raw: payload.event || payload } },
      receivedAt: now
    };
    try {
      ctx.webhookRuntime.dispatch(delivery);
    } catch {
      throw new WebhookHttpError(503, 'webhook runtime is unavailable');
    }
    received.set(eventId, now + 10 * 60 * 1000);
    if (received.size > 10000) received.delete(received.keys().next().value);
  };
}

export function createFeishuWebhookHandler(ctx, config, receiveEvent = createFeishuEventReceiver(ctx, config)) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        throw new WebhookHttpError(405, 'method not allowed');
      }
      if (config.connectionMode === 'websocket') {
        throw new WebhookHttpError(409, 'Webhook ingress is disabled while long connection mode is selected');
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        throw new WebhookHttpError(415, 'content type must be application/json');
      }
      const body = await readBoundedUtf8Body(request, config.maxBodyBytes);
      const { payload, authenticated } = await decodeFeishuPayload(ctx, config, request, body);
      if (payload.type === 'url_verification') {
        if (typeof payload.challenge !== 'string') throw new WebhookHttpError(400, 'missing challenge');
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }
      receiveEvent(payload, { authenticated });
      // Feishu expects a fast acknowledgment; agent work and replies run separately.
      respond(response, 200);
    } catch (error) {
      if (error instanceof WebhookHttpError) {
        respond(response, error.status, error.message);
        return;
      }
      ctx.logger.warn('feishu-bot: webhook request failed');
      respond(response, 503, 'webhook ingress is unavailable');
    }
  };
}

// ===== Tool Executor =====

export async function executeFeishuTool(toolName, args, feishuClient) {
  switch (toolName) {
    // Messaging
    case "feishu_send_message":
      return await feishuClient.sendTextMessage(args.receiveId, args.text, args.receiveType || 'open_id');

    case "feishu_reply_message":
      return await feishuClient.replyMessage(args.messageId, args.text);

    case "feishu_recall_message":
      return await feishuClient.recallMessage(args.messageId);

    // Chat/Group
    case "feishu_create_chat":
      return await feishuClient.createChat(args.name, args.description || '');

    case "feishu_get_chat":
      return await feishuClient.getChat(args.chatId);

    case "feishu_add_chat_members":
      return await feishuClient.addChatMembers(args.chatId, args.memberIds);

    case "feishu_remove_chat_members":
      return await feishuClient.removeChatMembers(args.chatId, args.memberIds);

    case "feishu_get_chat_members":
      return await feishuClient.getChatMembers(args.chatId);

    // User/Contact
    case "feishu_get_user_info":
      return await feishuClient.getUserInfo(args.userId);

    case "feishu_search_users":
      return await feishuClient.searchUsers(args.query);

    // Document
    case "feishu_create_document":
      return await feishuClient.createDocument(args.title, args.folderToken || '');

    case "feishu_get_document":
      return await feishuClient.getDocument(args.documentId);

    case "feishu_get_document_content":
      return await feishuClient.getDocumentContent(args.documentId);

    // Sheet
    case "feishu_create_sheet":
      return await feishuClient.createSheet(args.title, args.folderToken || '');

    case "feishu_get_sheet":
      return await feishuClient.getSheet(args.spreadsheetToken);

    case "feishu_get_sheet_values":
      return await feishuClient.getSheetValues(args.spreadsheetToken, args.range);

    case "feishu_update_sheet_values":
      return await feishuClient.updateSheetValues(args.spreadsheetToken, args.range, args.values);

    case "feishu_append_sheet_values":
      return await feishuClient.appendSheetValues(args.spreadsheetToken, args.range, args.values);

    // Calendar
    case "feishu_create_calendar":
      return await feishuClient.createCalendar(args.summary, args.description || '');

    case "feishu_get_calendar_list":
      return await feishuClient.getCalendarList();

    case "feishu_create_calendar_event":
      return await feishuClient.createEvent(args.calendarId, {
        summary: args.summary,
        start_time: { timestamp: new Date(args.startTime).getTime() / 1000 },
        end_time: { timestamp: new Date(args.endTime).getTime() / 1000 },
        description: args.description || ''
      });

    case "feishu_get_calendar_event":
      return await feishuClient.getEvent(args.calendarId, args.eventId);

    case "feishu_update_calendar_event":
      return await feishuClient.updateEvent(args.calendarId, args.eventId, args.updates);

    case "feishu_delete_calendar_event":
      return await feishuClient.deleteEvent(args.calendarId, args.eventId);

    // Task
    case "feishu_create_task":
      return await feishuClient.createTask(args.summary, args.description || '');

    case "feishu_get_task":
      return await feishuClient.getTask(args.taskId);

    case "feishu_update_task":
      return await feishuClient.updateTask(args.taskId, args.updates);

    case "feishu_complete_task":
      return await feishuClient.completeTask(args.taskId);

    case "feishu_get_task_list":
      return await feishuClient.getTaskList();

    // Bitable
    case "feishu_create_bitable":
      return await feishuClient.createBitable(args.name, args.folderToken || '');

    case "feishu_get_bitable":
      return await feishuClient.getBitable(args.appToken);

    case "feishu_create_bitable_table":
      return await feishuClient.createBitableTable(args.appToken, args.tableName);

    case "feishu_get_bitable_records":
      return await feishuClient.getBitableRecords(args.appToken, args.tableId);

    case "feishu_add_bitable_record":
      return await feishuClient.createBitableRecord(args.appToken, args.tableId, args.fields);

    case "feishu_update_bitable_record":
      return await feishuClient.updateBitableRecord(args.appToken, args.tableId, args.recordId, args.fields);

    case "feishu_delete_bitable_record":
      return await feishuClient.deleteBitableRecord(args.appToken, args.tableId, args.recordId);

    // Drive
    case "feishu_get_file_list":
      return await feishuClient.getFileList(args.folderToken || '');

    // Search
    case "feishu_search_docs":
      return await feishuClient.searchDocs(args.query, args.count || 20);

    case "feishu_search_messages":
      return await feishuClient.searchMessages(args.query, args.count || 20);

    default:
      throw new Error(`Unknown Feishu tool: ${toolName}`);
  }
}

// ===== Tool Definitions for Agent =====

export const feishuTools = [
  // Messaging
  {
    name: "feishu_send_message",
    description: "Send a text message to a Feishu user or chat. Use this when the user asks to send a message to someone.",
    parameters: {
      type: "object",
      properties: {
        receiveId: { type: "string", description: "User open_id or chat_id" },
        text: { type: "string", description: "Message text to send" },
        receiveType: { type: "string", enum: ["open_id", "chat_id", "user_id", "union_id"], default: "open_id", description: "ID type" }
      },
      required: ["receiveId", "text"]
    }
  },
  {
    name: "feishu_reply_message",
    description: "Reply to a specific Feishu message",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID to reply to" },
        text: { type: "string", description: "Reply text" }
      },
      required: ["messageId", "text"]
    }
  },
  {
    name: "feishu_recall_message",
    description: "Recall (delete) a Feishu message",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID to recall" }
      },
      required: ["messageId"]
    }
  },

  // Chat/Group
  {
    name: "feishu_create_chat",
    description: "Create a new Feishu group chat",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Group name" },
        description: { type: "string", description: "Group description" }
      },
      required: ["name"]
    }
  },
  {
    name: "feishu_get_chat",
    description: "Get Feishu group chat information",
    parameters: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Chat ID" }
      },
      required: ["chatId"]
    }
  },
  {
    name: "feishu_add_chat_members",
    description: "Add members to a Feishu group chat",
    parameters: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Chat ID" },
        memberIds: { type: "array", items: { type: "string" }, description: "Member IDs to add" }
      },
      required: ["chatId", "memberIds"]
    }
  },
  {
    name: "feishu_remove_chat_members",
    description: "Remove members from a Feishu group chat",
    parameters: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Chat ID" },
        memberIds: { type: "array", items: { type: "string" }, description: "Member IDs to remove" }
      },
      required: ["chatId", "memberIds"]
    }
  },
  {
    name: "feishu_get_chat_members",
    description: "Get members of a Feishu group chat",
    parameters: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Chat ID" }
      },
      required: ["chatId"]
    }
  },

  // User/Contact
  {
    name: "feishu_get_user_info",
    description: "Get Feishu user information",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID" }
      },
      required: ["userId"]
    }
  },
  {
    name: "feishu_search_users",
    description: "Search Feishu users by name or email",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" }
      },
      required: ["query"]
    }
  },

  // Document
  {
    name: "feishu_create_document",
    description: "Create a new Feishu document. Use this when the user asks to create a doc/document.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title" },
        folderToken: { type: "string", description: "Folder token (optional)" }
      },
      required: ["title"]
    }
  },
  {
    name: "feishu_get_document",
    description: "Get Feishu document metadata",
    parameters: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "feishu_get_document_content",
    description: "Get Feishu document content",
    parameters: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" }
      },
      required: ["documentId"]
    }
  },

  // Sheet
  {
    name: "feishu_create_sheet",
    description: "Create a new Feishu spreadsheet. Use this when the user asks to create a sheet/spreadsheet.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Spreadsheet title" },
        folderToken: { type: "string", description: "Folder token (optional)" }
      },
      required: ["title"]
    }
  },
  {
    name: "feishu_get_sheet",
    description: "Get Feishu spreadsheet metadata",
    parameters: {
      type: "object",
      properties: {
        spreadsheetToken: { type: "string", description: "Spreadsheet token" }
      },
      required: ["spreadsheetToken"]
    }
  },
  {
    name: "feishu_get_sheet_values",
    description: "Get values from a Feishu spreadsheet range",
    parameters: {
      type: "object",
      properties: {
        spreadsheetToken: { type: "string", description: "Spreadsheet token" },
        range: { type: "string", description: "Cell range (e.g., 'Sheet1!A1:B2')" }
      },
      required: ["spreadsheetToken", "range"]
    }
  },
  {
    name: "feishu_update_sheet_values",
    description: "Update values in a Feishu spreadsheet",
    parameters: {
      type: "object",
      properties: {
        spreadsheetToken: { type: "string", description: "Spreadsheet token" },
        range: { type: "string", description: "Cell range" },
        values: { type: "array", description: "2D array of values" }
      },
      required: ["spreadsheetToken", "range", "values"]
    }
  },
  {
    name: "feishu_append_sheet_values",
    description: "Append values to a Feishu spreadsheet",
    parameters: {
      type: "object",
      properties: {
        spreadsheetToken: { type: "string", description: "Spreadsheet token" },
        range: { type: "string", description: "Cell range" },
        values: { type: "array", description: "2D array of values" }
      },
      required: ["spreadsheetToken", "range", "values"]
    }
  },

  // Calendar
  {
    name: "feishu_create_calendar",
    description: "Create a new Feishu calendar",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Calendar name" },
        description: { type: "string", description: "Calendar description" }
      },
      required: ["summary"]
    }
  },
  {
    name: "feishu_get_calendar_list",
    description: "Get list of Feishu calendars",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "feishu_create_calendar_event",
    description: "Create a calendar event. Use this when the user asks to schedule a meeting/event.",
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID" },
        summary: { type: "string", description: "Event title" },
        startTime: { type: "string", description: "Start time (ISO 8601 format)" },
        endTime: { type: "string", description: "End time (ISO 8601 format)" },
        description: { type: "string", description: "Event description" }
      },
      required: ["calendarId", "summary", "startTime", "endTime"]
    }
  },
  {
    name: "feishu_get_calendar_event",
    description: "Get a calendar event",
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID" },
        eventId: { type: "string", description: "Event ID" }
      },
      required: ["calendarId", "eventId"]
    }
  },
  {
    name: "feishu_update_calendar_event",
    description: "Update a calendar event",
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID" },
        eventId: { type: "string", description: "Event ID" },
        updates: { type: "object", description: "Fields to update" }
      },
      required: ["calendarId", "eventId", "updates"]
    }
  },
  {
    name: "feishu_delete_calendar_event",
    description: "Delete a calendar event",
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID" },
        eventId: { type: "string", description: "Event ID" }
      },
      required: ["calendarId", "eventId"]
    }
  },

  // Task
  {
    name: "feishu_create_task",
    description: "Create a Feishu task. Use this when the user asks to create a task/todo.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" }
      },
      required: ["summary"]
    }
  },
  {
    name: "feishu_get_task",
    description: "Get a Feishu task",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" }
      },
      required: ["taskId"]
    }
  },
  {
    name: "feishu_update_task",
    description: "Update a Feishu task",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
        updates: { type: "object", description: "Fields to update" }
      },
      required: ["taskId", "updates"]
    }
  },
  {
    name: "feishu_complete_task",
    description: "Mark a Feishu task as complete",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" }
      },
      required: ["taskId"]
    }
  },
  {
    name: "feishu_get_task_list",
    description: "Get list of Feishu tasks",
    parameters: {
      type: "object",
      properties: {}
    }
  },

  // Bitable
  {
    name: "feishu_create_bitable",
    description: "Create a Feishu Bitable (multi-dimensional table)",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bitable name" },
        folderToken: { type: "string", description: "Folder token (optional)" }
      },
      required: ["name"]
    }
  },
  {
    name: "feishu_get_bitable",
    description: "Get Feishu Bitable metadata",
    parameters: {
      type: "object",
      properties: {
        appToken: { type: "string", description: "Bitable app token" }
      },
      required: ["appToken"]
    }
  },
  {
    name: "feishu_create_bitable_table",
    description: "Create a table in Feishu Bitable",
    parameters: {
      type: "object",
      properties: {
        appToken: { type: "string", description: "Bitable app token" },
        tableName: { type: "string", description: "Table name" }
      },
      required: ["appToken", "tableName"]
    }
  },
  {
    name: "feishu_get_bitable_records",
    description: "Get records from Feishu Bitable",
    parameters: {
      type: "object",
      properties: {
        appToken: { type: "string", description: "Bitable app token" },
        tableId: { type: "string", description: "Table ID" }
      },
      required: ["appToken", "tableId"]
    }
  },
  {
    name: "feishu_add_bitable_record",
    description: "Add a record to Feishu Bitable",
    parameters: {
      type: "object",
      properties: {
        appToken: { type: "string", description: "Bitable app token" },
        tableId: { type: "string", description: "Table ID" },
        fields: { type: "object", description: "Record fields" }
      },
      required: ["appToken", "tableId", "fields"]
    }
  },
  {
    name: "feishu_update_bitable_record",
    description: "Update a record in Feishu Bitable",
    parameters: {
      type: "object",
      properties: {
        appToken: { type: "string", description: "Bitable app token" },
        tableId: { type: "string", description: "Table ID" },
        recordId: { type: "string", description: "Record ID" },
        fields: { type: "object", description: "Fields to update" }
      },
      required: ["appToken", "tableId", "recordId", "fields"]
    }
  },
  {
    name: "feishu_delete_bitable_record",
    description: "Delete a record from Feishu Bitable",
    parameters: {
      type: "object",
      properties: {
        appToken: { type: "string", description: "Bitable app token" },
        tableId: { type: "string", description: "Table ID" },
        recordId: { type: "string", description: "Record ID" }
      },
      required: ["appToken", "tableId", "recordId"]
    }
  },

  // Drive
  {
    name: "feishu_get_file_list",
    description: "Get file list from Feishu Drive",
    parameters: {
      type: "object",
      properties: {
        folderToken: { type: "string", description: "Folder token (optional)" }
      }
    }
  },

  // Search
  {
    name: "feishu_search_docs",
    description: "Search Feishu documents. Use this when the user asks to search for docs/files.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results (default 20)" }
      },
      required: ["query"]
    }
  },

];

// ===== Cordis Plugin Definition =====

export const name = "feishu-bot";

export const inject = [
  "webServer",
  "webhookRuntime",
  "tools",
  "credentials",
  "connection"
];

export const Config = z.object({
  // Webhook config
  source: z.string().default("primary-feishu"),
  connectionMode: z.union(["webhook", "websocket"]).default("webhook"),
  path: z.string().default("/webhook/feishu"),
  verificationToken: z.string().role("credential-ref").default("FEISHU_VERIFICATION_TOKEN"),
  encryptKey: z.string().role("credential-ref").default("FEISHU_ENCRYPT_KEY"),
  configFile: z.string(),
  publicBaseUrl: z.string().default(""),
  tunnelProvider: z.union(["ngrok", "cloudflare", "custom"]).default("ngrok"),
  ngrokDomain: z.string().default(""),
  ngrokAuthtokenEnv: z.string().default("NGROK_AUTHTOKEN"),
  maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1024 * 1024),

  // Feishu API config
  appIdEnv: z.string().default("FEISHU_APP_ID"),
  appSecretEnv: z.string().default("FEISHU_APP_SECRET"),

  // Agent config
  workspacePath: z.string().default(process.cwd()),
  agentPreset: z.string().default("standard"),
  permissionPreset: z.string().default("workspace-write"),
  model: z.object({
    provider: z.string().required(),
    model: z.string().required(),
    maxTokens: z.number()
  }).default(undefined),

  // Scheduled tasks config
  scheduledTasks: z.array(z.object({
    name: z.string(),
    cron: z.string(),
    receiveId: z.string(),
    receiveType: z.union(["open_id", "chat_id", "user_id", "union_id"]).default("open_id"),
    prompt: z.string(),
    enabled: z.boolean().default(true)
  })).default([])
});

function assertConfig(config) {
  if (config.source.trim() !== config.source || config.source === "") {
    throw new Error("feishu-bot source must be a non-empty trimmed string");
  }
  if (!config.path.startsWith("/") || config.path === "/" || config.path.endsWith("/") || config.path.includes("?") || config.path.includes("#")) {
    throw new Error("feishu-bot path must be an absolute non-root pathname without a trailing slash, query, or fragment");
  }
}

export async function apply(ctx, config) {
  assertConfig(config);

  // Create Feishu API client
  const feishuClient = new FeishuClient(ctx, config);
  let transport;
  const management = await createManagement(ctx, config, feishuClient, {
    onConfigChanged: () => transport?.reconcile(),
    getConnectionStatus: () => transport?.status() ?? { mode: config.connectionMode, state: 'starting', message: '正在初始化连接' },
  });
  ctx.provide("feishuBot", management);

  // Register tools and bridge the webhook-created Session's final answer back to Feishu.
  const disposeRule = installFeishuRuntime(ctx, config, feishuClient, feishuTools, executeFeishuTool);

  const receiveEvent = createFeishuEventReceiver(ctx, config);
  transport = createTransport(ctx, config, receiveEvent);
  ctx.effect(() => () => transport.dispose(), "feishu-bot: connection cleanup");

  // Register HTTP route
  const route = {
    kind: "exact",
    path: config.path,
    handler: createFeishuWebhookHandler(ctx, config, receiveEvent)
  };

  const disposeRoute = ctx.effect(() => ctx.webServer.register(route), `feishu-bot: ${config.path}`);

  ctx.effect(() => disposeRule, "feishu-bot: runtime cleanup");
  await transport.reconcile();
}
