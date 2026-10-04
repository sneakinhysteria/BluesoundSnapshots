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
  // Very quiet noise (-70 dBFS), played at volume 0 to check that a group actually plays. Digital
  // silence is not enough: a stuck stereo pair "plays" silence but stays in "connecting" for music.
  app.get('/stream/check.flac', (req, reply) => {
    reply.hijack();
    const ff = flacEncoder(['-re', '-f', 'lavfi', '-i', `anoisesrc=a=0.0003:r=${PCM.rate},aformat=channel_layouts=stereo`]);
    reply.raw.writeHead(200, { 'content-type': 'audio/flac', 'cache-control': 'no-cache' });
    ff.stdout!.pipe(reply.raw);
    reply.raw.on('close', () => ff.kill()); // the response closes when the player disconnects
  });

  // Live audio of an AirPlay bridge.
  app.get<{ Params: { id: string } }>('/stream/airplay/:id', (req, reply) => {
    const source = pcmSource(req.params.id.replace(/\.flac$/, ''));
    if (!source) return reply.code(404).send({ message: 'No such AirPlay bridge' });
    reply.hijack();
    // The input format is known: skip ffmpeg's input probing (~5 s of audio), which delayed the first
    // byte so long that BluOS stayed in "connecting".
    const ff = flacEncoder(['-probesize', '32', '-analyzeduration', '0', '-fflags', 'nobuffer',
      '-f', PCM.format, '-ar', String(PCM.rate), '-ac', String(PCM.channels), '-i', 'pipe:0', '-flush_packets', '1']);
    ff.stdin!.on('error', () => {});
    const unsubscribe = source.subscribe(ff.stdin!);
    reply.raw.writeHead(200, { 'content-type': 'audio/flac', 'cache-control': 'no-cache' });
    ff.stdout!.pipe(reply.raw);
    reply.raw.on('close', () => { unsubscribe(); ff.kill(); });
  });
}
