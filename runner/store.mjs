import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { seal, unseal } from './security.mjs';
export function openStore(directory, key) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = join(directory, 'mayplane.sqlite');
  if (
    !existsSync(databasePath) &&
    readdirSync(directory).some((name) => /\.sqlite(?:3)?$/i.test(name))
  )
    throw new Error(
      'В каталоге данных найдена база с другим именем. Остановите панель, создайте резервную копию и переименуйте основную базу в mayplane.sqlite. Новая пустая база не создана.',
    );
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, data TEXT NOT NULL, secret TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL, secret TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS git_connections (id TEXT PRIMARY KEY, data TEXT NOT NULL, secret TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id), name TEXT NOT NULL, data TEXT NOT NULL, secret TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_projects_server ON projects(server_id);
 CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
 CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
 PRAGMA optimize;`);
  // Fail before any credential changes if an existing encrypted store has the wrong key.
  try {
    for (const table of [
      'servers',
      'settings',
      'git_connections',
      'projects',
    ]) {
      const row = db
        .prepare(`SELECT secret FROM ${table} WHERE secret != '' LIMIT 1`)
        .get();
      if (row) {
        JSON.parse(unseal(row.secret, key));
        break;
      }
    }
  } catch {
    db.close();
    throw new Error(
      'Ключ шифрования не подходит к существующей базе или её секреты повреждены. Восстановите прежний ключ и резервную копию; данные не перезаписаны.',
    );
  }
  // Names are display labels. Every deployment is addressed by its immutable ID.
  const hasUniqueName = () =>
    db
      .prepare('PRAGMA index_list(projects)')
      .all()
      .some((index) => {
        if (!index.unique) return false;
        const columns = db
          .prepare('SELECT name FROM pragma_index_info(?)')
          .all(index.name);
        return columns.length === 1 && columns[0].name === 'name';
      });
  if (hasUniqueName()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (hasUniqueName())
        db.exec(
          'CREATE TABLE projects_instances (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id), name TEXT NOT NULL, data TEXT NOT NULL, secret TEXT NOT NULL);' +
            'INSERT INTO projects_instances (id, server_id, name, data, secret) SELECT id, server_id, name, data, secret FROM projects;' +
            'DROP TABLE projects;' +
            'ALTER TABLE projects_instances RENAME TO projects;' +
            'CREATE INDEX idx_projects_server ON projects(server_id);',
        );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
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
      if (
        table === 'servers' ||
        table === 'git_connections' ||
        table === 'settings'
      )
        db.prepare(
          `INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,secret=excluded.secret`,
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
        gitConnections: list('git_connections'),
        projects: list('projects'),
        jobs: list('jobs'),
      };
    },
    close() {
      db.close();
    },
  };
}
