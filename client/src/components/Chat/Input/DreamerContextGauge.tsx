import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { TMessage, TConversation } from 'librechat-data-provider';
import useTokenLimits from '~/hooks/Chat/useTokenLimits';

/**
 * ADR fork — our own context gauge. The stock TokenUsage indicator derives its
 * number from in-session snapshots / branch usage and blanks out on a passively
 * restored conversation (no live anchor). This one reads the conversation's
 * messages straight from the query cache and sums the stored per-message
 * `tokenCount` along the active branch — the same ground truth the server sends
 * — so it ALWAYS reflects what's actually in the chat, restored or live. Over
 * the window it shows the real percentage (e.g. 172%) in red so a full
 * pre-compaction chat is unmistakable.
 */

function estTokens(m: TMessage): number {
  if (typeof m.tokenCount === 'number' && m.tokenCount > 0) {
    return m.tokenCount;
  }
  const text = typeof m.text === 'string' ? m.text : '';
  return Math.round(text.length / 4);
}

function sumBranchTokens(messages: TMessage[] | undefined | null): number {
  if (!messages || messages.length === 0) {
    return 0;
  }
  const byId = new Map<string, TMessage>();
  for (const m of messages) {
    if (m?.messageId) {
      byId.set(m.messageId, m);
    }
  }
  /** leaf = a message that is nobody's parent (the active-branch tail); for a
   *  linear thread that's simply the latest. Walk up parentMessageId summing. */
  const parentIds = new Set(messages.map((m) => m.parentMessageId));
  const leaves = messages.filter((m) => m.messageId && !parentIds.has(m.messageId));
  let leaf: TMessage | undefined = leaves[0];
  const pool = leaves.length > 0 ? leaves : messages;
  for (const m of pool) {
    if (!leaf || (m.createdAt ?? '') > (leaf.createdAt ?? '')) {
      leaf = m;
    }
  }
  let sum = 0;
  let cur: TMessage | undefined = leaf;
  let guard = 0;
  while (cur && guard++ < 20000) {
    sum += estTokens(cur);
    cur = cur.parentMessageId ? byId.get(cur.parentMessageId) : undefined;
  }
  return sum;
}

const fmt = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : `${n}`;

export default function DreamerContextGauge({
  conversation,
}: {
  conversation: TConversation | null;
}): JSX.Element | null {
  const conversationId = conversation?.conversationId ?? '';
  const queryClient = useQueryClient();
  const limits = useTokenLimits(conversation);

  /** Reactive read of the messages cache: `enabled:false` so it never refetches,
   *  but it still subscribes to this query key, so the gauge re-renders whenever
   *  messages are (re)loaded into the cache. */
  const { data: messages } = useQuery<TMessage[]>(
    [QueryKeys.messages, conversationId],
    async () => queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]) ?? [],
    { enabled: false },
  );

  const used = useMemo(() => sumBranchTokens(messages), [messages]);
  const max = limits.maxContextTokens ?? 0;

  if (used <= 0) {
    return null;
  }

  const pct = max > 0 ? Math.round((used / max) * 100) : 0;
  const over = max > 0 && used > max;
  const near = !over && pct >= 80;
  const barColor = over ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-green-500';
  const textColor = over ? 'text-red-500' : near ? 'text-amber-600' : 'text-text-secondary';

  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max > 0 ? max : undefined}
      aria-valuenow={used}
      title={`Context: ${used.toLocaleString()} / ${(max || 0).toLocaleString()} tokens (${pct}%)${
        over ? ' — over the model window; will compact on send' : ''
      }`}
      className={`flex select-none items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${textColor}`}
    >
      <span className="relative inline-block h-2 w-16 overflow-hidden rounded-full bg-surface-tertiary">
        <span
          className={`absolute left-0 top-0 h-full rounded-full ${barColor}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </span>
      <span className="tabular-nums">
        {fmt(used)}/{max > 0 ? fmt(max) : '?'} ({pct}%)
      </span>
    </div>
  );
}
