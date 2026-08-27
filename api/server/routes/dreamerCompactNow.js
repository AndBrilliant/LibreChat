/**
 * ADR fork — on-demand "Compact now" endpoint.
 *
 * The turn-time reconstructive compaction (controllers/agents/dreamerCompact.js)
 * only takes effect when a turn assembles the payload. This route makes the
 * "Compact now" button actually compact ON CLICK, with no turn:
 *   1. ask the dreamer for THIS conversation's compressed memory
 *   2. persist a `summary` content-block checkpoint after the current leaf
 * The gauge + client.js already treat a `summary` part as "stands in for every
 * older turn", so the context visibly drops the instant the checkpoint lands.
 * The full thread stays in Mongo (nothing lost); the model drills back via
 * rehydrate_node / dream_recall / dream_search on later turns.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { ContentTypes } = require('librechat-data-provider');
const { countTokens } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const DREAMER_URL =
  process.env.DREAMER_COMPRESS_URL || 'http://host.docker.internal:8095/v1/chat/completions';
const TIMEOUT_MS = Number(process.env.DREAMER_COMPRESS_TIMEOUT_MS) || 600000;

async function fetchDreamerMeta(conversationId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(DREAMER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Conversation-Id': conversationId || '' },
      body: JSON.stringify({
        model: 'adr-dreamer-compress',
        stream: false,
        messages: [{ role: 'user', content: 'compact' }],
      }),
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json();
    const meta =
      json && json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content
        : null;
    return typeof meta === 'string' && meta.trim() ? meta : null;
  } finally {
    clearTimeout(timer);
  }
}

const router = express.Router();
router.use(requireJwtAuth);

router.post('/', async (req, res) => {
  const conversationId = req.body && req.body.conversationId;
  const userId = req.user && req.user.id;
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId required' });
  }
  try {
    const messages = await db.getMessages({ conversationId, user: userId });
    if (!messages || messages.length === 0) {
      return res.status(404).json({ error: 'no messages for conversation' });
    }
    /* leaf = the newest message on the active branch (parent of nothing) */
    const parentIds = new Set(messages.map((m) => m.parentMessageId));
    const leaves = messages.filter((m) => m.messageId && !parentIds.has(m.messageId));
    const leaf =
      leaves.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ||
      messages[messages.length - 1];

    const meta = await fetchDreamerMeta(conversationId);
    if (!meta) {
      return res.status(502).json({ error: 'dreamer returned no memory (fold may be pending)' });
    }

    let metaTokens = Math.ceil((meta.length || 4) / 4);
    try {
      const c = countTokens(meta);
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
        metaTokens = c;
      }
    } catch {
      /* keep estimate */
    }
    metaTokens = Math.max(1, metaTokens);

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
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: header + meta }],
          tokenCount: metaTokens,
          provider: 'dreamerCompress',
          model: 'adr-dreamer-compress',
          summarizing: false,
          summaryVersion: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      tokenCount: metaTokens,
    };

    const saved = await db.saveMessage(
      { userId, isTemporary: false },
      newMessage,
      { context: 'POST /api/dreamer/compact-now' },
    );
    if (!saved) {
      return res.status(500).json({ error: 'failed to save checkpoint' });
    }
    logger.info(
      `[compact-now] ${conversationId}: checkpoint ${newMessage.messageId} after ${leaf.messageId} (~${metaTokens} tok)`,
    );
    return res.status(201).json({ compacted: true, metaTokens, messageId: newMessage.messageId });
  } catch (err) {
    logger.error('[compact-now] error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
});

module.exports = router;
