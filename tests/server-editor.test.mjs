import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { createEngine } from '../runner/engine.mjs';
import { fingerprint } from '../runner/ssh.mjs';
import { serverCredentials } from '../runner/server-editor.mjs';

test('server editing validates SSH before committing and preserves linked projects', async (t) => {
  const privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  let password = 'initial-ssh-password',
    attempts = 0;
  const clients = new Set();
  const ssh = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      attempts++;
      if (ctx.method === 'password' && ctx.password === password) ctx.accept();
      else ctx.reject();
    });
  });
  await new Promise((resolve) => ssh.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-server-edit-'));
  const key = randomBytes(32);
  const store = openStore(dir, key);
  const id = randomUUID();
  const initial = {
    id,
    name: 'old-name',
    region: 'old-region',
    host: '127.0.0.1',
    port: ssh.address().port,
    username: 'root',
    status: 'offline',
    secret: { password },
  };
  initial.fingerprint = await fingerprint(initial);
  store.save('servers', initial);
  let afterInspect = () => {};
  const engine = createEngine(store, {
    metrics: async () => {
      afterInspect();
      return { status: 'online', cpu: 5, memory: 10, disk: 15 };
    },
  });
  const { server, terminals } = createApp({
    store,
    token: 'owner-token',
    engine,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (body, token = 'owner-token') =>
    fetch(base + '/servers/' + id, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  t.after(async () => {
    terminals.close();
    for (const client of clients) client.end();
    await Promise.all([
      new Promise((r) => server.close(r)),
      new Promise((r) => ssh.close(r)),
    ]);
    store.close();
    assert.ok(dir.startsWith(join(tmpdir(), 'mayplane-server-edit-')));
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal((await request({ name: 'denied' }, 'wrong')).status, 401);
  await t.test(
    'metadata and blank credentials retain access while offline',
    async () => {
      const count = attempts;
      assert.equal(
        (
          await request({
            name: 'new-name',
            region: 'new-region',
            password: '',
          })
        ).status,
        200,
      );
      const saved = store.get('servers', id);
      assert.equal(saved.name, 'new-name');
      assert.equal(saved.region, 'new-region');
      assert.equal(saved.status, 'offline');
      assert.deepEqual(saved.secret, initial.secret);
      assert.equal(attempts, count);
    },
  );
  await t.test(
    'invalid data and failed SSH leave the complete record untouched',
    async () => {
      const before = store.get('servers', id);
      for (const body of [
        { port: 0 },
        { port: 65536 },
        { host: 'example.invalid' },
        { username: 'someone;id' },
        { password: {} },
        { password: 'one', privateKey: 'two' },
        { fingerprint: 'bad' },
        { name: 'changed', password: 'wrong' },
      ]) {
        assert.equal((await request(body)).status, 400);
        assert.deepEqual(store.get('servers', id), before);
      }
    },
  );
  await t.test(
    'verified credential rotation persists encrypted values and keeps project identity',
    async () => {
      const project = {
        id: randomUUID(),
        name: 'project-one',
        serverId: id,
        secret: { env: 'SECRET=project-value' },
      };
      store.save('projects', project);
      password = 'rotated-ssh-password';
      const response = await request({ password });
      assert.equal(response.status, 200);
      assert.ok(!(await response.text()).includes(password));
      assert.equal(store.get('servers', id).secret.password, password);
      assert.equal(store.get('servers', id).status, 'online');
      assert.deepEqual(store.get('projects', project.id), project);
      assert.ok(!JSON.stringify(store.snapshot()).includes(password));
      assert.ok(!readFileSync(join(dir, 'mayplane.sqlite')).includes(password));
      const reopened = openStore(dir, key);
      assert.equal(reopened.get('servers', id).secret.password, password);
      reopened.close();
      const stable = store.get('servers', id);
      assert.equal(
        (await request({ fingerprint: 'SHA256:' + 'A'.repeat(43) })).status,
        409,
      );
      assert.deepEqual(store.get('servers', id), stable);
    },
  );
  await t.test(
    'duplicates, running transfers and concurrent changes are rejected',
    async () => {
      store.save('servers', { ...initial, id: randomUUID(), port: 2222 });
      const stable = store.get('servers', id);
      assert.equal((await request({ port: 2222 })).status, 409);
      const job = {
        id: randomUUID(),
        type: 'migration',
        target: id,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      store.save('jobs', job);
      assert.equal((await request({ name: 'blocked' })).status, 409);
      assert.deepEqual(store.get('servers', id), stable);
      store.save('jobs', { ...job, status: 'success' });
      password = 'another-password';
      afterInspect = () =>
        store.save('servers', {
          ...store.get('servers', id),
          region: 'concurrent-edit',
        });
      assert.equal((await request({ password })).status, 409);
      assert.equal(
        store.get('servers', id).secret.password,
        stable.secret.password,
      );
      assert.equal(store.get('servers', id).region, 'concurrent-edit');
    },
  );
});

test('switching SSH authentication removes obsolete credentials', () => {
  assert.deepEqual(
    serverCredentials({ privateKey: 'new-key' }, { password: 'old' }),
    { privateKey: 'new-key' },
  );
  assert.deepEqual(
    serverCredentials({ password: 'new' }, { privateKey: 'old-key' }),
    { password: 'new' },
  );
  assert.deepEqual(
    serverCredentials({ password: '', privateKey: '' }, { password: 'old' }),
    { password: 'old' },
  );
});
