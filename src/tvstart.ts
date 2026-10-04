// Volume when the TV starts: when a player switches to a TV input (HDMI ARC/eARC, optical…),
// set a fixed volume or cap it at a maximum. TVs and streaming boxes often send a volume over
// CEC shortly after power-on, so in "max" mode CEC increases above the cap are corrected for a
// while afterwards.

import { bluosGet, getVolume } from './bluos.ts';
import { events, kv } from './store.ts';
import { expectVolume } from './origin.ts';
import { onTvStart, type VolumeChange } from './guard.ts';

export interface TvStartConfig {
  mode: 'off' | 'fixed' | 'max';
  level: number;
  inputs: string[];     // input names (as shown in BluOS); empty = names containing TV, HDMI or ARC
}

export interface PlaybackInfo { state: string; service: string; inputId: string; title: string }

const SETTLE_MS = 3000;
const PROTECT_MS = 90_000;
const DEFAULT_INPUT = /\b(tv|hdmi|e?arc)\b/i;

let config: TvStartConfig = kv.get<TvStartConfig>('tvStart') ?? { mode: 'off', level: 30, inputs: [] };
const knownInputs = new Set<string>(kv.get<string[]>('captureInputs') ?? []);
const lastInput = new Map<string, string>();       // by MAC: current input key
const protectUntil = new Map<string, { until: number; host: string }>();

export const tvStartConfig = () => ({ ...config, knownInputs: [...knownInputs].sort() });

export function setTvStartConfig(c: Partial<TvStartConfig>) {
  const next = { ...config, ...c };
  if (!['off', 'fixed', 'max'].includes(next.mode)) throw Object.assign(new Error('mode must be off, fixed or max'), { statusCode: 400 });
  if (!Number.isInteger(next.level) || next.level < 0 || next.level > 100) throw Object.assign(new Error('level must be 0–100'), { statusCode: 400 });
  if (!Array.isArray(next.inputs) || next.inputs.some((i) => typeof i !== 'string')) throw Object.assign(new Error('inputs must be a list of names'), { statusCode: 400 });
  config = next;
  kv.set('tvStart', config);
}

const isTvInput = (name: string) => (config.inputs.length ? config.inputs.includes(name) : DEFAULT_INPUT.test(name));

async function apply(mac: string, host: string, player: string, input: string) {
  const { level } = await getVolume(host);
  const target = config.mode === 'fixed' ? config.level : Math.min(level, config.level);
  if (config.mode === 'max') protectUntil.set(mac, { until: Date.now() + PROTECT_MS, host });
  if (target === level) return;
  expectVolume(host, target, 'TV start');
  await bluosGet(host, '/Volume', { level: target, tell_slaves: 0 });
  events.add({ mac, player, kind: 'guard', detail: `TV start (${input}): volume ${level} → ${target} (${config.mode === 'fixed' ? 'fixed' : 'max'} ${config.level})` });
}

/** Called by the monitor when a player's playback status changes. */
export function onPlaybackChange(mac: string, host: string, player: string, p: PlaybackInfo) {
  const key = p.service === 'Capture' ? `${p.inputId}|${p.title}` : p.service;
  const prev = lastInput.get(mac);
  lastInput.set(mac, key);
  if (p.service !== 'Capture' || !p.title) return;
  if (!knownInputs.has(p.title)) { knownInputs.add(p.title); kv.set('captureInputs', [...knownInputs]); }
  // First observation after a restart is not a switch.
  if (prev === undefined || prev === key || !isTvInput(p.title)) return;
  if (!['stream', 'play'].includes(p.state)) return;
  onTvStart(mac);
  if (config.mode === 'off') return;
  setTimeout(() => apply(mac, host, player, p.title).catch((e) =>
    events.add({ mac, player, kind: 'guard', detail: `TV start volume failed: ${e.message}` })), SETTLE_MS);
}

/** Called by the monitor for volume changes: caps CEC increases shortly after a TV start. */
export function onVolumeAfterStart(c: VolumeChange) {
  const p = protectUntil.get(c.mac);
  if (!p || Date.now() > p.until || c.source !== 'CEC' || config.mode !== 'max' || c.to <= config.level) return;
  expectVolume(c.host, config.level, 'TV start');
  bluosGet(c.host, '/Volume', { level: config.level, tell_slaves: 0 })
    .then(() => events.add({ mac: c.mac, player: c.player, kind: 'guard', detail: `TV start: CEC volume ${c.to} capped to ${config.level}` }))
    .catch(() => {});
}
