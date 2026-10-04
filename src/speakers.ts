// Speaker overview for the UI: every speaker ever seen, with its current role and reachability.

import { foundBy, lastDiscovered } from './discovery.ts';
import type { Snapshot } from './snapshot.ts';
import { devices } from './store.ts';

export interface SpeakerInfo {
  mac: string;
  name: string;
  model: string;
  modelCode: string;
  ip: string;
  version?: string;
  reachable: boolean;
  role: string;
  foundBy?: string;
  lastSeen: string;
}

const CHANNEL: Record<string, string> = {
  front: 'front', left: 'left channel', right: 'right channel', side_left: 'left surround', side_right: 'right surround',
  rear_left: 'left rear', rear_right: 'right rear',
};

export function speakerList(current?: Snapshot): SpeakerInfo[] {
  const lan = lastDiscovered()?.lan ?? new Map();
  const nameOf = (mac: string) => devices.list().find((d) => d.mac === mac)?.name ?? mac;
  return devices.list().map((d) => {
    const live = lan.get(d.mac);
    const zone = current?.zones.find((z) => z.leader.mac === d.mac || z.members.some((m) => m.mac === d.mac) || z.sub?.mac === d.mac);
    const label = zone ? `"${zone.groupName ?? zone.leader.name}"` : '';
    let role: string;
    if (zone && zone.leader.mac === d.mac) role = zone.members.length || zone.sub || zone.dynamicSlaves.length ? `leader of ${label}` : 'standalone';
    else if (zone && zone.sub?.mac === d.mac) role = `subwoofer in ${label}`;
    else if (zone) {
      const mode = zone.members.find((m) => m.mac === d.mac)?.channelMode ?? '';
      role = `${CHANNEL[mode] ?? 'member'} in ${label}`;
    }
    else if (live?.master) role = `member of ${nameOf(lan.get(live.master.host)?.mac ?? live.master.host)}`;
    else role = live ? 'standalone' : 'not found';
    if (!live && zone) role += ' (on the leader\'s private network)';
    return {
      mac: d.mac,
      name: d.name,
      model: live && !live.group ? live.modelName : d.model,
      modelCode: live?.model || d.modelCode,
      ip: live?.host ?? d.lastIp,
      version: live?.version,
      reachable: !!live,
      role,
      foundBy: live ? foundBy.get(d.mac) : undefined,
      lastSeen: d.seenAt,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
