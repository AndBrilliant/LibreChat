import { useEffect, useState } from 'react';

/**
 * ADR fork — Athena power/sleep countdown, mounted in the chat header next to
 * the bookmarks / multi-convo buttons.
 *
 * Reads the athena-gateway idle ladder (served same-origin via the Caddy
 * `/athena/*` route on chat.ad-research.org -> :9030, so no CORS or mixed
 * content). Shows time until the model unloads (L1, host stays up) and until
 * full poweroff (L2), ticking locally between polls. Hidden when the gateway
 * is unreachable or the vhost has no /athena route.
 */

const POLL_MS = 10000;
const TICK_MS = 1000;

interface PowerStatus {
  mode: string;
  level: string;
  current_model: string | null;
  idle_seconds: number;
  l1_after: number;
  l2_after: number;
  backend_up: boolean;
}

interface Stamp extends PowerStatus {
  fetchedAt: number;
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

export default function AthenaPowerBadge(): JSX.Element | null {
  const [stamp, setStamp] = useState<Stamp | null>(null);
  const [, setNow] = useState(0);

  useEffect(() => {
    let dead = false;
    const poll = async () => {
      try {
        const r = await fetch('/athena/power');
        const ct = r.headers.get('content-type') ?? '';
        if (!r.ok || !ct.includes('json')) {
          throw new Error('not json');
        }
        const j = await r.json();
        if (!dead && j && typeof j.idle_seconds === 'number') {
          setStamp({ ...j, fetchedAt: Date.now() });
        }
      } catch {
        if (!dead) {
          setStamp(null);
        }
      }
    };
    poll();
    const pid = setInterval(poll, POLL_MS);
    const tid = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      dead = true;
      clearInterval(pid);
      clearInterval(tid);
    };
  }, []);

  if (!stamp) {
    return null;
  }

  const idle = stamp.idle_seconds + (Date.now() - stamp.fetchedAt) / 1000;
  const toL1 = stamp.l1_after - idle;
  const toL2 = stamp.l2_after - idle;

  let label: string;
  let color = 'var(--text-secondary, #6b7280)';
  let title: string;

  if (stamp.mode === 'hold') {
    label = '⚡ athena hold';
    color = 'var(--text-primary, #1a1715)';
    title = 'Athena on hold — idle unload/poweroff disabled.';
  } else if (stamp.level === 'off') {
    label = '💤 athena off';
    title = 'Athena is powered off — the next message wakes her (~2 min).';
  } else if (stamp.level === 'loading') {
    label = '🔄 athena loading';
    title = `Athena is loading ${stamp.current_model ?? 'a model'}…`;
  } else if (stamp.level === 'l1-sleep' || toL1 <= 0) {
    label = `💤 L1 · L2 in ${fmt(toL2)}`;
    title = `Model unloaded (L1 sleep, host up). Full poweroff (L2) in ${fmt(toL2)}.`;
  } else {
    label = `🌙 L1 in ${fmt(toL1)} · L2 in ${fmt(toL2)}`;
    title = `Idle ${fmt(idle)} / ${stamp.l1_after}s. L1 = unload model (host up) in ${fmt(toL1)}; L2 = poweroff in ${fmt(toL2)}. Sending a message resets the clock.`;
  }

  return (
    <span
      data-testid="athena-power-badge"
      title={title}
      className="ml-1 flex select-none items-center whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium"
      style={{ color, opacity: 0.75 }}
    >
      {label}
    </span>
  );
}
