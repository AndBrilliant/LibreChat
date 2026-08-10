import { logger } from '@librechat/data-schemas';
import type { SummarizationConfig } from 'librechat-data-provider';

/**
 * ADR fork — on-demand context compaction ("Compact now" / checkpoint).
 *
 * The agents SDK has no "summarize regardless" switch. `shouldTriggerSummarization`
 * is consulted only when pruning actually produced `messagesToRefine`, and
 * pruning produces nothing while the conversation still fits its budget. A
 * zero trigger on its own is therefore inert on any conversation that is not
 * already under context pressure.
 *
 * Forcing means shrinking the budget for one run so pruning genuinely
 * overflows, paired with a zero trigger so the overflow summarizes rather than
 * merely dropping messages:
 *
 *   - `reserveRatio` reserves most of the window, leaving a small pruning
 *     budget (see `computeEffectiveMaxContextTokens` in `run.ts`)
 *   - `trigger.value: 0` makes any pressure at all sufficient
 *   - `retainRecent` keeps the last turns verbatim so a checkpoint cannot
 *     swallow the message the user just sent
 *
 * Known limit, by construction: a conversation using less than
 * `1 - FORCED_COMPACTION_RESERVE_RATIO` of its window has nothing to prune, so
 * forcing is a no-op there. Compacting a nearly-empty context is not
 * meaningful, but it does mean this cannot promise a checkpoint at an
 * arbitrary point in a short conversation.
 */

/** Reserved share of the window during a forced run, leaving ~25% as the
 *  pruning budget: high enough that an ordinary working conversation
 *  overflows, low enough that the post-checkpoint retry still fits. */
export const FORCED_COMPACTION_RESERVE_RATIO = 0.75;

/** Turns kept verbatim through a forced compaction. Applied only when the
 *  deployment has not configured its own `summarization.retainRecent`. */
export const FORCED_COMPACTION_RETAIN_RECENT = { turns: 2 };

/**
 * Returns the configured summarization block unchanged unless this turn was
 * flagged for compaction, in which case it returns a forced variant.
 */
export function resolveSummarizationConfig(
  config: SummarizationConfig | undefined,
  forceCompaction: boolean | undefined,
): SummarizationConfig | undefined {
  if (forceCompaction !== true) {
    return config;
  }
  if (!config || config.enabled === false) {
    logger.warn(
      '[resolveSummarizationConfig] Compaction requested but summarization is disabled; ignoring.',
    );
    return config;
  }
  return {
    ...config,
    trigger: { type: 'token_ratio', value: 0 },
    reserveRatio: FORCED_COMPACTION_RESERVE_RATIO,
    retainRecent: config.retainRecent ?? FORCED_COMPACTION_RETAIN_RECENT,
  };
}
