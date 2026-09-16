import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { TMessage, TConversation } from 'librechat-data-provider';

/**
 * ADR fork — generation speed HUD. Shows a live tokens/sec rate while a
 * response streams, then freezes on the final average until the next send.
 *
 * Computed entirely client-side from the streaming message's text growth in
 * the react-query cache (tokens ≈ chars/4), so it works for EVERY endpoint
 * and model — no server cooperation required. Renders as a small pill next
 * to the context gauge above the chat input.
 *
 * 2026-09-15 fix: the resumable-stream architecture (useResumableSSE) does
 * not keep ChatForm's isSubmitting true for the life of the turn, so the
 * old isSubmitting-gated sampler never started and the badge stayed hidden.
 * The sampler is now GROWTH-DRIVEN: it keys off the one signal that always
 * tracks generation — the newest assistant message's text actually growing.
 * A 2-consecutive-sample streak guard ignores one-off cache writes
 * (title-gen, finalize rewrites, compaction folds).
 */

const SAMPLE_MS = 400;

function messageTokens(m: TMessage): number {
  if (typeof m.tokenCount === 'number' && m.tokenCount > 0) {
    return m.tokenCount;
  }
  /* reasoning models stream into content parts (think/reasoning + text) —
     count every known text-bearing field so the rate also moves while the
     model is still thinking. Parts nest the payload one level deep:
     { type:'text', text:{ value:'...' } } / { type:'think', think:{ thinking:'...' } },
     so unwrap both plain strings AND {value}/{thinking} containers. */
  const addNested = (v: unknown, depth: number): number => {
    if (depth > 2 || v == null) {
      return 0;
    }
    if (typeof v === 'string') {
      return v.length;
    }
    if (typeof v === 'object') {
      let n = 0;
      for (const val of Object.values(v as Record<string, unknown>)) {
        n += addNested(val, depth + 1);
      }
      return n;
    }
    return 0;
  };
  const PART_KEYS = ['text', 'think', 'thinking', 'reasoning', 'reasoning_content'];
  const content: unknown = (m as { content?: unknown }).content;
  let chars = 0;
  if (Array.isArray(content) && content.length > 0) {
    for (const p of content as Record<string, unknown>[]) {
      if (p && typeof p === 'object') {
        for (const k of PART_KEYS) {
          chars += addNested(p[k], 0);
        }
      }
    }
  }
  const topReasoning = (m as { reasoning_content?: unknown }).reasoning_content;
  if (typeof topReasoning === 'string') {
    chars += topReasoning.length;
  }
  if (chars > 0) {
    return Math.round(chars / 4);
  }
  const text = typeof m.text === 'string' ? m.text : '';
  return Math.round(text.length / 4);
}

export default function TokenSpeedHUD({
  conversation,
  isSubmitting,
}: {
  conversation: TConversation | null;
  isSubmitting: boolean;
}): JSX.Element | null {
  void isSubmitting; // prop retained for call-site compatibility; sampler is growth-driven
  const conversationId = conversation?.conversationId ?? '';
  const queryClient = useQueryClient();
  const [liveRate, setLiveRate] = useState<number | null>(null);
  const [finalRate, setFinalRate] = useState<number | null>(null);
  const [prefill, setPrefill] = useState<{ progress: number; total: number } | null>(null);
  const startRef = useRef(0);
  const prevNRef = useRef(0);
  const turnTokensRef = useRef(0);
  const lastGrowthRef = useRef(0);
  const timingRef = useRef(false);
  const streakRef = useRef(0);

  /* A fresh chat streams under the server-assigned conversation id, not the
     prop's 'new' — so read across ALL message caches and take the newest
     assistant message. Only growth matters, so the streaming message is always
     the one that moves. NOTE: do NOT rank by createdAt — the streaming
     placeholder's createdAt is empty (parses to 0), so timestamp ranking
     silently selects an old completed message and the sampler sees no growth.
     Instead SUM the last assistant message (array order) of every cache:
     completed messages are static, so the sum grows only with the live stream. */
  const readTokens = () => {
    const all = queryClient.getQueriesData<TMessage[]>({ queryKey: [QueryKeys.messages] });
    let total = 0;
    for (const [, msgs] of all) {
      if (!Array.isArray(msgs)) {
        continue;
      }
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.isCreatedByUser === false) {
          total += messageTokens(m);
          break;
        }
      }
    }
    return total;
  };

  /* reset on conversation switch; baseline counts existing text so an old
     chat's content is never mistaken for fresh growth */
  useEffect(() => {
    setLiveRate(null);
    setFinalRate(null);
    timingRef.current = false;
    streakRef.current = 0;
    turnTokensRef.current = 0;
    prevNRef.current = readTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  /* Growth-driven sampler, tuned for the fork's BURSTY cache writes: the
     resumable-stream catch-up lands text in single big setQueryData writes
     seconds apart, not a smooth per-delta trickle. So: ONE growth sample is
     enough to start timing (a 2-sample streak can never form when each burst
     is one write), and the freeze window is 4s so the gaps between bursts do
     not end the turn. Rate = tokens grown / wall time since first growth, so
     burst gaps honestly lower the shown rate (that IS the user-visible speed).
     The stream-close rewrite can transiently shrink text; negative deltas are
     ignored and never counted against the turn. */
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const n = readTokens();
      const dn = n - prevNRef.current;
      prevNRef.current = n;

      if (!timingRef.current) {
        if (dn > 0) {
          timingRef.current = true;
          startRef.current = now;
          lastGrowthRef.current = now;
          turnTokensRef.current = dn;
          setFinalRate(null);
        }
        return;
      }

      if (dn > 0) {
        turnTokensRef.current += dn;
        lastGrowthRef.current = now;
      }
      const elapsed = (now - startRef.current) / 1000;
      if (elapsed > 0.3 && turnTokensRef.current > 0) {
        setLiveRate(turnTokensRef.current / elapsed);
      }
      if (now - lastGrowthRef.current > 4000 && turnTokensRef.current > 0) {
        const el = Math.max(0.5, (lastGrowthRef.current - startRef.current) / 1000);
        setFinalRate(turnTokensRef.current / el);
        setLiveRate(null);
        timingRef.current = false;
        streakRef.current = 0;
        turnTokensRef.current = 0;
      }
    }, SAMPLE_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  /* Ingestion progress bar: llama.cpp exposes real per-slot prompt-processing
     progress via /slots; the gateway fronts it at /athena/prefill. While a
     request is ingesting (slot busy, no tokens decoded yet, progress < 1) the
     UI otherwise shows dead air for MINUTES on big pastes (117K @ ~300 t/s).
     Poll every 1.5s and render a real bar. Multi-slot: take the busiest
     still-ingesting slot. Hidden when the gateway route is absent (LAN-direct)
     or nothing is ingesting. Prefix-cache hits count as ingested (they are,
     from the user's point of view). */
  useEffect(() => {
    let dead = false;
    const poll = async () => {
      try {
        const r = await fetch('/athena/prefill');
        if (!r.ok) {
          throw new Error('no route');
        }
        const j = (await r.json()) as {
          slots?: {
            processing: boolean;
            total: number;
            processed: number;
            cached: number;
            decoded: number;
            progress: number | null;
          }[];
        };
        if (dead) {
          return;
        }
        const ingesting = (j.slots ?? []).filter(
          (s) => s.processing && s.progress != null && s.progress < 1 && s.decoded === 0,
        );
        if (ingesting.length > 0) {
          const s = ingesting.reduce((a, b) => (a.total >= b.total ? a : b));
          setPrefill({ progress: s.progress ?? 0, total: s.total });
        } else {
          setPrefill(null);
        }
      } catch {
        if (!dead) {
          setPrefill(null);
        }
      }
    };
    const id = setInterval(poll, 1500);
    poll();
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [conversationId]);

  const rate = liveRate ?? finalRate;
  const frozen = liveRate == null;
  const label =
    rate != null && rate > 0
      ? `⚡ ${rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)} tok/s`
      : '';
  const pct = prefill != null ? Math.round(prefill.progress * 100) : 0;

  return (
    <span className="ml-1 flex select-none items-center whitespace-nowrap">
      {prefill != null && (
        <span
          data-testid="prefill-hud"
          title={`ingesting prompt: ${pct}% of ~${prefill.total.toLocaleString()} tokens`}
          aria-live="polite"
          className="mr-1 flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-text-secondary"
        >
          ⏳ {pct}%
          <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-border-medium">
            <span
              className="absolute left-0 top-0 h-full rounded-full bg-text-secondary transition-all duration-1000"
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
      )}
      {rate != null && rate > 0 && (
        <span
          data-testid="token-speed-hud"
          title={frozen ? `final average: ${label}` : `live: ${label}`}
          aria-live="polite"
          className="flex items-center whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium text-text-secondary transition-colors duration-300"
          style={{ opacity: frozen ? 0.75 : 1 }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
