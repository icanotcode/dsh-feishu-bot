import { WebhookRuleId } from '@deepseek-ai/dsh-webhook';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

/** Register real Harness tools and use webhook provenance to route final replies. */
export function installFeishuRuntime(ctx, config, client, tools, executeTool) {
  const ruleId = WebhookRuleId(`feishu-message-handler:${config.source}`);
  const pending = new Map();
  const sessions = new Map();
  const disposers = [];
  const indicators = new Set();

  function startTyping(target) {
    // Neither adding nor removing a reaction may delay ingress or an Agent reply.
    // Use an independent timeout: a cancelled turn must still clear its reaction.
    let finished = false;
    let cleanup;
    const added = Promise.resolve().then(() => client.withSignal(AbortSignal.timeout(5000),
      () => client.addMessageReaction(target.messageId, 'Typing'))).catch(() => {
      ctx.logger.warn('feishu-bot: could not add the working reaction; check im:message.reactions:write_only permission and network connectivity');
    });
    const indicator = {
      stop() {
        if (finished) return cleanup;
        finished = true;
        // Waiting here also catches an add request that succeeds after the turn ends.
        cleanup = added.then(async result => {
          if (!result?.reaction_id) return;
          await client.withSignal(AbortSignal.timeout(5000),
            () => client.deleteMessageReaction(target.messageId, result.reaction_id));
        }).catch(() => {
          ctx.logger.warn('feishu-bot: could not remove the working reaction; check reaction permission and network connectivity');
        }).finally(() => indicators.delete(indicator));
        return cleanup;
      }
    };
    indicators.add(indicator);
    target.typing = indicator;
  }

  function finishSession(agent) {
    const target = sessions.get(agent.session.id);
    sessions.delete(agent.session.id);
    void target?.typing?.stop();
  }

  for (const tool of tools) {
    disposers.push(ctx.tools.register({
      ...tool,
      output: {
        schema: { type: 'object', properties: { data: {} }, required: ['data'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.data) }]
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const errors = validateJsonSchemaValue(tool.parameters, args, 'args');
        if (errors.length) throw new TypeError(errors.join('; '));
        const result = await client.withSignal(exec.signal, () => executeTool(tool.name, args, client));
        if (tool.name === 'feishu_reply_message') {
          for (const target of sessions.values()) {
            if (target.messageId === args.messageId) target.replied = true;
          }
        }
        return { data: result ?? null };
      }
    }));
  }

  disposers.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const source = message.source;
    if (source?.kind !== 'webhook' || source.provider !== 'feishu' || source.source !== config.source || source.ruleId !== ruleId) return;
    const target = pending.get(source.deliveryId);
    if (!target) return;
    pending.delete(source.deliveryId);
    void sessions.get(agent.session.id)?.typing?.stop();
    sessions.set(agent.session.id, target);
    startTyping(target);
  }));

  disposers.push(ctx.on('agent/error', ({ agent }) => {
    const target = sessions.get(agent.session.id);
    if (target) {
      target.failed = true;
      void target.typing?.stop();
    }
  }));

  disposers.push(ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const target = sessions.get(agent.session.id);
    if (!target) return;
    sessions.delete(agent.session.id);
    if (signal.aborted || target.replied) {
      void target.typing?.stop();
      return;
    }
    try {
      const messages = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message' && event.data.turn === turn && !event.data.interrupted);
      const latest = messages.at(-1);
      const answer = latest?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
      const text = answer || (target.failed ? '处理失败，请在 DeepSeek Harness 中查看会话错误后重试。' : '本次处理已结束，但没有生成文本回复。请在 DeepSeek Harness 中查看会话。');
      // Keep every request comfortably below the provider's text-message limit.
      const chunks = [];
      let chunk = '';
      let bytes = 0;
      for (const character of text) {
        const size = Buffer.byteLength(character);
        if (bytes + size > 12000) { chunks.push(chunk); chunk = ''; bytes = 0; }
        chunk += character;
        bytes += size;
      }
      if (chunk) chunks.push(chunk);
      await client.withSignal(signal, async () => {
        for (const part of chunks) await client.replyMessage(target.messageId, part);
      });
    } catch {
      ctx.logger.warn('feishu-bot: failed to deliver final reply; the answer remains in the Harness session');
    } finally {
      void target.typing?.stop();
    }
  }));

  // Cancellation and rejected steps can reach idle without a turn-stopping hook.
  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') finishSession(agent);
  }));
  disposers.push(ctx.on('agent/disposed', ({ agent }) => finishSession(agent)));
  const disposeRule = ctx.webhookRuntime.register({
    id: ruleId,
    kind: 'feishu',
    run(delivery, signal) {
      signal.throwIfAborted();
      if (delivery.source !== config.source) return null;
      const parsed = delivery.event?.payload?.parsed;
      if (!parsed?.userText) return null;
      const now = Date.now();
      for (const [id, target] of pending) if (target.expires <= now) pending.delete(id);
      pending.set(delivery.deliveryId, { messageId: parsed.messageId, expires: now + 600000 });
      if (pending.size > 10000) pending.delete(pending.keys().next().value);
      return {
        workspacePath: config.workspacePath,
        title: `Feishu: ${parsed.userText.substring(0, 30)}`,
        prompt: `用户通过飞书发送消息：\n\n${parsed.userText}\n\n当前飞书 chat_id：${parsed.chatId}，message_id：${parsed.messageId}，发送者 open_id：${parsed.senderId}。请处理用户请求；可使用已注册的 feishu_* 工具。你的最终文本答复将由插件自动回复到当前飞书消息，无需另行调用回复工具。`,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        ...(config.model ? { model: config.model } : {})
      };
    }
  });
  return async () => {
    try {
      await disposeRule();
      for (const dispose of disposers.reverse()) await dispose();
    } finally {
      pending.clear();
      sessions.clear();
      await Promise.all([...indicators].map(indicator => indicator.stop()));
    }
  };
}
