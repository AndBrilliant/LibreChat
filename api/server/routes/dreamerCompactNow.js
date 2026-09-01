/**
 * ADR fork — on-demand "Compact now", STREAMING.
 *
 * Returns a Server-Sent-Events stream so the button can show the compaction
 * happening live, chunk by chunk:
 *   1. proxy the dreamer's streaming fold (forward each {phase:'chunk', i, n, ...})
 *   2. when the fold's meta is ready, persist a `summary` checkpoint after the leaf
 *   3. emit {phase:'complete', metaTokens} and close
 * The catch-up fold runs SYNCHRONOUSLY on the dreamer side (compaction waits for a
 * complete tree). Full thread stays in Mongo; model drills back via rehydrate_node.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { ContentTypes } = require('librechat-data-provider');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const DREAMER_URL =
  process.env.DREAMER_COMPRESS_URL || 'http://host.docker.internal:8095/v1/chat/completions';
const TIMEOUT_MS = Number(process.env.DREAMER_COMPRESS_TIMEOUT_MS) || 900000;

const router = express.Router();
router.use(requireJwtAuth);

router.post('/', async (req, res) => {
  const conversationId = req.body && req.body.conversationId;
  const userId = req.user && req.user.id;
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId required' });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity'); // defeat compression buffering
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const send = (o) => {
    try {
      res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (typeof res.flush === 'function') res.flush(); // force past compression
    } catch { /* client gone */ }
  };
  // kick the stream open immediately so the browser/proxy commits to SSE
  try { res.write(': open\n\n'); if (typeof res.flush === 'function') res.flush(); } catch { /* */ }
  send({ phase: 'opening', conversationId });

  // find the leaf so the checkpoint attaches to the current tip
  let leaf = null;
  try {
    const messages = await db.getMessages({ conversationId, user: userId });
    if (messages && messages.length) {
      const parentIds = new Set(messages.map((m) => m.parentMessageId));
      const leaves = messages.filter((m) => m.messageId && !parentIds.has(m.messageId));
      leaf = leaves.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ||
        messages[messages.length - 1];
    }
  } catch (e) {
    send({ phase: 'error', error: 'could not load conversation' });
    return res.end();
  }
  if (!leaf) {
    send({ phase: 'error', error: 'no messages for conversation' });
    return res.end();
  }

  // proxy the dreamer's streaming fold
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let meta = '';
  try {
    const upstream = await fetch(DREAMER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Conversation-Id': conversationId },
      body: JSON.stringify({ model: 'adr-dreamer-compress', stream: true,
        messages: [{ role: 'user', content: 'compact' }] }),
    });
    if (!upstream.ok || !upstream.body) {
      throw new Error(`dreamer ${upstream.status}`);
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.phase === 'chunk' || obj.phase === 'start' || obj.phase === 'error') {
          send(obj); // forward live progress to the browser
        } else if (obj.phase === 'done') {
          meta = obj.meta || '';
        }
      }
    }
  } catch (e) {
    send({ phase: 'error', error: String((e && e.message) || e) });
  } finally {
    clearTimeout(timer);
  }

  // persist the checkpoint
  let metaTokens = 0;
  try {
    if (meta && meta.trim()) {
      metaTokens = Math.ceil(meta.length / 4);
      const header =
        '⏱ **Compact now** — earlier turns folded into reconstructive memory · ' +
        `dreamer memory ≈ ${metaTokens} tokens (full thread still in the store; drill back any time)\n\n`;
      const newMessage = {
        messageId: uuidv4(),
        conversationId,
        parentMessageId: leaf.messageId,
        sender: 'Dreamer',
        isCreatedByUser: false,
        model: 'adr-dreamer-compress',
        endpoint: leaf.endpoint,
        user: userId,
        unfinished: false,
        error: false,
        text: '',
        content: [{
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: header + meta }],
          tokenCount: metaTokens,
          provider: 'dreamerCompress',
          model: 'adr-dreamer-compress',
          summarizing: false,
          summaryVersion: 1,
          createdAt: new Date().toISOString(),
        }],
        tokenCount: metaTokens,
      };
      await db.saveMessage({ userId, isTemporary: false }, newMessage,
        { context: 'POST /api/dreamer/compact-now (stream)' });
      logger.info(`[compact-now] ${conversationId}: checkpoint ~${metaTokens} tok after ${leaf.messageId}`);
    }
  } catch (e) {
    send({ phase: 'error', error: 'saved fold but checkpoint failed: ' + String((e && e.message) || e) });
  }

  send({ phase: 'complete', compacted: !!(meta && meta.trim()), metaTokens });
  try { res.write('data: [DONE]\n\n'); } catch { /* */ }
  res.end();
});

module.exports = router;
