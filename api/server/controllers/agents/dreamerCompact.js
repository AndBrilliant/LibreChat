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
 *  by content match.
 *  20260901: `noCatchup` (continuous mode) sends X-Dreamer-Catchup: never — the
 *  send must NOT block on a catch-up fold; memory is taken as-is and the response's
 *  `coverage.folded_through` tells us how far the fold currently reaches, so the
 *  caller keeps any not-yet-folded tail verbatim. Returns { meta, coverage }. */
async function fetchDreamerMeta(conversationId, noCatchup) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DREAMER_TIMEOUT_MS);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Conversation-Id': conversationId || '',
    };
    if (noCatchup) {
      headers['X-Dreamer-Catchup'] = 'never';
    }
    const res = await fetch(DREAMER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: 'adr-dreamer-compress',
        stream: false,
        messages: [{ role: 'user', content: 'compact' }],
      }),
    });
    if (!res.ok) {
      return { meta: null, coverage: null };
    }
    const json = await res.json();
    const meta = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : null;
    return {
      meta: typeof meta === 'string' && meta.trim() ? meta : null,
      coverage: (json && json.coverage) || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Per-chat continuous-compaction mode (the spy popover toggle; stored on the
 *  conversation doc by the dreamer service). Localhost read, fails open to off. */
async function fetchConversationMode(conversationId) {
  try {
    const base = DREAMER_URL.replace(/\/v1\/chat\/completions$/, '');
    const res = await fetch(`${base}/api/mode?cid=${encodeURIComponent(conversationId || '')}`, {
      signal: AbortSignal.timeout(4000),
    });
    const j = await res.json();
    if (j && j.ok) {
      return { continuous: !!j.continuous, retainTurns: Number(j.retain_turns) || 4 };
    }
  } catch {
    /* mode service unreachable -> pressure-only behavior */
  }
  return { continuous: false, retainTurns: 4 };
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
  msgMeta,          // parallel array (index-aligned with payload): {id, createdAt, role}
  continuous,       // 20260901: per-chat "continuous compaction mode"
  retainTurns,      // verbatim floor in turns (default 3; continuous default 4)
  onStart,          // optional UI signal: fired when a compaction actually begins
}) {
  const window = Number(maxContextTokens) || 0;
  if (!window || !Array.isArray(payload) || payload.length < 3) {
    return { compacted: false };
  }

  /** Auto-compact once the full thread crosses 85% of the window; "Compact now"
   *  lowers the bar to "there is meaningfully more here than a fresh chat". */
  /* ADR: Compact now (force) ALWAYS compacts, whatever the model window.
   *  20260901: continuous mode compacts EVERY send — memory from the beginning of
   *  the thread + the last retainTurns verbatim, every single time. */
  const needed = (force || continuous) ? true : promptTokenTotal > Math.floor(window * 0.85);
  if (!needed) {
    return { compacted: false };
  }

  /** Signal the client that a compaction is underway (the "compressing please
   *  wait" state) — fired before the meta fetch, which is where any wait lives.
   *  client.js emits on_summarize_start/complete around this. */
  if (typeof onStart === 'function') {
    try {
      onStart();
    } catch {
      /* a UI signal must never break compaction */
    }
  }

  /** Non-blocking first, ALWAYS: take memory as-is and let the zero-loss rule
   *  (unfolded tail rides verbatim) cover whatever the daemon hasn't folded yet.
   *  The blocking catch-up fold is reserved for when the daemon is genuinely
   *  far behind (cold chat or lag > 8) — previously EVERY auto compaction
   *  blocked the send for 2-3 silent minutes while photek crawled through a
   *  fold, which read as "the chat is down". */
  let { meta, coverage } = await fetchDreamerMeta(conversationId, true);
  if (!meta || !coverage || Number(coverage.lag) > 8) {
    const blocking = await fetchDreamerMeta(conversationId, false);
    if (blocking.meta) {
      meta = blocking.meta;
      coverage = blocking.coverage || coverage;
    }
  }
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

  /** 20260909 SIZE-DRIVEN TRUNCATION (new architecture): the verbatim tail is a
   *  TOKEN BUDGET filled with as many COMPLETE both-side turns as fit — no
   *  turn-count cap. Floor: TURN_FLOOR complete turns verbatim; if even the
   *  floor overflows the budget, keep fewer turns and mark the cut with
   *  ---truncated here---. Everything older rides the dreamer memory.
   *
   *  20260909b TOTAL BUNDLE CAP (Drew's design): compression + verbatim TOGETHER
   *  are capped at TOTAL_BUDGET (default 80K of the 256K window) — the tail
   *  budget is what remains AFTER the meta summary is paid for, so the whole
   *  post-compaction bundle never crowds out the working window. */
  const TOTAL_BUDGET = Math.max(20000, Number(process.env.DREAMER_TOTAL_BUDGET) || 80000);
  const TAIL_BUDGET = Math.max(8000, TOTAL_BUDGET - metaTokens);
  const TURN_FLOOR = Number(retainTurns) > 0 ? Number(retainTurns) : 4;

  /** Group the tail into complete turns, newest first. A turn starts at a user
   *  message and runs to the next-older user message (or the head fragment). */
  const turns = [];
  let tEnd = payload.length;
  for (let i = payload.length - 1; i >= 0; i--) {
    if (payload[i] && payload[i].role === 'user') {
      let tok = 0;
      for (let j = i; j < tEnd; j++) {
        tok += Number(indexTokenCountMap[j]) || 0;
      }
      turns.push({ start: i, end: tEnd - 1, tok });
      tEnd = i;
    }
  }

  /** 20260901 ZERO-LOSS RULE (continuous): any message newer than the fold's reach
   *  (coverage.folded_through) rides verbatim even if it's older than the retained
   *  tail — the dreamer being N turns behind just means N extra verbatim messages;
   *  the badge/spy shows the lag, the send never blocks and never loses a turn. */
  const foldedThrough = coverage && coverage.folded_through
    ? String(coverage.folded_through) : null;
  const unfoldedFrom = (() => {
    if (!foldedThrough || !Array.isArray(msgMeta)) return null;
    for (let i = 0; i < msgMeta.length; i++) {
      const ts = msgMeta[i] && msgMeta[i].createdAt;
      if (ts && String(ts) > foldedThrough) {
        return i;   // first not-yet-folded message (ISO strings compare lexically)
      }
    }
    return null;
  })();

  /** Fill the budget with complete turns (newest first). The NEWEST turn is
   *  sacred (Drew's rule 2026-09-09): it is always kept whole — only if it
   *  alone overflows the whole context window do we cut into it (the fallback
   *  below). Budget is a design target; the live turn is not negotiable. */
  let floorStart = payload.length;
  let used = 0;
  let keptTurns = 0;
  let truncated = false;
  for (const t of turns) {
    if (used + t.tok <= TAIL_BUDGET || keptTurns === 0) {
      floorStart = t.start;
      used += t.tok;
      keptTurns += 1;
    } else {
      if (keptTurns < TURN_FLOOR) {
        truncated = true;
      }
      break;
    }
  }
  if (keptTurns < TURN_FLOOR) {
    truncated = true;
  }
  if (floorStart === payload.length) {
    /** roles unavailable (or the newest turn alone overflows): fall back to a
     *  message-count floor, still budget-capped. */
    floorStart = payload.length;
    used = 0;
    for (let i = payload.length - 1; i >= 0 && i >= payload.length - 4; i--) {
      const tok = Number(indexTokenCountMap[i]) || 0;
      if (used + tok > TAIL_BUDGET) {
        truncated = true;
        break;
      }
      floorStart = i;
      used += tok;
    }
    if (floorStart === payload.length) {
      floorStart = payload.length - 1;  // never compact away the live edge itself
      used = Number(indexTokenCountMap[floorStart]) || 0;
      truncated = true;
    }
  }

  /** Keep everything at/after the truncation point (plus the zero-loss unfolded
   *  span in continuous mode). Older messages ride the memory only. */
  const hardKeepFrom = unfoldedFrom != null ? Math.min(floorStart, unfoldedFrom) : floorStart;
  const keep = [];
  used = 0;
  for (let i = payload.length - 1; i >= hardKeepFrom; i--) {
    const tok = Number(indexTokenCountMap[i]) || 0;
    keep.push({ idx: i, tok });
    used += tok;
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
      '[COMPACTED CONTEXT — earlier turns replaced by reconstructive memory]\n\n' + meta +
      (truncated
        ? '\n\n---truncated here--- (the verbatim thread below was cut short of the ' +
          `${TURN_FLOOR}-turn floor to fit the context window; everything older is in the memory above)`
        : ''),
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
    floorTurns: keptTurns,
    truncated,
    tailBudget: TAIL_BUDGET,
    unfoldedKept: unfoldedFrom != null ? Math.max(0, floorStart - unfoldedFrom) : 0,
    continuous: continuous === true,
    meta,
    metaTokens,
  };
}

module.exports = { dreamerCompact, fetchConversationMode };
