import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-panel-delete-'));
  const store = openStore(dir, randomBytes(32));
  const sid = randomUUID(),
    pid = randomUUID();
  store.save(
    'servers',
    { id: sid, name: 'source', host: '192.0.2.1' },
    { password: 'ssh-password' },
  );
  store.save(
    'projects',
    {
      id: pid,
      serverId: sid,
      name: 'app',
      status: 'running',
      autoDeploy: true,
      envKeys: ['TOKEN'],
    },
    {
      env: 'TOKEN=secret',
      chat: [{ text: 'Private chat' }],
      workflow: { deploy: 'existing' },
    },
  );
  let calls = 0;
  const app = createApp({ legacyApi: true,
    store,
    token: 'owner',
    origins: ['http://panel.test'],
    engine: {
      enqueue() {
        calls++;
        throw Error('Must not call runner');
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.terminals.close();
    await new Promise((r) => app.server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (body = {}, auth = true, method = 'DELETE') =>
    fetch(`http://127.0.0.1:${app.server.address().port}/api/projects/${pid}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://panel.test',
        ...(auth ? { Authorization: 'Bearer owner' } : {}),
      },
      ...(method === 'OPTIONS' ? {} : { body: JSON.stringify(body) }),
    });
  return {
    store,
    pid,
    sid,
    request,
    get calls() {
      return calls;
    },
  };
}

test('panel-only deletion is authenticated, explicit and independent of SSH; history and server survive', async (t) => {
  const f = await fixture(t);
  const old = {
    id: randomUUID(),
    projectId: f.pid,
    projectName: 'app',
    type: 'deploy',
    status: 'success',
    createdAt: '2026-01-01',
    logs: ['Old log'],
  };
  f.store.save('jobs', old);
  assert.equal(
    (await f.request({ confirmPanelOnly: true }, false)).status,
    401,
  );
  assert.equal((await f.request()).status, 400);
  assert.ok(f.store.get('projects', f.pid));
  assert.match(
    (await f.request({}, true, 'OPTIONS')).headers.get(
      'access-control-allow-methods',
    ),
    /DELETE/,
  );
  const response = await f.request({ confirmPanelOnly: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).removedId, f.pid);
  assert.equal(f.store.get('projects', f.pid), null);
  assert.ok(f.store.get('servers', f.sid));
  assert.deepEqual(f.store.get('jobs', old.id), old);
  assert.equal(
    f.store.list('jobs').filter((j) => j.type === 'project-forget').length,
    1,
  );
  assert.equal(f.calls, 0);
  assert.equal((await f.request({ confirmPanelOnly: true })).status, 404);
});

test('panel deletion refuses active jobs beyond visible history and persistent migrations', async (t) => {
  const f = await fixture(t),
    jobId = randomUUID();
  f.store.save('jobs', {
    id: jobId,
    projectId: f.pid,
    serverId: f.sid,
    type: 'deploy',
    status: 'deploying',
    createdAt: '2000-01-01',
    logs: [],
  });
  for (let i = 0; i < 110; i++)
    f.store.save('jobs', {
      id: randomUUID(),
      type: 'check',
      status: 'success',
      createdAt: '2099-' + i,
      logs: [],
    });
  assert.equal((await f.request({ confirmPanelOnly: true })).status, 409);
  const job = f.store.get('jobs', jobId);
  job.status = 'success';
  f.store.save('jobs', job);
  const p = f.store.get('projects', f.pid);
  p.migration = { locked: true, sourceId: f.sid, targetId: 'target' };
  f.store.save('projects', p);
  assert.equal((await f.request({ confirmPanelOnly: true })).status, 409);
  assert.ok(f.store.get('projects', f.pid));
  assert.equal(f.calls, 0);
});
