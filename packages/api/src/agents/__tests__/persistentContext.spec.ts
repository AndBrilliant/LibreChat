import { excludedKeys } from 'librechat-data-provider';
import { HumanMessage, AIMessage } from '@librechat/agents/langchain/messages';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import {
  injectPersistentContext,
  formatPersistentContextBlock,
  MAX_PERSISTENT_CONTEXT_CHARS,
} from '../persistentContext';
import { resolveSummarizationConfig, FORCED_COMPACTION_RESERVE_RATIO } from '../compaction';

const textOf = (message: BaseMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : (message.content as Array<{ type: string; text?: string }>)
        .map((part) => part.text ?? '')
        .join('\n');

describe('injectPersistentContext', () => {
  it('appends the note to the last human message', () => {
    const messages: BaseMessage[] = [
      new HumanMessage({ content: 'first' }),
      new AIMessage({ content: 'reply' }),
      new HumanMessage({ content: 'second' }),
    ];

    const result = injectPersistentContext({
      initialMessages: messages,
      persistentContext: 'ship the parser before the demo',
    });

    expect(result.injected).toBe(true);
    expect(result.targetIdx).toBe(2);
    expect(textOf(messages[2])).toContain('ship the parser before the demo');
    expect(textOf(messages[2])).toMatch(/^second/);
    expect(textOf(messages[0])).toBe('first');
    expect(textOf(messages[1])).toBe('reply');
  });

  it('targets the last human turn even when an assistant message is last', () => {
    const messages: BaseMessage[] = [
      new HumanMessage({ content: 'question' }),
      new AIMessage({ content: 'dangling tool turn' }),
    ];

    const result = injectPersistentContext({
      initialMessages: messages,
      persistentContext: 'note',
    });

    expect(result.targetIdx).toBe(0);
    expect(textOf(messages[0])).toContain('note');
  });

  it('appends a text part when content is an array', () => {
    const messages: BaseMessage[] = [
      new HumanMessage({ content: [{ type: 'text', text: 'typed' }] }),
    ];

    injectPersistentContext({ initialMessages: messages, persistentContext: 'note' });

    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content).toHaveLength(2);
    expect(textOf(messages[0])).toContain('note');
  });

  it('is a no-op for empty, whitespace-only, and absent notes', () => {
    for (const value of ['', '   \n  ', undefined, null]) {
      const messages: BaseMessage[] = [new HumanMessage({ content: 'only' })];
      const result = injectPersistentContext({
        initialMessages: messages,
        persistentContext: value,
      });
      expect(result.injected).toBe(false);
      expect(textOf(messages[0])).toBe('only');
    }
  });

  it('is a no-op when the payload has no human message', () => {
    const messages: BaseMessage[] = [new AIMessage({ content: 'assistant only' })];
    const result = injectPersistentContext({
      initialMessages: messages,
      persistentContext: 'note',
    });
    expect(result.injected).toBe(false);
    expect(result.targetIdx).toBe(-1);
  });

  it('truncates an oversized note rather than dropping the turn', () => {
    const messages: BaseMessage[] = [new HumanMessage({ content: 'hi' })];
    const oversized = 'x'.repeat(MAX_PERSISTENT_CONTEXT_CHARS + 500);

    const result = injectPersistentContext({
      initialMessages: messages,
      persistentContext: oversized,
    });

    expect(result.injected).toBe(true);
    expect(result.truncatedChars).toBe(500);
    expect(textOf(messages[0])).toContain('persistent context truncated');
  });

  it('re-counts the mutated message so the gauge stays honest', () => {
    const messages: BaseMessage[] = [new HumanMessage({ content: 'hi' })];
    const result = injectPersistentContext({
      initialMessages: messages,
      indexTokenCountMap: { 0: 5 },
      persistentContext: 'a much longer standing note',
      tokenCounter: () => 42,
    });

    expect(result.indexTokenCountMap).toEqual({ 0: 42 });
  });

  it('wraps the note in delimiters the model can distinguish from typed text', () => {
    const block = formatPersistentContextBlock('remember the deadline');
    expect(block.startsWith('<persistent_context>')).toBe(true);
    expect(block.trimEnd().endsWith('</persistent_context>')).toBe(true);
    expect(block).toContain('remember the deadline');
  });
});

describe('persistentContext conversation persistence', () => {
  /**
   * Regression guard. `saveMessageToDatabase` `$unset`s every stored
   * conversation field the current turn did not resend, unless the key is
   * excluded. Without this entry, one submit path that omits the field wipes
   * the user's standing instructions with no way to notice.
   */
  it('is excluded from the unset-on-omission reconciliation', () => {
    expect(excludedKeys.has('persistentContext')).toBe(true);
  });
});

describe('resolveSummarizationConfig', () => {
  const base = {
    enabled: true,
    provider: 'kimi',
    model: 'kimi-for-coding-highspeed',
    trigger: { type: 'token_ratio' as const, value: 0.75 },
    reserveRatio: 0.1,
  };

  it('returns the config untouched when compaction was not requested', () => {
    expect(resolveSummarizationConfig(base, false)).toBe(base);
    expect(resolveSummarizationConfig(base, undefined)).toBe(base);
  });

  it('forces a zero trigger and a shrunken budget when requested', () => {
    const forced = resolveSummarizationConfig(base, true);
    expect(forced?.trigger).toEqual({ type: 'token_ratio', value: 0 });
    expect(forced?.reserveRatio).toBe(FORCED_COMPACTION_RESERVE_RATIO);
    expect(forced?.retainRecent).toEqual({ turns: 2 });
    expect(forced?.provider).toBe('kimi');
  });

  it('keeps a deployment-configured retainRecent', () => {
    const forced = resolveSummarizationConfig({ ...base, retainRecent: { turns: 5 } }, true);
    expect(forced?.retainRecent).toEqual({ turns: 5 });
  });

  it('does not force when summarization is disabled or absent', () => {
    const disabled = { ...base, enabled: false };
    expect(resolveSummarizationConfig(disabled, true)).toBe(disabled);
    expect(resolveSummarizationConfig(undefined, true)).toBeUndefined();
  });
});
