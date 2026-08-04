import { memo } from 'react';
import { useLocalize } from '~/hooks';

/**
 * Shown when a turn is saved as `unfinished` because it ended right after a
 * tool call with no reaction from the model — e.g. GLM 5.2 / Z-AI occasionally
 * reports `finish_reason: "tool_calls"` for a completion that parses out
 * completely empty, silently ending the turn with nothing to act on. The prior
 * tool calls and reasoning above this notice are real and worth keeping, so
 * this appends a note rather than replacing them.
 */
const EndedIncomplete = memo(() => {
  const localize = useLocalize();
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mt-2 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-gray-600 dark:text-gray-200"
    >
      {localize('com_ui_response_incomplete')}
    </div>
  );
});

export default EndedIncomplete;
