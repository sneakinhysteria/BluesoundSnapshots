// Lenbrook Service Discovery Protocol (BluOS API v1.7, appendix 13.1): UDP broadcast on port 11430.
// Players answer a Query with an Announce (node id = MAC, IPv4 address, TXT records) and repeat
// it about once a minute. Not every device implements it (a 1st-gen Pulse Flex and the Sub+ were
// silent in testing), so discovery also scans the local subnet.

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

const PORT = 11430;
// Docker, VM and VPN interfaces never have speakers behind them.
export const IGNORED_IFACES = /^(lo|docker|br-|veth|virbr|vnet|tailscale|tun|wg|zt)/;
const CLASS_PLAYER = 0x0001;

export interface LsdpPlayer { ip: string; mac: string; name?: string; port: number; seenAt: number }

const players = new Map<string, LsdpPlayer>(); // by IP
let socket: Socket | undefined;

const QUERY = Buffer.from([6, ...Buffer.from('LSDP'), 1, 5, 0x51, 1, CLASS_PLAYER >> 8, CLASS_PLAYER & 0xff]);

function parse(msg: Buffer) {
  if (msg.length < 6 || msg.toString('latin1', 1, 5) !== 'LSDP') return;
  let i = msg[0];
  while (i < msg.length) {
    const len = msg[i];
    if (!len) return;
    const m = msg.subarray(i, i + len);
    i += len;
    if (m[1] !== 0x41) continue; // only Announce messages
    let j = 2;
    const nodeLen = m[j++];
    const node = m.subarray(j, j + nodeLen); j += nodeLen;
    const addrLen = m[j++];
    const ip = [...m.subarray(j, j + addrLen)].join('.'); j += addrLen;
    const count = m[j++];
    for (let r = 0; r < count && j < m.length; r++) {
      const cls = m.readUInt16BE(j); j += 2;
      const txtCount = m[j++];
      const txt: Record<string, string> = {};
      for (let t = 0; t < txtCount; t++) {
        const kl = m[j++]; const k = m.toString('utf8', j, j + kl); j += kl;
        const vl = m[j++]; txt[k] = m.toString('utf8', j, j + vl); j += vl;
      }
      if (cls === CLASS_PLAYER && addrLen === 4) {
        const mac = nodeLen === 6 ? [...node].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase() : node.toString('utf8');
        players.set(ip, { ip, mac, name: txt.name, port: Number(txt.port ?? 11000), seenAt: Date.now() });
      }
    }
  }
}

function broadcastAddresses(): string[] {
  const out = new Set(['255.255.255.255']);
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (IGNORED_IFACES.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, k) => (o | (~mask[k] & 255))).join('.'));
    }
  }
  return [...out];
}

export function startLsdp(warn: (msg: string) => void) {
  if (socket) return;
  socket = createSocket({ type: 'udp4', reuseAddr: true, reusePort: true });
  socket.on('message', parse);
  socket.on('error', (e) => { warn(`LSDP disabled: ${e.message}`); socket?.close(); socket = undefined; });
  socket.bind(PORT, () => socket?.setBroadcast(true));
}

/** Sends a query and returns the players heard so far (including earlier announcements). */
export async function queryLsdp(waitMs = 1500): Promise<LsdpPlayer[]> {
  if (socket) for (const addr of broadcastAddresses()) socket.send(QUERY, PORT, addr, () => {});
  await new Promise((r) => setTimeout(r, waitMs));
  const fresh = Date.now() - 10 * 60_000;
  return [...players.values()].filter((p) => p.seenAt > fresh);
}
