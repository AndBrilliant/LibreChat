const { logger } = require('@librechat/data-schemas');

/**
 * ADR fork — reconstructive compaction ("redo it how we like").
 *
 * Replaces LibreChat's SDK-side summarization budget math — which feeds the
 * summarizer only the reloaded ~window of the thread and then applies its
 * reserve ratio twice, leaving a fragile tuning band on small-window models —
 * with a stateless injection: when the FULL thread would overflow the model
 * window (or the user pressed "Compact now"), we ask the dreamer for the
 * current compressed memory of THIS conversation and send
 *
 *     [ dreamer memory ] + [ recent tail that fits ]
 *
 * instead of the whole thread. The dream tree is kept current by the background
 * daemon, so building the memory is pure assembly (~1s) and can run every turn.
 * Nothing is persisted or lost: the full thread stays in Mongo, and the model
 * drills back through rehydrate_node / dream_recall / dream_search.
 *
 * Fail-safe by construction: any error, empty memory, or "nothing to drop"
 * returns { compacted: false } so the normal SDK path still runs.
 */

const DREAMER_URL =
  process.env.DREAMER_COMPRESS_URL || 'http://host.docker.internal:8095/v1/chat/completions';
const DREAMER_TIMEOUT_MS = Number(process.env.DREAMER_COMPRESS_TIMEOUT_MS) || 600000; // ADR: sync catch-up fold can take minutes; wait for a COMPLETE summary (was 15000)

/** Ask the dreamer for this conversation's compressed memory. The
 *  X-Conversation-Id header is the one-line "fork patch" that was missing —
 *  it lets build_meta read the right folded tree directly instead of guessing
 *  by content match. */
async function fetchDreamerMeta(conversationId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DREAMER_TIMEOUT_MS);
  try {
    const res = await fetch(DREAMER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Conversation-Id': conversationId || '',
      },
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
    const meta = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : null;
    return typeof meta === 'string' && meta.trim() ? meta : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Object}   p
 * @param {Array}    p.payload              full formatted thread (index-aligned with indexTokenCountMap)
 * @param {Object}   p.indexTokenCountMap   { index -> token count }; MUTATED IN PLACE on success
 * @param {number}   p.promptTokenTotal     total tokens of the full thread
 * @param {number}   p.maxContextTokens     the model's context window
 * @param {string}   p.conversationId
 * @param {boolean}  p.force                user pressed "Compact now"
 * @param {(t:string)=>number} p.countFn    token counter
 * @returns {Promise<{compacted:boolean, payload?:Array, promptTokens?:number, droppedCount?:number}>}
 */
async function dreamerCompact({
  payload,
  indexTokenCountMap,
  promptTokenTotal,
  maxContextTokens,
  conversationId,
  force,
  countFn,
}) {
  const window = Number(maxContextTokens) || 0;
  if (!window || !Array.isArray(payload) || payload.length < 3) {
    return { compacted: false };
  }

  /** Auto-compact once the full thread crosses 85% of the window; "Compact now"
   *  lowers the bar to "there is meaningfully more here than a fresh chat". */
  /* ADR: Compact now (force) ALWAYS compacts, whatever the model window. */
  const needed = force ? true : promptTokenTotal > Math.floor(window * 0.85);
  if (!needed) {
    return { compacted: false };
  }

  const meta = await fetchDreamerMeta(conversationId);
  if (!meta) {
    return { compacted: false };
  }
  /** Char-based estimate is the robust default (~4 chars/token); refine with the
   *  real counter only when it returns a finite sync number (countTokens can be
   *  async / worker-backed here, which would poison the arithmetic with NaN). */
  let metaTokens = Math.ceil((meta.length || 4) / 4);
  if (countFn) {
    try {
      const c = countFn(meta);
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
        metaTokens = c;
      }
    } catch {
      /* keep the estimate */
    }
  }
  metaTokens = Math.max(1, metaTokens);

  /** How much recent tail to keep verbatim. Force keeps a tight recent window;
   *  auto keeps up to ~75% of the model window. The remaining share is left as
   *  headroom for the response + tool/instruction overhead. */
  /* ADR: aggressive compression. The reconstructive meta summary carries the
   * older context, so we keep only a small verbatim tail (~15% of window) on
   * top of the hard RETAIN_TURNS floor. Was 0.75, which barely compressed. */
  const TAIL_FRACTION = 0.15;
  const tailBudget = force ? 0 : Math.floor(window * TAIL_FRACTION) - metaTokens;

  /** Hard floor: always keep the last `RETAIN_TURNS` full turns verbatim,
   *  regardless of budget, so the model always has the exact recent exchange
   *  (not just a summary of it). A "turn" starts at a user message; we walk
   *  back until we've passed RETAIN_TURNS user messages. Falls back to a
   *  message-count floor if roles aren't present on the formatted payload. */
  const RETAIN_TURNS = 3;
  let usersSeen = 0;
  let floorStart = payload.length - 1;
  for (let i = payload.length - 1; i >= 0; i--) {
    floorStart = i;
    if (payload[i] && payload[i].role === 'user') {
      usersSeen += 1;
      if (usersSeen >= RETAIN_TURNS) {
        break;
      }
    }
  }
  if (usersSeen === 0) {
    /** roles unavailable — keep the last 4 messages (~2 simple turns) */
    floorStart = Math.max(0, payload.length - 4);
  }

  /** Walk newest -> oldest. Everything at/after `floorStart` is force-kept
   *  (the retained-turns floor); older messages are kept until the tail budget
   *  is spent. */
  const keep = [];
  let used = 0;
  for (let i = payload.length - 1; i >= 0; i--) {
    const tok = Number(indexTokenCountMap[i]) || 0;
    if (i >= floorStart || used + tok <= tailBudget) {
      keep.push({ idx: i, tok });
      used += tok;
    } else {
      break;
    }
  }
  keep.reverse();

  /** Nothing would actually be dropped -> not a real compaction; leave the
   *  normal path alone rather than needlessly prepending memory. */
  if (keep.length >= payload.length) {
    return { compacted: false };
  }

  const metaMsg = {
    role: 'system',
    content:
      '[COMPACTED CONTEXT — earlier turns replaced by reconstructive memory]\n\n' + meta,
  };
  const newPayload = [metaMsg, ...keep.map((k) => payload[k.idx])];

  /** Rebuild the index->token map IN PLACE (the caller holds this exact object
   *  and assigns it to this.indexTokenCountMap after we return). */
  for (const key of Object.keys(indexTokenCountMap)) {
    delete indexTokenCountMap[key];
  }
  indexTokenCountMap[0] = metaTokens;
  keep.forEach((k, n) => {
    indexTokenCountMap[n + 1] = k.tok;
  });

  return {
    compacted: true,
    payload: newPayload,
    promptTokens: metaTokens + used,
    droppedCount: payload.length - keep.length,
    retainedVerbatim: keep.length,
    floorMessages: payload.length - floorStart,
    floorTurns: usersSeen,
    meta,
    metaTokens,
  };
}

module.exports = { dreamerCompact };
