import { memo } from 'react';
import { TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * ADR fork — flips the composer between the message for THIS turn and the
 * conversation's persistent "Always" note.
 *
 * Always visible rather than tucked behind a menu: a note that silently rides
 * along on every turn needs a permanent, obvious home, and the dot on the
 * "Always" tab is the only cue that one is currently in effect.
 */
function ComposerTabs({
  tab,
  onSelect,
  hasNote,
  disabled,
}: {
  tab: 'message' | 'always';
  onSelect: (next: 'message' | 'always') => void;
  hasNote: boolean;
  disabled?: boolean;
}) {
  const localize = useLocalize();

  const tabClasses = (active: boolean) =>
    cn(
      'relative rounded-t-lg px-3 py-1 text-xs font-medium transition-colors duration-150',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary',
      active
        ? 'bg-surface-chat text-text-primary'
        : 'text-text-secondary hover:text-text-primary disabled:cursor-not-allowed',
    );

  return (
    <div
      role="tablist"
      aria-label={localize('com_ui_persistent_context_description')}
      className="flex items-end gap-1 px-2 pt-1.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'message'}
        disabled={disabled}
        onClick={() => onSelect('message')}
        className={tabClasses(tab === 'message')}
      >
        {localize('com_ui_persistent_context_this_turn')}
      </button>
      <TooltipAnchor
        description={localize('com_ui_persistent_context_description')}
        render={
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'always'}
            disabled={disabled}
            onClick={() => onSelect('always')}
            className={tabClasses(tab === 'always')}
          >
            {localize('com_ui_persistent_context')}
            {/* Standing instructions that are invisible are a trap — the dot
                is the only cue that every turn is carrying extra context. */}
            {hasNote && (
              <span
                aria-label={localize('com_ui_persistent_context_active')}
                className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-green-500 align-middle"
              />
            )}
          </button>
        }
      />
    </div>
  );
}

export default memo(ComposerTabs);
