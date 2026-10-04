// HTTP audio streams for BluOS players (/Play?url=...). BluOS rejects WAV URLs but plays an
// endless FLAC stream, so PCM is encoded with ffmpeg per connected player.

import { spawn, type ChildProcess } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';

export const PCM = { rate: 44100, channels: 2, format: 's16le' } as const;

/** Base URL of this server as reachable from the given speaker. */
export function selfUrl(speakerHost: string): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const port = process.env.PORT ?? '8095';
  const prefix = speakerHost.split('.').slice(0, 3).join('.') + '.';
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && a.address.startsWith(prefix)) return `http://${a.address}:${port}`;
    }
  }
  throw new Error(`No local address in the network of ${speakerHost}; set PUBLIC_URL`);
}

function flacEncoder(input: string[]): ChildProcess {
  return spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-c:a', 'flac', '-f', 'flac', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    // The shairport-sync base image puts its own reduced FFmpeg libraries in /usr/local/lib,
    // which break Alpine's ffmpeg binary; prefer the system libraries for ffmpeg only.
    env: { ...process.env, LD_LIBRARY_PATH: '/usr/lib' },
  });
}

type PcmSource = (id: string) => { subscribe(sink: NodeJS.WritableStream): () => void } | undefined;

export function registerStreams(app: FastifyInstance, pcmSource: PcmSource) {
  // Digital silence, used to check that a group actually plays.
  app.get('/stream/silence.flac', (req, reply) => {
    reply.hijack();
    const ff = flacEncoder(['-re', '-f', 'lavfi', '-i', `anullsrc=r=${PCM.rate}:cl=stereo`]);
    reply.raw.writeHead(200, { 'content-type': 'audio/flac', 'cache-control': 'no-cache' });
    ff.stdout!.pipe(reply.raw);
    req.raw.on('close', () => ff.kill());
  });

  // Live audio of an AirPlay bridge.
  app.get<{ Params: { id: string } }>('/stream/airplay/:id', (req, reply) => {
    const source = pcmSource(req.params.id.replace(/\.flac$/, ''));
    if (!source) return reply.code(404).send({ message: 'No such AirPlay bridge' });
    reply.hijack();
    const ff = flacEncoder(['-f', PCM.format, '-ar', String(PCM.rate), '-ac', String(PCM.channels), '-i', 'pipe:0']);
    ff.stdin!.on('error', () => {});
    const unsubscribe = source.subscribe(ff.stdin!);
    reply.raw.writeHead(200, { 'content-type': 'audio/flac', 'cache-control': 'no-cache' });
    ff.stdout!.pipe(reply.raw);
    req.raw.on('close', () => { unsubscribe(); ff.kill(); });
  });
}
