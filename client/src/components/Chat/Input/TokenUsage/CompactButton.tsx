import { memo, useCallback, useState } from 'react';
import axios from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * ADR fork — "Compact now" fires an IMMEDIATE, on-click compaction.
 *
 * Posts to POST /api/dreamer/compact-now, which asks the dreamer for this
 * conversation's compressed memory and persists a `summary` checkpoint after
 * the current leaf. The gauge + client.js already treat that summary part as
 * "stands in for every older turn", so the context drops the instant we refetch
 * the thread — no waiting for a turn. The full thread stays in the store; the
 * model drills back via rehydrate_node / dream_recall / dream_search later.
 */
function CompactButton({
  conversationId,
  percent: _percent,
}: {
  conversationId?: string | null;
  percent: number;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled =
    !conversationId || conversationId === Constants.NEW_CONVO || busy;

  const compactNow = useCallback(async () => {
    if (disabled || !conversationId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await axios.post('/api/dreamer/compact-now', { conversationId });
      // refetch the thread so the checkpoint appears and the gauge drops now
      await queryClient.invalidateQueries({
        queryKey: [QueryKeys.messages, conversationId],
      });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      setError(err?.response?.data?.error || err?.message || 'compaction failed');
    } finally {
      setBusy(false);
    }
  }, [disabled, conversationId, queryClient]);

  const label = busy
    ? localize('com_ui_compact_context_working') || 'Compacting…'
    : localize('com_ui_compact_context') || 'Compact now';

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={compactNow}
        disabled={disabled}
        aria-busy={busy}
        data-testid="compact-context"
        className={cn(
          'w-full rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'bg-surface-tertiary text-text-primary hover:bg-surface-hover',
          disabled ? 'opacity-60' : '',
        )}
      >
        {label}
      </button>
      <p className={cn('text-xs', error ? 'text-red-500' : 'text-text-secondary')}>
        {error
          ? error
          : localize('com_ui_compact_context_description') ||
            'Fold the earlier turns into memory now.'}
      </p>
    </div>
  );
}

export default memo(CompactButton);
