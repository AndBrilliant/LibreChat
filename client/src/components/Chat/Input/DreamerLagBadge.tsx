import { useEffect, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import type { TConversation } from 'librechat-data-provider';

/**
 * ADR fork — dreamer fold lag badge + continuous-compaction settings popover.
 *
 * Polls the dreamer coverage endpoint (via the /api/dreamer proxy) and shows how
 * far the background fold trails the live edge: "✓ memory" when fully folded,
 * "⏳ N behind" when N turns are still unfolded (they ride verbatim — zero-loss —
 * until the daemon catches up). Click opens the dreamer's own spy popover
 * (spy_ui.html through the proxy) which carries the continuous-compaction
 * toggle, retain-turns setting, fold event stream and coverage details.
 *
 * Sits next to the context gauge + speed HUD above the chat input.
 */

const POLL_MS = 6000;

interface LagState {
  turns: number;
  folded: number;
  lag: number;
  folded_through: string | null;
  ok: boolean;
}

export default function DreamerLagBadge({
  conversation,
}: {
  conversation: TConversation | null;
}): JSX.Element | null {
  const conversationId = conversation?.conversationId ?? '';
  const [state, setState] = useState<LagState | null>(null);
  const popover = Ariakit.usePopoverStore({ placement: 'top' });
  const disclosureRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!conversationId || conversationId === 'new') {
      setState(null);
      return;
    }
    let dead = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/dreamer/api/lag?cid=${encodeURIComponent(conversationId)}`);
        const j = await r.json();
        if (!dead && j && j.ok !== false) {
          setState(j);
        }
      } catch {
        /* dreamer unreachable — badge just goes quiet */
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [conversationId]);

  if (!state || !conversationId || conversationId === 'new') {
    return null;
  }

  const lag = Number(state.lag) || 0;
  const behind = lag > 0;
  const label = behind ? `⏳ ${lag} behind` : '✓ memory';
  const title = behind
    ? `${lag} turn(s) not yet folded — kept verbatim (zero-loss) until the dreamer catches up. Click for fold status + continuous-compaction settings.`
    : `memory fully folded through ${state.folded_through ?? 'now'} — click for fold status + continuous-compaction settings.`;

  return (
    <>
      <Ariakit.PopoverDisclosure
        ref={disclosureRef}
        store={popover}
        type="button"
        title={title}
        data-testid="dreamer-lag-badge"
        className="ml-1 flex select-none items-center whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium transition-colors hover:bg-surface-hover"
        style={{
          color: behind ? 'var(--text-warning, #b45309)' : 'var(--text-secondary, #6b7280)',
          opacity: behind ? 1 : 0.75,
        }}
      >
        {label}
      </Ariakit.PopoverDisclosure>
      <Ariakit.Popover
        store={popover}
        gutter={8}
        portal
        unmountOnHide
        finalFocus={disclosureRef}
        className="z-[200] overflow-hidden rounded-xl border border-border-medium bg-surface-secondary shadow-lg focus:outline-none"
        style={{ width: 560, height: 460 }}
      >
        <iframe
          title="dreamer spy"
          src={`/api/dreamer/spy_ui?cid=${encodeURIComponent(conversationId)}`}
          style={{ width: '100%', height: '100%', border: 0, background: 'transparent' }}
        />
      </Ariakit.Popover>
    </>
  );
}
