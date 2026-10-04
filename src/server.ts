import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { applyEdits, backfillMeta, captureSnapshot, carryOver, isActive, type Snapshot, type ZoneEdit } from './snapshot.ts';
import { airplayAvailable, airplayEvent, airplayStatus, pcmSource, reconcileAirplay, setAirplayLogger, stopAllAirplay } from './airplay.ts';
import { registerStreams } from './stream.ts';
import { startMonitor } from './monitor.ts';
import { startLsdp } from './lsdp.ts';
import { getJob, runningJob, startRecall } from './recall.ts';
import { events, snapshots } from './store.ts';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

app.register(fastifyStatic, { root: join(import.meta.dirname, '..', 'public') });
registerStreams(app, pcmSource);
setAirplayLogger((msg) => app.log.info(msg));

const busy = () => {
  const job = runningJob();
  if (job) throw Object.assign(new Error(`Recall of "${job.snapshotName}" is running`), { statusCode: 409 });
};
const findSnapshot = (id: string) => {
  const s = snapshots.get(Number(id));
  if (!s) throw Object.assign(new Error('Snapshot not found'), { statusCode: 404 });
  return s;
};
const cleanName = (name: unknown) => {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw Object.assign(new Error('Name is required'), { statusCode: 400 });
  return n.slice(0, 100);
};

function afterRead(current: Snapshot) {
  reconcileAirplay(current);
  for (const s of snapshots.list()) {
    const filled = backfillMeta(s.data, current);
    if (filled) snapshots.update(s.id, { data: filled }, false);
  }
}

app.get('/api/current', async () => {
  busy();
  const current = await captureSnapshot();
  afterRead(current);
  return { ...current, activeSnapshotIds: snapshots.list().filter((s) => isActive(s.data, current)).map((s) => s.id) };
});

app.get<{ Querystring: { limit?: string; kind?: string } }>('/api/events', async (req) =>
  events.list(Math.min(Number(req.query.limit ?? 200) || 200, 1000), req.query.kind || undefined));

app.get('/api/airplay', async () => ({ available: airplayAvailable(), receivers: airplayStatus() }));

// Session hooks from shairport-sync (docker/airplay-hook.sh), local only.
app.get<{ Params: { id: string; event: string }; Querystring: { v?: string } }>('/internal/airplay/:id/:event', async (req, reply) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)) return reply.code(403).send();
  airplayEvent(req.params.id, req.params.event, req.query.v).catch((e) => app.log.warn(`AirPlay ${req.params.event}: ${e.message}`));
  return { ok: true };
});

app.get('/api/snapshots', async () => snapshots.list());

app.post<{ Body: { name?: string } }>('/api/snapshots', async (req, reply) => {
  busy();
  const name = cleanName(req.body?.name);
  reply.code(201);
  return snapshots.create(name, await captureSnapshot());
});

app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/snapshots/:id', async (req) => {
  findSnapshot(req.params.id);
  return snapshots.update(Number(req.params.id), { name: cleanName(req.body?.name) });
});

// Edit stored values (settings, levels, volume, distances) of a snapshot.
app.put<{ Params: { id: string }; Body: { zones?: ZoneEdit[] } }>('/api/snapshots/:id/values', async (req) => {
  const s = findSnapshot(req.params.id);
  if (!Array.isArray(req.body?.zones)) throw Object.assign(new Error('zones is required'), { statusCode: 400 });
  const updated = snapshots.update(s.id, { data: applyEdits(s.data, req.body.zones) });
  reconcileAirplay();
  return updated;
});

// Replace the stored layout with the current one.
app.post<{ Params: { id: string } }>('/api/snapshots/:id/capture', async (req) => {
  busy();
  const s = findSnapshot(req.params.id);
  return snapshots.update(s.id, { data: carryOver(s.data, await captureSnapshot()) });
});

app.delete<{ Params: { id: string } }>('/api/snapshots/:id', async (req, reply) => {
  findSnapshot(req.params.id);
  snapshots.remove(Number(req.params.id));
  reconcileAirplay();
  reply.code(204);
});

app.post<{ Params: { id: string } }>('/api/snapshots/:id/recall', async (req, reply) => {
  const s = findSnapshot(req.params.id);
  busy();
  reply.code(202);
  return startRecall(s.id, s.name, s.data);
});

app.get('/api/jobs/running', async () => runningJob() ?? null);

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
  const job = getJob(req.params.id);
  if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
  return job;
});

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 8095) });

if (!airplayAvailable()) app.log.warn('shairport-sync not found, AirPlay receivers disabled');
startLsdp((msg) => app.log.warn(msg));
startMonitor((msg) => app.log.warn(msg));
captureSnapshot().then(afterRead).catch((e) => app.log.warn(`Initial read failed: ${e.message}`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopAllAirplay(); process.exit(0); });
