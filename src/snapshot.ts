// Reads the current speaker layout into a Snapshot. Speakers are identified by MAC,
// because home cinema members change IP (they move to the soundbar's private subnet).

import {
  getSlaveLevel, getVolume, memberSyncStatus,
  type SyncStatus, type VolumeState,
} from './bluos.ts';
import { discover } from './discovery.ts';
import { devices } from './store.ts';
import { readSettings, type StoredSetting } from './settings.ts';

export interface SnapshotMember {
  mac: string;
  name: string;
  model: string;
  channelMode: string;
  distance?: number;
  levelDb: number;
}

export interface SnapshotZone {
  leader: { mac: string; name: string; model: string; channelMode?: string; distance?: number };
  groupName?: string;                       // fixed group name (e.g. "Stereo", "Living Room")
  members: SnapshotMember[];                // fixed group members (stereo partner, surrounds)
  sub?: { mac: string; name: string; levelDb: number };
  dynamicSlaves: { mac: string; name: string }[];
  volume: VolumeState;
  settings: StoredSetting[];                // audio/sub settings of all speakers in the zone
  airplayName?: string;                     // AirPlay 2 receiver offered while this zone is active
}

/** Last setup read from the speakers (by refresh, scan or the end of a recall). */
export const latest: { current?: Snapshot } = {};

export interface Snapshot {
  version: 1;
  capturedAt: string;
  zones: SnapshotZone[];
}

export async function resolveMac(leader: SyncStatus, m: { id: string; port: number; name?: string }, lan: Map<string, SyncStatus>) {
  for (const p of lan.values()) if (p.host === m.id) return { mac: p.mac, name: p.name, model: p.modelName };
  try {
    const s = await memberSyncStatus(leader.host, m);
    if (s.mac) {
      const prev = devices.list().find((d) => d.mac === s.mac);
      if (prev) devices.upsert({ mac: s.mac, name: prev.name, model: s.modelName || prev.model, modelCode: s.model, lastIp: prev.lastIp });
      return { mac: s.mac, name: s.name, model: s.modelName };
    }
  } catch {
    // fall back to the registry below
  }
  const byName = devices.list().find((d) => d.name === m.name);
  if (byName) return { mac: byName.mac, name: byName.name, model: byName.model };
  throw new Error(`Cannot identify group member ${m.name || m.id} of ${leader.name}`);
}

export const macResolver = (leader: SyncStatus, lan: Map<string, SyncStatus>) =>
  (ip: string) => resolveMac(leader, { id: ip, port: 11000 }, lan);

async function captureZone(leader: SyncStatus, lan: Map<string, SyncStatus>): Promise<SnapshotZone> {
  const settings = await readSettings(leader, macResolver(leader, lan));
  const known = devices.list().find((d) => d.mac === leader.mac);
  const zone: SnapshotZone = {
    leader: {
      mac: leader.mac,
      name: leader.group ? (known?.name ?? leader.name) : leader.name,
      model: leader.modelName,
      channelMode: leader.channelMode,
      distance: leader.distance,
    },
    groupName: leader.group,
    members: [],
    dynamicSlaves: [],
    volume: await getVolume(leader.host),
    settings,
  };

  for (const m of leader.members) {
    const id = await resolveMac(leader, m, lan);
    const levelDb = await getSlaveLevel(leader.host, m).catch(() => 0);
    if (m.isSub) zone.sub = { mac: id.mac, name: id.name, levelDb };
    else zone.members.push({ mac: id.mac, name: id.name, model: id.model, channelMode: m.channelMode, distance: m.distance, levelDb });
  }
  for (const s of leader.slaves) {
    const id = await resolveMac(leader, s, lan);
    zone.dynamicSlaves.push({ mac: id.mac, name: id.name });
  }
  return zone;
}

/** Players that are not members of another player's group. */
export function roots(lan: Map<string, SyncStatus>): SyncStatus[] {
  return [...lan.values()].filter((p) => !p.master);
}

export async function captureSnapshot(lan?: Map<string, SyncStatus>): Promise<Snapshot> {
  const players = lan ?? (await discover());
  const zones: SnapshotZone[] = [];
  for (const p of roots(players)) zones.push(await captureZone(p, players));
  zones.sort((a, b) => a.leader.name.localeCompare(b.leader.name));
  return { version: 1, capturedAt: new Date().toISOString(), zones };
}

/** Key describing a zone's layout (not volumes); equal keys mean the zone needs no rebuild. */
export const isSurround = (z: SnapshotZone) => z.members.some((m) => !['left', 'right'].includes(m.channelMode));

// Distances are part of the layout for surround groups: they can only be set when the group is created.
export function zoneKey(z: SnapshotZone): string {
  const dist = (d?: number) => (isSurround(z) ? `@${(d ?? 0).toFixed(1)}` : '');
  return JSON.stringify([
    z.leader.mac, z.leader.channelMode ?? '', z.groupName ?? '', dist(z.leader.distance),
    z.members.map((m) => `${m.mac}:${m.channelMode}${dist(m.distance)}`).sort(),
    z.sub?.mac ?? '',
    z.dynamicSlaves.map((s) => s.mac).sort(),
  ]);
}

export function zoneMacs(z: SnapshotZone): string[] {
  return [z.leader.mac, ...z.members.map((m) => m.mac), ...(z.sub ? [z.sub.mac] : []), ...z.dynamicSlaves.map((s) => s.mac)];
}

export interface ZoneEdit {
  leaderMac: string;
  airplayName?: string;
  leaderDistance?: number;
  volume?: { level: number; mute: boolean };
  members?: { mac: string; levelDb?: number; distance?: number }[];
  sub?: { levelDb: number };
  settings?: { owner: string; name: string; value: string }[];
}

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
const checkNum = (v: unknown, min: number, max: number, what: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${what} must be between ${min} and ${max}`);
  return v;
};

function checkSetting(s: StoredSetting, value: unknown): string {
  if (typeof value !== 'string' || value.length > 50) throw bad(`${s.label}: invalid value`);
  const m = s.meta;
  if (!m) return value;
  if (m.options && !m.options.some((o) => o.value === value)) throw bad(`${s.label}: ${value} is not an allowed value`);
  const lo = m.min ?? -Infinity, hi = m.max ?? Infinity;
  if (m.type === 'range') checkNum(Number(value), lo, hi, s.label);
  if (m.type === 'dual-range') {
    const [a, b] = value.split(',').map(Number);
    checkNum(a, lo, hi, s.label); checkNum(b, lo, hi, s.label);
    if (a > b) throw bad(`${s.label}: lower limit above upper limit`);
  }
  return value;
}

/** Applies edited values to a stored snapshot. Only values change; the layout stays as captured. */
export function applyEdits(snapshot: Snapshot, edits: ZoneEdit[]): Snapshot {
  const next: Snapshot = structuredClone(snapshot);
  for (const e of edits) {
    const z = next.zones.find((x) => x.leader.mac === e.leaderMac);
    if (!z) throw bad(`Unknown zone ${e.leaderMac}`);
    if (e.airplayName !== undefined) {
      const n = String(e.airplayName).trim();
      if (n.length > 50) throw bad('AirPlay name is too long');
      if (n) z.airplayName = n; else delete z.airplayName;
    }
    if (e.leaderDistance !== undefined) z.leader.distance = checkNum(e.leaderDistance, 0, 30, 'Distance');
    if (e.volume) {
      const level = checkNum(e.volume.level, 0, 100, 'Volume');
      z.volume = e.volume.mute ? { level: 0, mute: true, muteLevel: level } : { level, mute: false };
    }
    for (const me of e.members ?? []) {
      const m = z.members.find((x) => x.mac === me.mac);
      if (!m) throw bad(`Unknown member ${me.mac}`);
      if (me.levelDb !== undefined) m.levelDb = checkNum(me.levelDb, -10, 10, 'Level');
      if (me.distance !== undefined) m.distance = checkNum(me.distance, 0, 30, 'Distance');
    }
    if (e.sub && z.sub) z.sub.levelDb = checkNum(e.sub.levelDb, -10, 10, 'Sub level');
    for (const se of e.settings ?? []) {
      const s = z.settings.find((x) => x.owner === se.owner && x.name === se.name);
      if (!s) throw bad(`Unknown setting ${se.name}`);
      // Only changed values are validated, so a stored value the speaker no longer lists never blocks a save.
      if (se.value !== s.value) s.value = checkSetting(s, se.value);
    }
  }
  return next;
}

/** Keeps user-set values that a fresh capture does not contain (AirPlay names). */
export function carryOver(previous: Snapshot, fresh: Snapshot): Snapshot {
  for (const z of fresh.zones) {
    const old = previous.zones.find((o) => o.leader.mac === z.leader.mac);
    if (old?.airplayName) z.airplayName = old.airplayName;
  }
  return fresh;
}

/** Adds missing setting metadata (allowed values) to stored snapshots from a live read. */
export function backfillMeta(stored: Snapshot, live: Snapshot): Snapshot | undefined {
  const liveMeta = new Map(live.zones.flatMap((z) => z.settings).filter((s) => s.meta).map((s) => [`${s.owner}|${s.name}`, s.meta!]));
  let changed = false;
  for (const z of stored.zones) for (const s of z.settings) {
    const m = !s.meta && liveMeta.get(`${s.owner}|${s.name}`);
    if (m) { s.meta = m; changed = true; }
  }
  return changed ? stored : undefined;
}

/** A snapshot is active when every zone in it matches the current layout (volume, levels and settings ignored). */
export function isActive(stored: Snapshot, current: Snapshot): boolean {
  const keys = new Set(current.zones.map(zoneKey));
  return stored.zones.every((z) => keys.has(zoneKey(z)));
}
