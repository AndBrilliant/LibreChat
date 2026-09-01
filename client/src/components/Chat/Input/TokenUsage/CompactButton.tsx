import { memo, useCallback, useState } from 'react';
import axios from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * ADR fork — "Compact now" runs a SYNCHRONOUS compaction and streams it live.
 *
 * POSTs to /api/dreamer/compact-now, which proxies the dreamer's streaming fold:
 * you watch each chunk fold (i / n + ETA) as athena writes it, then a `summary`
 * checkpoint is persisted and the gauge collapses. Full thread stays in the
 * store; the model drills back via rehydrate_node / dream_recall / dream_search.
 */
type Progress = { i: number; n: number; elapsed: number; summary: string };

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : String(n);
}
function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '…';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `~${m}m ${s}s` : `~${s}s`;
}

function CompactButton({
  conversationId,
}: {
  conversationId?: string | null;
  percent?: number;
  used?: number;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const [prog, setProg] = useState<Progress | null>(null);
  const [tokens, setTokens] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);
  const [retry, setRetry] = useState<number>(0);

  const disabled =
    !conversationId || conversationId === Constants.NEW_CONVO || phase === 'streaming';

  const compactNow = useCallback(async () => {
    if (disabled || !conversationId) {
      return;
    }
    setPhase('streaming');
    setProg(null);
    setTokens(0);
    setError(null);
    const auth = axios.defaults.headers.common?.['Authorization'] as string | undefined;
    const t0 = Date.now();
    try {
      const res = await fetch('/api/dreamer/compact-now', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ conversationId }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let sawComplete = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() || '';
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith('data:')) continue;
          const p = line.slice(5).trim();
          if (p === '[DONE]') continue;
          let obj: any;
          try { obj = JSON.parse(p); } catch { continue; }
          if (obj.phase === 'chunk') {
            setProg({ i: obj.i, n: obj.n, elapsed: (Date.now() - t0) / 1000, summary: obj.summary || '' });
          } else if (obj.phase === 'done' || obj.phase === 'complete') {
            sawComplete = true;
            setTokens(Number(obj.meta_tokens ?? obj.metaTokens) || 0);
            setElapsed(Number(obj.elapsed) || (Date.now() - t0) / 1000);
            setPhase('done');
          } else if (obj.phase === 'failed') {
            sawComplete = true;
            setError(String(obj.error || 'compaction failed — no memory produced. Your context was kept intact.'));
            setPhase('error');
          } else if (obj.phase === 'retry') {
            setRetry(Number(obj.attempt) || 0);
          } else if (obj.phase === 'error') {
            setError(String(obj.error || 'fold error'));
          }
        }
      }
      if (!sawComplete) {
        // stream ended without done/failed -> do NOT fake success
        setError('compaction did not finish — no changes made, try again');
        setPhase((prev) => (prev === 'streaming' ? 'error' : prev));
      }
      await queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, conversationId] });
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase('error');
    }
  }, [disabled, conversationId, queryClient]);

  const pct = prog && prog.n ? Math.round((prog.i / prog.n) * 100) : 0;
  const eta = prog && prog.i ? (prog.elapsed / prog.i) * (prog.n - prog.i) : Infinity;
  const label =
    phase === 'streaming'
      ? prog
        ? `Folding chunk ${prog.i}/${prog.n}…`
        : 'Starting…'
      : localize('com_ui_compact_context') || 'Compact now';

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={compactNow}
        disabled={disabled}
        aria-busy={phase === 'streaming'}
        data-testid="compact-context"
        className={cn(
          'w-full rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          phase === 'streaming'
            ? 'bg-amber-500/20 text-amber-500'
            : 'bg-surface-tertiary text-text-primary hover:bg-surface-hover',
          disabled && phase !== 'streaming' ? 'opacity-60' : '',
        )}
      >
        {label}
      </button>

      {phase === 'streaming' && (
        <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
          <div className="flex items-center justify-between font-mono text-[11px] text-text-secondary">
            <span className="tabular-nums">
              {prog ? `${prog.i} / ${prog.n} chunks` : 'catching the dreamer up…'}
            </span>
            <span className="tabular-nums">{retry > 0 ? `retry ${retry}` : prog ? `${fmtEta(eta)} left` : ''}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
            <span
              className="block h-full rounded-full bg-amber-500 transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          {prog?.summary && (
            <div className="line-clamp-2 font-mono text-[11px] leading-snug text-text-secondary">
              {prog.summary}
            </div>
          )}
        </div>
      )}

      {phase === 'done' && (
        <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-2 text-xs text-green-500">
          <div className="font-semibold">✓ Compacted in {elapsed.toFixed(1)}s</div>
          <div className="mt-0.5 tabular-nums text-text-primary">
            {prog ? `${prog.n} chunks folded` : 'folded'} →{' '}
            <span className="font-semibold text-green-500">{fmtTokens(tokens)}</span> tokens of memory
          </div>
        </div>
      )}

      {phase === 'error' && <p className="text-xs text-red-500">{error}</p>}

      {phase === 'idle' && (
        <p className="text-xs text-text-secondary">
          {localize('com_ui_compact_context_description') ||
            'Fold the earlier turns into memory now — you will see it stream.'}
        </p>
      )}
    </div>
  );
}

export default memo(CompactButton);
