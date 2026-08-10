import { memo, useCallback } from 'react';
import { useRecoilState } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

/**
 * ADR fork — arms an on-demand context checkpoint for the next message.
 *
 * Lives in the token-usage popover because that is where the decision gets
 * made: you are already looking at the meter when you decide to compact.
 *
 * The compaction floor is not cosmetic. Forcing works by shrinking the run's
 * budget so pruning overflows (see `compaction.ts`); a conversation using less
 * than the forced budget has nothing to prune, so the request would be a
 * silent no-op. Better to say so than to accept a click that does nothing.
 */
const COMPACTION_FLOOR_PERCENT = 25;

function CompactButton({
  conversationId,
  percent,
}: {
  conversationId?: string | null;
  percent: number;
}) {
  const localize = useLocalize();
  const convoKey = conversationId ?? Constants.NEW_CONVO;
  const [armed, setArmed] = useRecoilState(store.pendingCompactionByConvoId(convoKey));

  const available = percent >= COMPACTION_FLOOR_PERCENT;

  const toggle = useCallback(() => setArmed((prev) => !prev), [setArmed]);

  const armedHintKey = armed
    ? 'com_ui_compact_context_armed'
    : 'com_ui_compact_context_description';
  const hintKey = available ? armedHintKey : 'com_ui_compact_context_unavailable';

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={toggle}
        disabled={!available}
        aria-pressed={armed}
        data-testid="compact-context"
        className={cn(
          'w-full rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          available
            ? 'bg-surface-tertiary text-text-primary hover:bg-surface-hover'
            : 'cursor-not-allowed bg-surface-tertiary text-text-secondary opacity-60',
        )}
      >
        {armed ? localize('com_ui_compact_context_cancel') : localize('com_ui_compact_context')}
      </button>
      <p className="text-xs text-text-secondary">{localize(hintKey)}</p>
    </div>
  );
}

export default memo(CompactButton);
