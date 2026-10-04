// Volume guard: undoes volume changes a TV sends by itself over HDMI-CEC.
// Observed on a Philips 58PUS8506 (2026-10): every ~15 min 01 s a CEC volume command, either one
// step or a burst of three (first two ~0.13 s apart). For months it drifted up, then down, so both
// directions are guarded. Manual remote clicks arrive >1 s apart and outside the rhythm.

import { bluosGet } from './bluos.ts';
import { events, kv } from './store.ts';

export interface VolumeChange { mac: string; host: string; player: string; from: number; to: number; source: string; t: number }

interface GuardConfig { enabled: boolean }
interface GuardState {
  anchor?: number;      // time of the last detected drift (ms)
  periodMs: number;     // learned period between drifts
  undone: number;       // number of undone sequences
  lastAction?: string;
}

const COLLECT_MS = 1500;          // a burst is judged as a whole
const BURST_GAP_MS = 300;         // steps closer than this are not manual clicks
const WINDOW_MS = 20_000;         // tolerance around the expected drift time
const MAX_CYCLES = 8;             // beyond ~2 h the rhythm is re-learned from the next burst
const DEFAULT_PERIOD_MS = 901_000;

let config: GuardConfig = kv.get<GuardConfig>('guard') ?? { enabled: false };
const state: GuardState = kv.get<GuardState>('guardState') ?? { periodMs: DEFAULT_PERIOD_MS, undone: 0 };
const pending = new Map<string, VolumeChange[]>(); // by MAC
const persist = () => kv.set('guardState', state);

export function guardInfo() {
  const next = state.anchor ? nextExpected(Date.now()) : undefined;
  return { enabled: config.enabled, periodS: Math.round(state.periodMs / 100) / 10, undone: state.undone,
    lastAction: state.lastAction ?? null, lastDrift: state.anchor ? new Date(state.anchor).toISOString() : null,
    nextExpected: next ? new Date(next).toISOString() : null };
}

export function setGuardEnabled(enabled: boolean) {
  config = { enabled };
  kv.set('guard', config);
}

function nextExpected(now: number): number | undefined {
  if (!state.anchor) return undefined;
  const k = Math.ceil((now - state.anchor) / state.periodMs);
  return k <= MAX_CYCLES ? state.anchor + Math.max(k, 1) * state.periodMs : undefined;
}

function inRhythm(t: number): boolean {
  if (!state.anchor) return false;
  const k = Math.round((t - state.anchor) / state.periodMs);
  return k >= 1 && k <= MAX_CYCLES && Math.abs(t - (state.anchor + k * state.periodMs)) <= WINDOW_MS;
}

function learn(t: number) {
  if (state.anchor) {
    const k = Math.round((t - state.anchor) / state.periodMs);
    const measured = k >= 1 && k <= MAX_CYCLES ? (t - state.anchor) / k : undefined;
    // Only plausible measurements adjust the period, smoothed.
    if (measured && Math.abs(measured - DEFAULT_PERIOD_MS) < 60_000) state.periodMs = Math.round(state.periodMs * 0.7 + measured * 0.3);
  }
  state.anchor = t;
}

async function judge(seq: VolumeChange[]) {
  const first = seq[0], last = seq[seq.length - 1];
  const burst = seq.some((c, i) => i > 0 && c.t - seq[i - 1].t < BURST_GAP_MS);
  const rhythm = inRhythm(first.t);
  if (!burst && !rhythm) return; // treated as a manual change
  learn(first.t);
  const why = burst ? 'burst' : '15-min rhythm';
  if (!config.enabled) {
    events.add({ mac: first.mac, player: first.player, kind: 'guard', detail: `drift detected (${why}): ${first.from} → ${last.to}, not undone (guard off)` });
    persist();
    return;
  }
  try {
    await bluosGet(first.host, '/Volume', { level: first.from, tell_slaves: 0 });
    state.undone++;
    state.lastAction = new Date().toISOString();
    events.add({ mac: first.mac, player: first.player, kind: 'guard', detail: `drift undone (${why}): ${last.to} → ${first.from}` });
  } catch (e: any) {
    events.add({ mac: first.mac, player: first.player, kind: 'guard', detail: `could not undo drift: ${e.message}` });
  }
  persist();
}

/** Called by the monitor for every volume change. */
export function onVolumeChange(c: VolumeChange) {
  if (c.source !== 'CEC') return; // our own restores and app changes have other sources
  const seq = pending.get(c.mac);
  if (seq) { seq.push(c); return; }
  pending.set(c.mac, [c]);
  setTimeout(() => {
    const s = pending.get(c.mac)!;
    pending.delete(c.mac);
    judge(s).catch(() => {});
  }, COLLECT_MS);
}

/** Seeds the rhythm from the activity log after a restart (last burst of CEC steps). */
export function seedGuard() {
  if (state.anchor) return;
  const vol = events.list(300, 'volume').filter((e) => e.detail.includes('source: CEC')).reverse();
  for (let i = vol.length - 1; i > 0; i--) {
    const a = new Date(vol[i - 1].t).getTime(), b = new Date(vol[i].t).getTime();
    if (b - a < BURST_GAP_MS) { state.anchor = a; persist(); return; }
  }
}
