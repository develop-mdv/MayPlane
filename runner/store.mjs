import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seal, unseal } from './security.mjs';
export function openStore(directory, key) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'ezdeploy.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, data TEXT NOT NULL, secret TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id), name TEXT NOT NULL UNIQUE, data TEXT NOT NULL, secret TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_projects_server ON projects(server_id);
 CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
 CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
 PRAGMA optimize;`);
  const get = (table, id) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    return row
      ? {
          ...JSON.parse(row.data),
          ...(row.secret
            ? { secret: JSON.parse(unseal(row.secret, key)) }
            : {}),
        }
      : null;
  };
  const list = (table) =>
    db
      .prepare(
        `SELECT data FROM ${table} ${table === 'jobs' ? 'ORDER BY created_at DESC LIMIT 100' : ''}`,
      )
      .all()
      .map((row) => JSON.parse(row.data));
  return {
    db,
    get,
    list,
    save(table, obj, secret) {
      const data = { ...obj };
      delete data.secret;
      const json = JSON.stringify(data);
      if (table === 'servers')
        db.prepare(
          'INSERT INTO servers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,secret=excluded.secret',
        ).run(obj.id, json, seal(JSON.stringify(secret || obj.secret), key));
      else if (table === 'projects')
        db.prepare(
          'INSERT INTO projects VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET server_id=excluded.server_id,name=excluded.name,data=excluded.data,secret=excluded.secret',
        ).run(
          obj.id,
          obj.serverId,
          obj.name,
          json,
          seal(JSON.stringify(secret || obj.secret), key),
        );
      else
        db.prepare(
          'INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        ).run(obj.id, obj.createdAt, json);
    },
    snapshot() {
      return {
        servers: list('servers'),
        projects: list('projects'),
        jobs: list('jobs'),
      };
    },
    close() {
      db.close();
    },
  };
}
