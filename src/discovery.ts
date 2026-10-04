// Finds BluOS players on the LAN: LSDP announcements, known addresses, group members reported by
// found players, and a probe of /SyncStatus on every host of the local subnet(s) for devices that
// don't announce themselves (1st-gen Pulse Flex, Sub+).

import { networkInterfaces } from 'node:os';
import { syncStatus, type SyncStatus } from './bluos.ts';
import { devices } from './store.ts';
import { IGNORED_IFACES, queryLsdp } from './lsdp.ts';

function ipToInt(ip: string) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
function intToIp(n: number) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

function hostsOf(cidr: string): string[] {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr ?? 24);
  if (bits < 22) throw new Error(`Subnet ${cidr} too large to scan (use /22 or smaller)`);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const net = ipToInt(ip) & mask;
  const size = 2 ** (32 - bits);
  const out: string[] = [];
  for (let i = 1; i < size - 1; i++) out.push(intToIp(net + i));
  return out;
}

export function scanSubnets(): string[] {
  const env = process.env.BLUOS_SUBNETS?.trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const found: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (IGNORED_IFACES.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.cidr) continue;
      const bits = Number(a.cidr.split('/')[1]);
      if (bits >= 22) {
        const mask = (~0 << (32 - bits)) >>> 0;
        found.push(`${intToIp(ipToInt(a.address) & mask)}/${bits}`); // network address, e.g. 192.168.1.0/24
      }
    }
  }
  return [...new Set(found)];
}

async function probeAll(hosts: string[], timeoutMs: number): Promise<SyncStatus[]> {
  const results: SyncStatus[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      try {
        results.push(await syncStatus(host, timeoutMs));
      } catch {
        // not a BluOS player or not reachable
      }
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  return results;
}

function remember(players: SyncStatus[]) {
  const known = new Map(devices.list().map((d) => [d.mac, d]));
  for (const p of players) {
    if (!p.mac) continue;
    // A fixed-group leader reports the group name instead of its own player name.
    // A fixed-group leader reports the group name and a group model ("Stereo Pair") instead of its own.
    const prev = known.get(p.mac);
    const name = p.group ? (prev?.name ?? p.name) : p.name;
    const model = p.group ? (prev && prev.model !== p.model ? prev.model : p.model) : p.modelName || p.model;
    devices.upsert({ mac: p.mac, name, model, modelCode: p.model, version: p.version, lastIp: p.host });
    if (prev?.directIp) devices.setDirect(p.mac, '', ''); // back on the LAN
  }
}

/** Probes the given hosts only. */
export async function probeHosts(hosts: string[], timeoutMs = 1500): Promise<Map<string, SyncStatus>> {
  const players = await probeAll([...new Set(hosts)], timeoutMs);
  remember(players);
  return new Map(players.filter((p) => p.mac).map((p) => [p.mac, p]));
}

/** Full discovery, keyed by MAC. Set BLUOS_SCAN=off to rely on LSDP and known addresses only. */
export async function discover(timeoutMs = 1200): Promise<Map<string, SyncStatus>> {
  const known = new Set<string>(devices.list().map((d) => d.lastIp).filter(Boolean));
  const lsdp = new Set((await queryLsdp()).map((p) => p.ip));
  const hosts = new Set([...lsdp, ...known]);
  if (process.env.BLUOS_SCAN !== 'off') for (const cidr of scanSubnets()) for (const h of hostsOf(cidr)) hosts.add(h);
  const found = await probeHosts([...hosts], timeoutMs);
  // How it was found: LSDP and the scan say more than "known address", so they win.
  for (const p of found.values()) {
    const how = lsdp.has(p.host) ? 'LSDP' : known.has(p.host) ? '' : 'network scan';
    if (how || !devices.list().find((d) => d.mac === p.mac)?.foundBy) devices.setFoundBy(p.mac, how || 'known address');
  }

  // Group members on the LAN (e.g. a stereo partner) are listed by their leader.
  const members = [...found.values()].flatMap((p) => [...p.members, ...p.slaves].map((m) => m.id))
    .filter((ip) => !hosts.has(ip) && /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (members.length) {
    for (const [mac, p] of await probeHosts(members, timeoutMs)) { found.set(mac, p); devices.setFoundBy(mac, 'group leader'); }
  }
  return found;
}
