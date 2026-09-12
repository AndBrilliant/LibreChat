import { useEffect, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';

/**
 * ADR fork — Athena power/sleep countdown + settings, mounted in the chat
 * header next to the bookmarks / multi-convo buttons.
 *
 * Reads the athena-gateway idle ladder (served same-origin via the Caddy
 * `/athena/*` route on chat.ad-research.org -> :9030, so no CORS or mixed
 * content). Shows time until the model unloads (L1, host stays up) and until
 * full poweroff (L2), ticking locally between the 10s polls — state
 * transitions are therefore noticed at the next poll, not pushed.
 *
 * The label is a disclosure: it opens a small popover to set the L1/L2 idle
 * thresholds (minutes) via POST /athena/power/config (gateway persists them).
 * When the model is asleep/off, a ⚡ wake button posts /athena/power/wake
 * (gateway: host up -> just start the service; host off -> power on).
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
  const [waking, setWaking] = useState(false);
  const [, setNow] = useState(0);
  const [l1min, setL1min] = useState('');
  const [l2min, setL2min] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const popover = Ariakit.usePopoverStore({ placement: 'bottom' });
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const isOpen = popover.useState('open');

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
          if (j.level === 'ready') {
            setWaking(false);
          }
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

  useEffect(() => {
    if (isOpen && stamp) {
      setL1min(String(Math.round(stamp.l1_after / 60)));
      setL2min(String(Math.round(stamp.l2_after / 60)));
      setSaveMsg('');
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
    title = 'Athena on hold — idle unload/poweroff disabled. Click for sleep settings.';
  } else if (stamp.level === 'off') {
    label = '💤 athena off';
    title = 'Athena is powered off. Click for sleep settings.';
  } else if (stamp.level === 'loading') {
    label = '🔄 athena loading';
    title = `Athena is loading ${stamp.current_model ?? 'a model'}…`;
  } else if (stamp.level === 'l1-sleep' || toL1 <= 0) {
    label = `💤 model asleep · off in ${fmt(toL2)}`;
    title = `Model unloaded (L1 sleep, host up). Full poweroff (L2) in ${fmt(toL2)}. Click for sleep settings.`;
  } else {
    label = `🌙 unload in ${fmt(toL1)} · off in ${fmt(toL2)}`;
    title = `Idle ${fmt(idle)} / ${stamp.l1_after}s. L1 = unload model (host up) in ${fmt(toL1)}; L2 = poweroff in ${fmt(toL2)}. Click for sleep settings.`;
  }

  const asleep = stamp.level === 'off' || stamp.level === 'l1-sleep' || toL1 <= 0;
  const loading = stamp.level === 'loading';
  const wake = async () => {
    setWaking(true);
    try {
      await fetch('/athena/power/wake', { method: 'POST' });
    } catch {
      setWaking(false);
    }
  };

  const save = async () => {
    const l1 = Math.round(parseFloat(l1min) * 60);
    const l2 = Math.round(parseFloat(l2min) * 60);
    if (!Number.isFinite(l1) || !Number.isFinite(l2) || l1 < 30 || l2 < 30) {
      setSaveMsg('minutes? (min 0.5)');
      return;
    }
    try {
      const r = await fetch(`/athena/power/config?l1=${l1}&l2=${l2}`, {
        method: 'POST',
      });
      const ct = r.headers.get('content-type') ?? '';
      if (!r.ok || !ct.includes('json')) {
        throw new Error('bad response');
      }
      const j = await r.json();
      setStamp((s) => (s ? { ...s, l1_after: j.l1_idle, l2_after: j.l2_idle } : s));
      setSaveMsg(`saved · L1 ${Math.round(j.l1_idle / 60)}m · L2 ${Math.round(j.l2_idle / 60)}m`);
    } catch {
      setSaveMsg('save failed');
    }
  };

  const inputCls =
    'w-16 rounded-md border border-border-medium bg-transparent px-2 py-1 text-xs text-text-primary focus:outline-none';

  return (
    <span className="ml-1 flex select-none items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium">
      <Ariakit.PopoverDisclosure
        ref={disclosureRef}
        store={popover}
        type="button"
        title={title}
        data-testid="athena-power-badge"
        className="rounded-full px-1 py-0.5 transition-colors hover:bg-surface-hover"
        style={{ color, opacity: 0.85 }}
      >
        {label}
      </Ariakit.PopoverDisclosure>
      {(asleep || waking || loading) && (
        <button
          type="button"
          data-testid="athena-wake-button"
          onClick={wake}
          disabled={waking || loading}
          title={
            loading || waking
              ? 'Athena is coming back up…'
              : 'Wake Athena now (starts the model, or powers the host on if it is off)'
          }
          className="rounded-full border border-border-medium px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-surface-hover disabled:opacity-60"
          style={{ color: 'var(--text-primary, #1a1715)' }}
        >
          {waking || loading ? '⏳ waking…' : '⚡ wake'}
        </button>
      )}
      <Ariakit.Popover
        store={popover}
        gutter={8}
        portal
        unmountOnHide
        finalFocus={disclosureRef}
        className="z-[200] rounded-xl border border-border-medium bg-surface-secondary p-3 text-xs shadow-lg"
        style={{ width: 250 }}
      >
        <div className="mb-2 font-semibold text-text-primary">Athena sleep settings</div>
        <label className="mb-2 flex items-center justify-between gap-2">
          <span className="text-text-secondary">L1 unload (min)</span>
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={l1min}
            onChange={(e) => setL1min(e.target.value)}
            className={inputCls}
            data-testid="athena-l1-input"
          />
        </label>
        <label className="mb-2 flex items-center justify-between gap-2">
          <span className="text-text-secondary">L2 poweroff (min)</span>
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={l2min}
            onChange={(e) => setL2min(e.target.value)}
            className={inputCls}
            data-testid="athena-l2-input"
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={save}
            data-testid="athena-settings-save"
            className="rounded-full border border-border-medium px-3 py-1 font-medium text-text-primary transition-colors hover:bg-surface-hover"
          >
            Save
          </button>
          <span className="text-text-secondary" data-testid="athena-settings-msg">
            {saveMsg}
          </span>
        </div>
        <div className="mt-2 text-[11px] text-text-secondary" style={{ opacity: 0.7 }}>
          mode: {stamp.mode} · idle {fmt(idle)}
        </div>
      </Ariakit.Popover>
    </span>
  );
}
