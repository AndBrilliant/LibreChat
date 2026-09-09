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
 */

const SAMPLE_MS = 400;

function messageTokens(m: TMessage): number {
  if (typeof m.tokenCount === 'number' && m.tokenCount > 0) {
    return m.tokenCount;
  }
  /* reasoning models stream into content parts (think/reasoning + text) —
     count every known text-bearing field so the rate also moves while the
     model is still thinking */
  const PART_KEYS = ['text', 'think', 'thinking', 'reasoning', 'reasoning_content'];
  const content: unknown = (m as { content?: unknown }).content;
  let chars = 0;
  if (Array.isArray(content) && content.length > 0) {
    for (const p of content as Record<string, unknown>[]) {
      if (p && typeof p === 'object') {
        for (const k of PART_KEYS) {
          const v = p[k];
          if (typeof v === 'string') {
            chars += v.length;
          }
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
  const conversationId = conversation?.conversationId ?? '';
  const queryClient = useQueryClient();
  const [liveRate, setLiveRate] = useState<number | null>(null);
  const [finalRate, setFinalRate] = useState<number | null>(null);
  const startRef = useRef(0);
  const prevNRef = useRef(0);
  const turnTokensRef = useRef(0);
  const lastGrowthRef = useRef(0);
  const wasSubmitting = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /* A fresh chat streams under the server-assigned conversation id, not the
     prop's 'new' — so read across ALL message caches and take the newest
     assistant message. Only sampled while submitting, so the newest one is
     always ours. */
  const readTokens = () => {
    const all = queryClient.getQueriesData<TMessage[]>({ queryKey: [QueryKeys.messages] });
    let best = 0;
    let bestTs = 0;
    for (const [, msgs] of all) {
      if (!Array.isArray(msgs)) {
        continue;
      }
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.isCreatedByUser === false) {
          const ts = Date.parse(m.createdAt ?? '') || 0;
          if (ts >= bestTs) {
            bestTs = ts;
            best = messageTokens(m);
          }
          break;
        }
      }
    }
    return best;
  };

  /* reset on conversation switch */
  useEffect(() => {
    setLiveRate(null);
    setFinalRate(null);
    wasSubmitting.current = false;
  }, [conversationId]);

  /* stream start: begin sampling; stream end: freeze the average */
  useEffect(() => {
    if (isSubmitting && !wasSubmitting.current) {
      startRef.current = performance.now();
      lastGrowthRef.current = performance.now();
      turnTokensRef.current = 0;
      prevNRef.current = readTokens();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      setFinalRate(null);
      setLiveRate(0);
    }
    if (wasSubmitting.current && !isSubmitting) {
      /* measure to the last token that actually arrived, NOT to the
         isSubmitting flip — title-gen and finalization keep it true for
         seconds after the response text stops growing */
      const elapsed = Math.max(
        0.5,
        ((lastGrowthRef.current || performance.now()) - startRef.current) / 1000,
      );
      /* the stream-close message rewrite can transiently shrink the text
         (content parts normalize), and isSubmitting can flicker between
         resume segments — so only freeze after a 1.5s still-idle grace, by
         which time the real tokenCount has landed. A restart cancels this. */
      timerRef.current = setTimeout(() => {
        if (elapsed > 0.3 && turnTokensRef.current > 0) {
          setFinalRate(turnTokensRef.current / elapsed);
        }
        setLiveRate(null);
      }, 1500);
    }
    wasSubmitting.current = isSubmitting;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitting, conversationId]);

  /* clear pending refine timer on unmount */
  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), []);

  /* running turn average via delta accumulation — immune to message-shell
     swaps, continuations, cache rewrites and background title-gen writes */
  useEffect(() => {
    if (!isSubmitting) {
      return;
    }
    const id = setInterval(() => {
      const now = performance.now();
      const n = readTokens();
      const dn = n - prevNRef.current;
      prevNRef.current = n;
      if (dn > 0) {
        turnTokensRef.current += dn;
        lastGrowthRef.current = now;
      }
      const elapsed = (now - startRef.current) / 1000;
      if (elapsed > 0.3 && turnTokensRef.current > 0) {
        setLiveRate(turnTokensRef.current / elapsed);
      }
    }, SAMPLE_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitting, conversationId]);

  const rate = liveRate ?? finalRate;
  if (rate == null || rate <= 0) {
    return null;
  }

  const frozen = liveRate == null;
  const label = `⚡ ${rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)} tok/s`;

  return (
    <span
      data-testid="token-speed-hud"
      title={frozen ? `final average: ${label}` : `live: ${label}`}
      aria-live="polite"
      className="ml-1 flex select-none items-center whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium text-text-secondary transition-colors duration-300"
      style={{ opacity: frozen ? 0.75 : 1 }}
    >
      {label}
    </span>
  );
}
