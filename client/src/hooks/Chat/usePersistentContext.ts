import { useCallback, useEffect, useMemo } from 'react';
import { useRecoilState } from 'recoil';
import { Constants } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import store from '~/store';

/**
 * ADR fork — the conversation's persistent "Always" note.
 *
 * The box is WYSIWYG: it is always prefilled with the stored note, and
 * whatever is in it when you hit Send is what the model receives this turn and
 * what gets stored going forward. Empty means empty — clearing the box clears
 * the note. There is deliberately no "empty means don't touch" rule, because
 * that would make "never set" and "deliberately cleared" indistinguishable.
 *
 * State lives entirely in the per-conversation draft atom, which two things
 * depend on:
 *
 *   - `useChatFunctions` reads it from a Recoil snapshot when it builds the
 *     submission, so the value that ships is the value on screen at the moment
 *     of Send — no commit step to race, no stale closure.
 *   - Because the atom is keyed by conversation and outlives tab flips and
 *     chat switches, an edit cannot evaporate mid-session without a send.
 *
 * Takes `conversation` as an argument rather than calling `useChatContext`:
 * ChatForm is deliberately memoized against a narrow slice of conversation
 * fields, and subscribing it to the whole chat context here would re-render
 * the composer on every streamed metadata update.
 *
 * Caveat worth knowing: the note only reaches the database when a turn is
 * sent. Setting one and reloading without sending loses it.
 */
export default function usePersistentContext(index = 0, conversation?: TConversation | null) {
  const conversationId = conversation?.conversationId ?? Constants.NEW_CONVO;
  const stored = conversation?.persistentContext ?? '';

  const [tab, setTab] = useRecoilState(store.composerTabFamily(index));
  const [draftState, setDraftState] = useRecoilState(
    store.persistentContextDraftByConvoId(conversationId),
  );

  /** `null` means "no local edit yet" — fall through to the stored value so a
   *  note saved in an earlier session shows up the moment the chat loads. */
  const draft = draftState ?? stored;

  /** Switching chats returns the composer to the message pane. Leaving it on
   *  the Always pane across a switch is a good way to type a message into the
   *  wrong box. */
  useEffect(() => {
    setTab('message');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const setDraft = useCallback((value: string) => setDraftState(value), [setDraftState]);

  const hasNote = useMemo(() => draft.trim().length > 0, [draft]);

  return { tab, setTab, draft, setDraft, hasNote, conversationId };
}
