// Now-playing metadata of AirPlay bridges. shairport-sync writes it to a pipe as a stream of
// <item><type>…</type><code>…</code><length>…</length><data encoding="base64">…</data></item>
// (type/code as hex of four ASCII chars). Senders (iPhone, iPad, Mac, any app) provide title,
// artist, album, cover art and progress; BluOS itself only sees an untitled FLAC stream.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';

export interface NowPlaying {
  title?: string;
  artist?: string;
  album?: string;
  durationS?: number;
  positionS?: number;
  positionAt?: string;     // when positionS was valid
  coverId?: string;        // changes with the cover; use as cache key
  updatedAt?: string;
}

const RATE = 44100;
export const nowPlayingBus = new EventEmitter();
nowPlayingBus.setMaxListeners(100);

const state = new Map<string, NowPlaying>();
const covers = new Map<string, { data: Buffer; mime: string }>();

export const nowPlaying = (id: string) => state.get(id);
export const cover = (id: string) => covers.get(id);

const fourcc = (hex: string) => Buffer.from(hex, 'hex').toString('latin1');

function mimeOf(b: Buffer) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  return 'application/octet-stream';
}

function update(id: string, patch: Partial<NowPlaying>) {
  const next = { ...(state.get(id) ?? {}), ...patch, updatedAt: new Date().toISOString() };
  state.set(id, next);
  nowPlayingBus.emit('update', id, next);
}

/** Handles one metadata item. Exported for tests. */
export function handleItem(id: string, type: string, code: string, data?: Buffer) {
  const text = () => data?.toString('utf8') ?? '';
  if (type === 'core') {
    if (code === 'minm') update(id, { title: text() });
    else if (code === 'asar') update(id, { artist: text() });
    else if (code === 'asal') update(id, { album: text() });
  } else if (type === 'ssnc') {
    if (code === 'PICT') {
      if (!data?.length) { covers.delete(id); update(id, { coverId: undefined }); return; }
      covers.set(id, { data, mime: mimeOf(data) });
      update(id, { coverId: createHash('sha1').update(data).digest('hex').slice(0, 12) });
    } else if (code === 'prgr') {
      // "start/current/end" in RTP frames
      const [start, cur, end] = text().split('/').map(Number);
      if ([start, cur, end].every(Number.isFinite)) {
        update(id, { durationS: Math.max(0, (end - start) / RATE), positionS: Math.max(0, (cur - start) / RATE), positionAt: new Date().toISOString() });
      }
    } else if (code === 'pend') {
      update(id, { positionS: undefined, positionAt: undefined });
    }
  }
}

/** Parses shairport-sync's metadata format from a text stream. Exported for tests. */
export function createParser(id: string) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let end: number;
    while ((end = buf.indexOf('</item>')) >= 0) {
      const item = buf.slice(0, end);
      buf = buf.slice(end + 7);
      const type = item.match(/<type>([0-9a-f]{8})<\/type>/)?.[1];
      const code = item.match(/<code>([0-9a-f]{8})<\/code>/)?.[1];
      if (!type || !code) continue;
      const b64 = item.match(/<data encoding="base64">\s*([\s\S]*?)<\/data>/)?.[1];
      handleItem(id, fourcc(type), fourcc(code), b64 !== undefined ? Buffer.from(b64.replace(/\s+/g, ''), 'base64') : undefined);
    }
    if (buf.length > 20_000_000) buf = ''; // runaway protection
  };
}

/** Reads a bridge's metadata pipe until it is closed; reopens when the writer reconnects. */
export function readMetadataPipe(id: string, path: string, isActive: () => boolean) {
  const parse = createParser(id);
  const open = () => {
    if (!isActive()) return;
    const s = createReadStream(path, { encoding: 'latin1' }); // base64 and tags are ASCII
    s.on('data', (c) => parse(String(c)));
    s.on('error', () => setTimeout(open, 2000));
    s.on('end', () => setTimeout(open, 500));
  };
  open();
}

export function clearNowPlaying(id: string) {
  state.delete(id);
  covers.delete(id);
  nowPlayingBus.emit('update', id, undefined);
}
