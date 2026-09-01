import { useMemo, useRef } from 'react';
import * as Ariakit from '@ariakit/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { TMessage, TConversation } from 'librechat-data-provider';
import { TooltipAnchor } from '@librechat/client';
import useTokenLimits from '~/hooks/Chat/useTokenLimits';
import Gauge from './TokenUsage/Gauge';
import CompactButton from './TokenUsage/CompactButton';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * ADR fork — context gauge. Same look as the stock indicator (circular gauge +
 * click-through popover with the breakdown + Compact now), but the NUMBER comes
 * from summing the conversation's per-message `tokenCount` straight from the
 * query cache along the active branch — ground truth — instead of the stock
 * in-session snapshot/branch-usage path, which blanks out on a passively
 * restored conversation. Restored or live, it shows the real context.
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
  const parentIds = new Set(messages.map((m) => m.parentMessageId));
  const leaves = messages.filter((m) => m.messageId && !parentIds.has(m.messageId));
  const pool = leaves.length > 0 ? leaves : messages;
  let leaf: TMessage | undefined = pool[0];
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
    /* A compaction checkpoint (summary content block) STANDS IN for every older
       turn: add the summary's own tokens and stop. This is what makes the gauge
       drop after a compaction (full -> cleared) instead of re-counting the
       compacted history that still lives in the DB. */
    const summaryPart = Array.isArray(cur.content)
      ? cur.content.find((p: any) => p && p.type === 'summary')
      : undefined;
    if (summaryPart) {
      const st = (summaryPart as any).tokenCount;
      sum += typeof st === 'number' && st > 0 ? st : 0;
      break;
    }
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
  const localize = useLocalize();
  const limits = useTokenLimits(conversation);
  const popover = Ariakit.usePopoverStore({ placement: 'top' });
  const disclosureRef = useRef<HTMLButtonElement>(null);

  const { data: messages } = useQuery<TMessage[]>(
    [QueryKeys.messages, conversationId],
    async () => queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]) ?? [],
    { enabled: false },
  );

  const used = useMemo(() => sumBranchTokens(messages), [messages]);
  const max = limits.maxContextTokens ?? 0;

  /** Hide on an empty/message-less chat, like the stock indicator. */
  if (used <= 0) {
    return null;
  }

  const hasMax = max > 0;
  const truePct = hasMax ? Math.round((used / max) * 100) : 0; // may exceed 100
  const gaugePct = hasMax ? Math.min(truePct, 100) : 0; // circle fill, clamped
  const over = hasMax && truePct > 100;
  const summary = hasMax ? `${fmt(used)} / ${fmt(max)} (${truePct}%)` : `${fmt(used)}`;

  return (
    <>
      <TooltipAnchor
        description={summary}
        side="top"
        render={
          <Ariakit.PopoverDisclosure
            ref={disclosureRef}
            store={popover}
            type="button"
            data-testid="token-usage"
            aria-label={summary}
            aria-haspopup="dialog"
            className={cn(
              'flex size-9 items-center justify-center rounded-full p-1 transition-colors',
              'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'duration-300 animate-in fade-in zoom-in-95',
            )}
          >
            <span
              role="meter"
              aria-valuemin={0}
              aria-valuemax={hasMax ? max : undefined}
              aria-valuenow={used}
              className="flex items-center justify-center"
            >
              <Gauge percent={gaugePct} indeterminate={!hasMax} />
            </span>
          </Ariakit.PopoverDisclosure>
        }
      />
      <Ariakit.Popover
        store={popover}
        gutter={8}
        portal
        unmountOnHide
        finalFocus={disclosureRef}
        className="z-[200] rounded-xl border border-border-medium bg-surface-secondary p-3 shadow-lg focus:outline-none"
      >
        <div className="w-60 space-y-2.5">
          <div className="flex items-center justify-between text-sm font-medium text-text-primary">
            <span>{localize('com_ui_context') || 'Context window'}</span>
            <span className={cn('tabular-nums', over && 'text-red-500')}>
              {fmt(used)} / {hasMax ? fmt(max) : '?'}
            </span>
          </div>
          <div
            className="relative h-2 w-full overflow-hidden rounded-full bg-surface-tertiary"
            role="progressbar"
            aria-valuenow={truePct}
          >
            <span
              className={cn(
                'absolute left-0 top-0 h-full rounded-full',
                over ? 'bg-red-500' : truePct >= 80 ? 'bg-amber-500' : 'bg-green-500',
              )}
              style={{ width: `${gaugePct}%` }}
            />
          </div>
          <div className={cn('text-xs', over ? 'text-red-500' : 'text-text-secondary')}>
            {hasMax
              ? over
                ? `${truePct}% — over the window; compacts on your next message`
                : `${truePct}% of the window`
              : `${fmt(used)} tokens`}
          </div>
          <CompactButton conversationId={conversationId} percent={truePct} used={used} />
        </div>
      </Ariakit.Popover>
    </>
  );
}
