import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from './snapshot.ts';

export interface Device { mac: string; name: string; model: string; modelCode: string; lastIp: string; seenAt: string }
export interface SnapshotRow { id: number; name: string; createdAt: string; updatedAt: string; data: Snapshot }

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'bluesound-snapshot.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    t TEXT NOT NULL,
    mac TEXT NOT NULL,
    player TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_t ON events (t);
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    mac TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    last_ip TEXT NOT NULL,
    seen_at TEXT NOT NULL
  );
`);

// Added after the first release: model number (e.g. "P430") next to the model name.
if (!(db.prepare("SELECT name FROM pragma_table_info('devices')").all() as any[]).some((c) => c.name === 'model_code')) {
  db.exec("ALTER TABLE devices ADD COLUMN model_code TEXT NOT NULL DEFAULT ''");
}

const toRow = (r: any): SnapshotRow => ({
  id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, data: JSON.parse(r.data),
});

export const snapshots = {
  list(): SnapshotRow[] {
    return db.prepare('SELECT * FROM snapshots ORDER BY name COLLATE NOCASE').all().map(toRow);
  },
  get(id: number): SnapshotRow | undefined {
    const r = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
    return r ? toRow(r) : undefined;
  },
  create(name: string, data: Snapshot): SnapshotRow {
    const now = new Date().toISOString();
    const r = db.prepare('INSERT INTO snapshots (name, created_at, updated_at, data) VALUES (?, ?, ?, ?)')
      .run(name, now, now, JSON.stringify(data));
    return this.get(Number(r.lastInsertRowid))!;
  },
  // touch = false for housekeeping writes that should not show up as an edit.
  update(id: number, fields: { name?: string; data?: Snapshot }, touch = true): SnapshotRow | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    db.prepare('UPDATE snapshots SET name = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(fields.name ?? cur.name, JSON.stringify(fields.data ?? cur.data), touch ? new Date().toISOString() : cur.updatedAt, id);
    return this.get(id);
  },
  remove(id: number): boolean {
    return db.prepare('DELETE FROM snapshots WHERE id = ?').run(id).changes > 0;
  },
};

export const devices = {
  list(): Device[] {
    return db.prepare('SELECT * FROM devices').all().map((r: any) => ({
      mac: r.mac, name: r.name, model: r.model, modelCode: r.model_code, lastIp: r.last_ip, seenAt: r.seen_at,
    }));
  },
  upsert(d: Omit<Device, 'seenAt' | 'modelCode'> & { modelCode?: string }) {
    db.prepare(`INSERT INTO devices (mac, name, model, model_code, last_ip, seen_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(mac) DO UPDATE SET name = excluded.name, model = excluded.model,
        model_code = CASE WHEN excluded.model_code <> '' THEN excluded.model_code ELSE devices.model_code END,
        last_ip = excluded.last_ip, seen_at = excluded.seen_at`)
      .run(d.mac, d.name, d.model, d.modelCode ?? '', d.lastIp, new Date().toISOString());
  },
};

export interface PlayerEvent { id: number; t: string; mac: string; player: string; kind: string; detail: string }

const EVENT_RETENTION_DAYS = 30;
let insertsSincePrune = 0;

export const events = {
  add(e: Omit<PlayerEvent, 'id' | 't'>) {
    db.prepare('INSERT INTO events (t, mac, player, kind, detail) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), e.mac, e.player, e.kind, e.detail);
    if (++insertsSincePrune >= 500) {
      insertsSincePrune = 0;
      db.prepare('DELETE FROM events WHERE t < ?').run(new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString());
    }
  },
  list(limit: number, kind?: string): PlayerEvent[] {
    const rows = kind
      ? db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit)
      : db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return rows as unknown as PlayerEvent[];
  },
};

/** Small persisted values (JSON). */
export const kv = {
  get<T>(key: string): T | undefined {
    const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : undefined;
  },
  set(key: string, value: unknown) {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  },
};
