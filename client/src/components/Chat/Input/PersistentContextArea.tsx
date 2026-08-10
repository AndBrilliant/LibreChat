import { memo } from 'react';
import { TextareaAutosize } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * ADR fork — the "Always" pane of the composer.
 *
 * Deliberately plain. It is NOT the message textarea in a different mode: no
 * react-hook-form registration, no draft autosave, no mentions/skills/quote
 * machinery, and Enter inserts a newline rather than sending. All of that
 * belongs to the per-turn composer, and entangling the two is how you end up
 * sending your standing instructions as a message.
 */
function PersistentContextArea({
  value,
  onChange,
  disabled,
  isRTL,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  isRTL?: boolean;
}) {
  const localize = useLocalize();

  return (
    <div className={cn('flex flex-col', isRTL ? 'flex-row-reverse' : undefined)}>
      <TextareaAutosize
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        data-testid="persistent-context-input"
        aria-label={localize('com_ui_persistent_context_input')}
        placeholder={localize('com_ui_persistent_context_placeholder')}
        rows={2}
        style={{ height: 66, overflowY: 'auto' }}
        className={cn(
          'm-0 w-full resize-none border-0 bg-transparent py-[10px] pl-5 pr-5',
          'text-text-primary placeholder-text-secondary outline-none',
          'max-h-[45vh] md:max-h-[55vh]',
          'scrollbar-hover transition-[max-height] duration-200 disabled:cursor-not-allowed',
        )}
      />
      <div className="px-5 pb-1 text-xs text-text-secondary">
        {localize('com_ui_persistent_context_description')}
      </div>
    </div>
  );
}

export default memo(PersistentContextArea);
