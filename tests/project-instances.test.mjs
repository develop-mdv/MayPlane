import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import { seal, projectInput } from '../runner/security.mjs';
import { projectNamePattern, isProjectName } from '../lib/project-name.mjs';
import { createApp } from '../runner/server.mjs';
import { compose, rootOf } from '../runner/ssh.mjs';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-instances-'));
  const key = randomBytes(32);
  const cleanup = () => {
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + '\\mayplane-instances-') ||
        resolve(dir).startsWith(resolve(tmpdir()) + '/mayplane-instances-'),
    );
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, key, cleanup };
}
test('legacy name uniqueness migrates atomically, preserving IDs, encrypted values, jobs and foreign keys across reopening', (t) => {
  const { dir, key, cleanup } = fixture(),
    sid = randomUUID(),
    pid = randomUUID();
  const server = { id: sid, name: 'production' },
    project = {
      id: pid,
      serverId: sid,
      name: 'quantom_vpn',
      repo: 'https://github.com/owner/repo',
      status: 'running',
      adoption: { resources: ['original-resource'] },
      workflow: { id: 'workflow' },
    };
  const secret = seal(
    JSON.stringify({
      env: 'API_TOKEN=preserved-token',
      workflow: { deploy: 'original deploy' },
    }),
    key,
  );
  t.after(cleanup);
  const old = new DatabaseSync(join(dir, 'mayplane.sqlite'));
  old.exec(
    'CREATE TABLE servers (id TEXT PRIMARY KEY,data TEXT NOT NULL,secret TEXT NOT NULL);CREATE TABLE projects (id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id),name TEXT NOT NULL UNIQUE,data TEXT NOT NULL,secret TEXT NOT NULL);CREATE TABLE jobs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,data TEXT NOT NULL);',
  );
  old
    .prepare('INSERT INTO servers VALUES(?,?,?)')
    .run(sid, JSON.stringify(server), seal('{}', key));
  old
    .prepare('INSERT INTO projects VALUES(?,?,?,?,?)')
    .run(pid, sid, project.name, JSON.stringify(project), secret);
  old
    .prepare('INSERT INTO jobs VALUES(?,?,?)')
    .run(
      'job',
      '2026-01-01',
      JSON.stringify({ id: 'job', projectId: pid, status: 'success' }),
    );
  old.close();
  let store = openStore(dir, key);
  try {
    const saved = store.get('projects', pid);
    assert.deepEqual(
      { ...saved, secret: undefined },
      { ...project, secret: undefined },
    );
    assert.equal(saved.secret.env, 'API_TOKEN=preserved-token');
    assert.equal(
      store.db.prepare('SELECT secret FROM projects WHERE id=?').get(pid)
        .secret,
      secret,
    );
    assert.equal(store.get('jobs', 'job').projectId, pid);
    const copy = { ...saved, id: randomUUID() };
    store.save('projects', copy);
    assert.equal(store.list('projects').length, 2);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(
      () =>
        store.save('projects', {
          ...copy,
          id: randomUUID(),
          serverId: 'missing',
        }),
      /FOREIGN KEY/,
    );
    assert.ok(
      store.db
        .prepare('PRAGMA index_list(projects)')
        .all()
        .some((i) => i.name === 'idx_projects_server'),
    );
  } finally {
    store.close();
  }
  store = openStore(dir, key);
  try {
    assert.equal(store.list('projects').length, 2);
    assert.equal(
      store.get('projects', pid).secret.env,
      'API_TOKEN=preserved-token',
    );
  } finally {
    store.close();
  }
});
test('one repository and name can have independent instances on same and different servers, including webhook delivery', async (t) => {
  const { dir, key, cleanup } = fixture(),
    store = openStore(dir, key);
  const servers = [randomUUID(), randomUUID()];
  for (const id of servers)
    store.save(
      'servers',
      { id, name: 'server-' + id, host: '127.0.0.1', status: 'online' },
      { password: 'hidden' },
    );
  const jobs = [];
  const app = createApp({ legacyApi: true,
    store,
    token: 'owner',
    publicUrl: 'https://runner.example.com',
    engine: {
      enqueue: (type, options) => {
        jobs.push({ type, ...options });
        return { id: randomUUID() };
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = (path, method = 'GET', body) =>
    fetch(base + path, {
      method,
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const instances = [];
  for (const [index, serverId] of [
    servers[0],
    servers[1],
    servers[0],
  ].entries()) {
    const response = await request('/projects', 'POST', {
      name: 'quantom_vpn',
      repo: 'https://github.com/owner/repo',
      branch: 'main',
      kind: 'service',
      serverId,
      env: 'API_TOKEN=token-' + index,
      autoDeploy: true,
    });
    assert.equal(response.status, 201);
    instances.push(await response.json());
  }
  assert.equal(new Set(instances.map((p) => p.id)).size, 3);
  assert.equal(new Set(instances.map(rootOf)).size, 3);
  assert.equal(new Set(instances.map(compose)).size, 3);
  for (let i = 0; i < 3; i++)
    assert.equal(
      store.get('projects', instances[i].id).secret.env,
      'API_TOKEN=token-' + i,
    );
  assert.equal(
    (
      await request('/projects/' + instances[1].id, 'PATCH', {
        name: 'quantom_vpn',
        env: 'API_TOKEN=changed-second',
      })
    ).status,
    200,
  );
  assert.equal(
    store.get('projects', instances[0].id).secret.env,
    'API_TOKEN=token-0',
  );
  assert.equal(
    store.get('projects', instances[2].id).secret.env,
    'API_TOKEN=token-2',
  );
  const payload = JSON.stringify({
    ref: 'refs/heads/main',
    repository: { clone_url: 'https://github.com/owner/repo.git' },
  });
  const webhook = async (p) =>
    fetch(base + '/webhooks/github/' + p.id, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'one-shared-delivery',
        'X-Hub-Signature-256':
          'sha256=' +
          createHmac('sha256', store.get('projects', p.id).secret.webhookSecret)
            .update(payload)
            .digest('hex'),
      },
      body: payload,
    });
  for (const p of instances) assert.equal((await webhook(p)).status, 202);
  assert.deepEqual(
    new Set(jobs.map((j) => j.projectId)),
    new Set(instances.map((p) => p.id)),
  );
  for (const p of instances)
    assert.equal((await (await webhook(p)).json()).duplicate, true);
  assert.equal(jobs.length, 3);
  const state = await (await request('/state')).text();
  assert.ok(!state.includes('changed-second'));
  assert.ok(!state.includes('token-0'));
});
test('project names support underscores, capitals and Unicode with matching HTML and API rules', () => {
  const form = new RegExp('^(?:' + projectNamePattern + ')$', 'v');
  for (const name of [
    'quantom_vpn',
    'Quantom VPN',
    'VPN.Production',
    'Тестовый бот_2',
    '1',
  ]) {
    assert.equal(form.test(name), true);
    assert.equal(isProjectName(name), true);
    assert.equal(
      projectInput({
        name,
        repo: 'https://github.com/owner/repo',
        branch: 'main',
        kind: 'service',
      }).name,
      name,
    );
  }
  assert.equal(
    projectInput({
      name: ' quantom_vpn ',
      repo: 'https://github.com/owner/repo',
      branch: 'main',
      kind: 'service',
    }).name,
    'quantom_vpn',
  );
  for (const name of [
    '',
    ' ',
    '../path',
    'bad/name',
    'name;id',
    'a'.repeat(81),
    'line\nname',
  ]) {
    assert.equal(isProjectName(name), false);
    assert.equal(form.test(name), false);
  }
});
