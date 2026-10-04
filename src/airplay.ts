// AirPlay 2 receivers for BluOS zones that lack AirPlay 2 (e.g. a Pulse Flex stereo pair).
// One shairport-sync process per bridge outputs PCM on stdout; players fetch it as FLAC from
// /stream/airplay/<id>. A bridge only exists while its snapshot zone is the active layout.
// Session hooks (start/stop/volume) call back into /internal/airplay/<id>/<event>.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bluosGet, syncStatus } from './bluos.ts';
import { probeHosts } from './discovery.ts';
import { selfUrl, PCM } from './stream.ts';
import { zoneKey, type Snapshot } from './snapshot.ts';
import { devices, snapshots } from './store.ts';

interface Bridge {
  id: string;            // stable per AirPlay name, used in URLs
  name: string;          // advertised AirPlay name
  leaderMac: string;
  index: number;         // offsets port and device id between instances
  proc: ChildProcess;
  sinks: Set<NodeJS.WritableStream>;
  playing: boolean;
}

const bridges = new Map<string, Bridge>();
const HOOK = join(import.meta.dirname, '..', 'docker', 'airplay-hook.sh');
const available = spawnSync('shairport-sync', ['-V']).status === 0;
let log: (msg: string) => void = console.log;

export const airplayAvailable = () => available;
export const setAirplayLogger = (fn: (msg: string) => void) => { log = fn; };

const idOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'airplay';
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function config(b: Omit<Bridge, 'proc' | 'sinks' | 'playing'>): string {
  const hook = (event: string) => quote(`${HOOK} ${b.id} ${event}`);
  return `general = {
  name = ${quote(b.name)};
  output_backend = "stdout";
  port = ${7000 + b.index};
  airplay_device_id_offset = ${b.index};
  // AirPlay volume is applied on the BluOS player; shairport's own attenuation made the output near-silent.
  ignore_volume_control = "yes";
};
stdout = {
  output_rate = ${PCM.rate};
  output_format = "S16_LE";
  output_channels = ${PCM.channels};
};
sessioncontrol = {
  run_this_before_play_begins = ${hook('start')};
  run_this_after_play_ends = ${hook('stop')};
  run_this_when_volume_is_set = ${hook('volume')};
  wait_for_completion = "no";
  allow_session_interruption = "yes";
};
`;
}

function start(name: string, leaderMac: string) {
  const id = idOf(name);
  const used = new Set([...bridges.values()].map((b) => b.index));
  let index = 0;
  while (used.has(index)) index++;
  const conf = join(tmpdir(), `shairport-${id}.conf`);
  writeFileSync(conf, config({ id, name, leaderMac, index }));
  const proc = spawn('shairport-sync', ['-c', conf], { stdio: ['ignore', 'pipe', 'pipe'] });
  const bridge: Bridge = { id, name, leaderMac, index, proc, sinks: new Set(), playing: false };
  proc.stdout!.on('data', (chunk: Buffer) => {
    for (const s of bridge.sinks) s.write(chunk);
  });
  proc.stderr!.on('data', (d: Buffer) => log(`[airplay ${name}] ${d.toString().trim()}`));
  proc.on('exit', (code) => {
    log(`[airplay ${name}] exited (${code})`);
    if (bridges.get(id) === bridge) bridges.delete(id);
  });
  bridges.set(id, bridge);
  log(`AirPlay receiver "${name}" started`);
}

function stop(b: Bridge) {
  bridges.delete(b.id);
  b.proc.kill();
  for (const s of b.sinks) s.end();
  log(`AirPlay receiver "${b.name}" stopped`);
}

let lastCurrent: Snapshot | undefined;

/** Starts receivers for snapshot zones that match the current layout, stops all others. */
export function reconcileAirplay(current = lastCurrent) {
  if (!available || !current) return;
  lastCurrent = current;
  const currentKeys = new Set(current.zones.map(zoneKey));
  const wanted = new Map<string, { name: string; leaderMac: string }>();
  for (const s of snapshots.list()) {
    for (const z of s.data.zones) {
      if (z.airplayName && currentKeys.has(zoneKey(z))) wanted.set(idOf(z.airplayName), { name: z.airplayName, leaderMac: z.leader.mac });
    }
  }
  for (const b of [...bridges.values()]) {
    const w = wanted.get(b.id);
    if (!w || w.leaderMac !== b.leaderMac || w.name !== b.name) stop(b);
  }
  for (const [id, w] of wanted) if (!bridges.has(id)) start(w.name, w.leaderMac);
}

export function airplayStatus() {
  return [...bridges.values()].map((b) => ({ id: b.id, name: b.name, leaderMac: b.leaderMac, playing: b.playing }));
}

export function pcmSource(id: string) {
  const b = bridges.get(id);
  if (!b) return undefined;
  return {
    subscribe(sink: NodeJS.WritableStream) {
      b.sinks.add(sink);
      return () => b.sinks.delete(sink);
    },
  };
}

async function leaderHost(mac: string): Promise<string> {
  const known = devices.list().find((d) => d.mac === mac);
  if (known?.lastIp) {
    const s = await syncStatus(known.lastIp).catch(() => undefined);
    if (s?.mac === mac) return s.host;
  }
  const lan = await probeHosts(devices.list().map((d) => d.lastIp).filter(Boolean));
  const p = lan.get(mac);
  if (!p) throw new Error(`Leader ${mac} not reachable`);
  return p.host;
}

// AirPlay volume: -30 (min) .. 0 (max) dB, -144 = mute. Mapped linearly to BluOS 0..100.
const toLevel = (airplayDb: number) => (airplayDb <= -30 ? 0 : Math.round(((airplayDb + 30) / 30) * 100));
let volumeTimer: NodeJS.Timeout | undefined;

export async function airplayEvent(id: string, event: string, arg?: string) {
  const b = bridges.get(id);
  if (!b) return;
  const host = await leaderHost(b.leaderMac);
  if (event === 'start') {
    b.playing = true;
    log(`AirPlay "${b.name}": playback started`);
    await bluosGet(host, '/Play', { url: `${selfUrl(host)}/stream/airplay/${b.id}.flac` }, 15_000);
  } else if (event === 'stop') {
    b.playing = false;
    log(`AirPlay "${b.name}": playback ended`);
    // Only stop the player if it is still playing this bridge, not another source.
    const status = await bluosGet(host, '/Status');
    if (String(status?.status?.streamUrl ?? '').includes(`/stream/airplay/${b.id}`)) await bluosGet(host, '/Stop');
  } else if (event === 'volume' && arg !== undefined) {
    const level = toLevel(Number(arg.split(',')[0]));
    if (!Number.isFinite(level)) return;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => bluosGet(host, '/Volume', { level, tell_slaves: 0 }).catch(() => {}), 250);
  }
}

export function stopAllAirplay() {
  for (const b of [...bridges.values()]) stop(b);
}
