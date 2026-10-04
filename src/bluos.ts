// Minimal client for the local BluOS HTTP API (port 11000).
// Command shapes are taken from captures of the BluOS controller app (docs/capture).

import { XMLParser } from 'fast-xml-parser';
import { expectVolume } from './origin.ts';

export const BLUOS_PORT = 11000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ['zoneSlave', 'slave'].includes(name),
});

type Params = Record<string, string | number | undefined>;

// BluOS does not decode '+' as a space, so encode with encodeURIComponent instead of URLSearchParams.
function query(params?: Params): string {
  if (!params) return '';
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function bluosGetText(host: string, path: string, params?: Params, timeoutMs = 5000): Promise<string> {
  const url = `http://${host}:${BLUOS_PORT}${path}${query(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${path} on ${host}: HTTP ${res.status}`);
  return res.text();
}

export async function bluosGet(host: string, path: string, params?: Params, timeoutMs = 5000): Promise<any> {
  const body = parser.parse(await bluosGetText(host, path, params, timeoutMs));
  if (body?.error) throw new Error(`${path} on ${host}: ${JSON.stringify(body.error)}`);
  return body;
}

// Settings are written as form posts, e.g. POST /alsa_setting with body "eq-bass=0.5".
export async function bluosPost(host: string, path: string, form: Record<string, string>, timeoutMs = 5000) {
  const url = `http://${host}${host.includes(':') ? '' : `:${BLUOS_PORT}`}${path}`;
  const body = Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(url, {
    method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`POST ${path} on ${host}: HTTP ${res.status}`);
}

export interface ZoneMember {
  id: string;            // IP as seen by the leader (LAN or soundbar private subnet)
  port: number;
  name: string;
  model: string;
  channelMode: string;
  distance?: number;
  isSub: boolean;        // pairSlave="true" (subwoofer pairing)
}

export interface SyncStatus {
  host: string;
  mac: string;
  name: string;
  model: string;
  modelName: string;
  version: string;
  cls: string;
  channelMode?: string;
  distance?: number;
  group?: string;
  zoneUngroup?: string;
  master?: { host: string; port: number };
  members: ZoneMember[];                          // fixed group members incl. paired sub
  slaves: { id: string; port: number }[];         // dynamic (regular) grouping
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const roundDistance = (d: number | undefined) => (d === undefined ? undefined : Math.round(d * 100) / 100);

export function parseSyncStatus(host: string, xml: any): SyncStatus {
  const s = xml.SyncStatus;
  if (!s) throw new Error(`No SyncStatus from ${host}`);
  const master = s.master
    ? { host: typeof s.master === 'string' ? s.master : s.master['#text'], port: num(s.master.port) ?? BLUOS_PORT }
    : undefined;
  return {
    host,
    mac: String(s.mac ?? '').toUpperCase(),
    name: s.name ?? '',
    model: s.model ?? '',
    modelName: s.modelName ?? '',
    version: s.version ?? '',
    cls: s.class ?? '',
    channelMode: s.channelMode || undefined,
    distance: roundDistance(num(s.distance)),
    group: s.group || undefined,
    zoneUngroup: s.zoneUngroup || undefined,
    master,
    // After a sub is unpaired the soundbar can keep a stale entry without channelMode
    // (e.g. <zoneSlave id="172.16.151.12" upgrading="true">); it is not a group member.
    members: (s.zoneSlave ?? []).filter((z: any) => z.channelMode).map((z: any) => ({
      id: z.id,
      port: num(z.port) ?? BLUOS_PORT,
      name: z.name ?? '',
      model: z.model ?? '',
      channelMode: z.channelMode ?? '',
      distance: roundDistance(num(z.distance)),
      isSub: z.pairSlave === 'true' || z.channelMode === 'subwoofer',
    })),
    slaves: (s.slave ?? []).map((z: any) => ({ id: z.id, port: num(z.port) ?? BLUOS_PORT })),
  };
}

export async function syncStatus(host: string, timeoutMs?: number): Promise<SyncStatus> {
  return parseSyncStatus(host, await bluosGet(host, '/SyncStatus', undefined, timeoutMs));
}

// SyncStatus of a group member, fetched through its leader. Needed for home cinema members,
// which live on the soundbar's private subnet and are not reachable from the LAN.
export async function memberSyncStatus(leaderHost: string, m: { id: string; port: number }): Promise<SyncStatus> {
  const xml = await bluosGet(leaderHost, '/proxyToSlave', { slave: `${m.id}:${m.port}`, url: '/SyncStatus' });
  return parseSyncStatus(m.id, xml);
}

export async function getSlaveLevel(leaderHost: string, m: { id: string; port: number }): Promise<number> {
  const xml = await bluosGet(leaderHost, '/SlaveVolume', { slave: m.id, port: m.port });
  const v = xml.slaveVolume;
  return num(typeof v === 'object' ? v['#text'] : v) ?? 0;
}

export async function setSlaveLevel(leaderHost: string, m: { id: string; port: number }, db: number) {
  await bluosGet(leaderHost, '/SlaveVolume', { db, port: m.port, slave: m.id });
}

export interface VolumeState { level: number; mute: boolean; muteLevel?: number }

export async function getVolume(host: string): Promise<VolumeState> {
  const v = (await bluosGet(host, '/Volume')).volume;
  return {
    level: num(v['#text']) ?? 0,
    mute: v.mute === '1',
    muteLevel: num(v.muteVolume),
  };
}

export async function setVolume(host: string, v: VolumeState, origin = 'Recall') {
  expectVolume(host, v.mute ? (v.muteLevel ?? v.level) : v.level, origin);
  if (v.mute) {
    await bluosGet(host, '/Volume', { level: v.muteLevel ?? v.level, tell_slaves: 0 });
    expectVolume(host, 0, origin); // muting reports level 0
    await bluosGet(host, '/Volume', { mute: 1, tell_slaves: 0 });
  } else {
    await bluosGet(host, '/Volume', { level: v.level, tell_slaves: 0 });
  }
}
