import { logger } from '@librechat/data-schemas';
import type { BaseMessage } from '@librechat/agents/langchain/messages';

/**
 * ADR fork — persistent conversation context ("Always" note).
 *
 * A per-conversation sticky note that is NOT part of the transcript. It is
 * stored on the conversation (`convo.persistentContext`) and re-appended to
 * the END of the final human message on every single turn.
 *
 * Two properties follow from that, and both are the point of the feature:
 *
 * 1. Recency. A note at the tail of the current turn carries far more weight
 *    than the same text buried in a system prompt fifty turns back.
 * 2. Survival. Because it is re-injected from stored state each turn rather
 *    than living in the message history, summarization/compaction physically
 *    cannot compact it away. Compact as hard as you like — the standing
 *    instructions come back intact on the next turn.
 *
 * Appended as an extra block on the existing final human message rather than
 * spliced in as its own message: that keeps role alternation untouched (no
 * consecutive human turns for providers that dislike them) and keeps the note
 * out of any prompt-cache prefix, since the last message is never the prefix.
 */

export const PERSISTENT_CONTEXT_OPEN = '<persistent_context>';
export const PERSISTENT_CONTEXT_CLOSE = '</persistent_context>';

/** Hard ceiling. A sticky note that outgrows this stops being a note and
 *  starts being a context leak that silently taxes every turn. Truncated
 *  rather than rejected so a long note degrades instead of failing a chat. */
export const MAX_PERSISTENT_CONTEXT_CHARS = 8000;

const PREAMBLE =
  'Standing context for this conversation, supplied by the user. It is not part of ' +
  'this turn’s message and was not just typed — treat it as always in effect, ' +
  'and do not acknowledge or restate it unless it is relevant.';

export interface InjectPersistentContextParams {
  /** Formatted messages, post-`formatAgentMessages` and post-skill-priming. */
  initialMessages: BaseMessage[];
  indexTokenCountMap?: Record<number, number>;
  /** Raw note from the conversation. Empty/whitespace-only is a no-op. */
  persistentContext?: string | null;
  /** `createTokenCounter(...)` result, used to re-count the mutated message. */
  tokenCounter?: (message: BaseMessage) => number;
}

export interface InjectPersistentContextResult {
  initialMessages: BaseMessage[];
  indexTokenCountMap?: Record<number, number>;
  /** True when a note was actually appended. */
  injected: boolean;
  /** Index of the message that received it, or -1. */
  targetIdx: number;
  /** Chars dropped by the length cap, 0 when under it. */
  truncatedChars: number;
}

/** Renders the delimited block the model actually sees. */
export function formatPersistentContextBlock(note: string): string {
  return `${PERSISTENT_CONTEXT_OPEN}\n${PREAMBLE}\n\n${note}\n${PERSISTENT_CONTEXT_CLOSE}`;
}

/**
 * Appends the note to the last human message. Mutates that message in place
 * and returns the same array — matching `injectSkillPrimes`' contract.
 */
export function injectPersistentContext(
  params: InjectPersistentContextParams,
): InjectPersistentContextResult {
  const { initialMessages, tokenCounter } = params;
  let { indexTokenCountMap } = params;

  const noResult: InjectPersistentContextResult = {
    initialMessages,
    indexTokenCountMap,
    injected: false,
    targetIdx: -1,
    truncatedChars: 0,
  };

  const raw = typeof params.persistentContext === 'string' ? params.persistentContext.trim() : '';
  if (!raw || initialMessages.length === 0) {
    return noResult;
  }

  let note = raw;
  let truncatedChars = 0;
  if (note.length > MAX_PERSISTENT_CONTEXT_CHARS) {
    truncatedChars = note.length - MAX_PERSISTENT_CONTEXT_CHARS;
    note = `${note.slice(0, MAX_PERSISTENT_CONTEXT_CHARS)}\n\n[persistent context truncated: ${truncatedChars} characters over the ${MAX_PERSISTENT_CONTEXT_CHARS}-character limit]`;
    logger.warn(
      `[injectPersistentContext] Note exceeds ${MAX_PERSISTENT_CONTEXT_CHARS} chars; truncated ${truncatedChars}.`,
    );
  }

  /** Walk back to the last human turn. Normally the final message, but a
   *  regenerate or a tool-tail run can leave something else last. */
  let targetIdx = -1;
  for (let i = initialMessages.length - 1; i >= 0; i--) {
    if (initialMessages[i]?._getType() === 'human') {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) {
    logger.debug('[injectPersistentContext] No human message in payload; skipping injection.');
    return noResult;
  }

  const target = initialMessages[targetIdx];
  const block = formatPersistentContextBlock(note);

  if (typeof target.content === 'string') {
    target.content = target.content ? `${target.content}\n\n${block}` : block;
  } else if (Array.isArray(target.content)) {
    target.content = [...target.content, { type: 'text', text: block }] as typeof target.content;
  } else {
    logger.warn('[injectPersistentContext] Unexpected message content shape; skipping injection.');
    return noResult;
  }

  /** Re-count the mutated message so the context gauge stays honest — the
   *  note is real billed context and should show up as such. */
  if (indexTokenCountMap && tokenCounter) {
    indexTokenCountMap = { ...indexTokenCountMap, [targetIdx]: tokenCounter(target) };
  }

  return {
    initialMessages,
    indexTokenCountMap,
    injected: true,
    targetIdx,
    truncatedChars,
  };
}
