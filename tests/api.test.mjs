import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { createEngine } from '../runner/engine.mjs';

test('authenticated API persists encrypted data and verifies GitHub deliveries', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-test-'));
  const key = randomBytes(32);
  const store = openStore(dir, key);
  const token = 'test-only-' + randomBytes(32).toString('hex');
  const serverId = randomUUID();
  const jobs = [];
  store.save(
    'servers',
    {
      id: serverId,
      name: 'test',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      status: 'online',
    },
    { password: 'test-ssh-secret' },
  );
  const engine = {
    enqueue: (type, options) => {
      const j = { id: randomUUID(), type, ...options };
      jobs.push(j);
      return j;
    },
    refresh: async () => {},
  };
  const { server } = createApp({ legacyApi: true,
    store,
    token,
    origins: ['http://localhost:3000'],
    publicUrl: 'https://runner.example.com',
    engine,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path, method = 'GET', body, extra = {}) =>
    fetch(base + '/api' + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...extra,
      },
      ...(method !== 'GET' && body ? { body: JSON.stringify(body) } : {}),
    });
  await t.test(
    'anonymous access is denied and CORS is restricted',
    async () => {
      assert.equal((await fetch(base + '/api/state')).status, 401);
      assert.equal(
        (
          await request('/state', 'GET', null, {
            Origin: 'https://evil.example',
          })
        ).status,
        403,
      );
      const r = await request('/state', 'GET', null, {
        Origin: 'http://localhost:3000',
      });
      assert.equal(
        r.headers.get('Access-Control-Allow-Origin'),
        'http://localhost:3000',
      );
      assert.equal(r.headers.get('Cache-Control'), 'no-store');
      assert.ok(!(await r.text()).includes('test-ssh-secret'));
    },
  );
  let project;
  await t.test('create project and mask secrets in state', async () => {
    const r = await request('/projects', 'POST', {
      name: 'app-one',
      repo: 'https://github.com/example/app.git',
      branch: 'main',
      kind: 'web',
      serverId,
      composeFile: 'compose.yaml',
      autoDeploy: true,
      env: 'TOKEN=hidden-api-secret\nPORT=3000',
    });
    assert.equal(r.status, 201);
    project = await r.json();
    const state = await (await request('/state')).json();
    assert.deepEqual(state.projects[0].envKeys, ['TOKEN', 'PORT']);
    assert.ok(!JSON.stringify(state).includes('hidden-api-secret'));
    assert.ok(
      !readFileSync(join(dir, 'mayplane.sqlite')).includes('hidden-api-secret'),
    );
    assert.equal(
      store.get('projects', project.id).secret.env,
      'TOKEN=hidden-api-secret\nPORT=3000',
    );
  });
  await t.test(
    'invalid names, missing servers and malformed env fail without writes',
    async () => {
      for (const changes of [
        { name: '../invalid' },
        { serverId: 'missing' },
        { env: 'BAD LINE' },
      ]) {
        const r = await request('/projects', 'POST', {
          name: 'app-two',
          repo: 'https://github.com/example/app.git',
          branch: 'main',
          kind: 'web',
          serverId,
          ...changes,
        });
        assert.ok(r.status >= 400);
      }
      assert.equal(store.list('projects').length, 1);
    },
  );
  await t.test(
    'env replacement is atomic and values stay private',
    async () => {
      assert.equal(
        (
          await request(`/projects/${project.id}`, 'PATCH', {
            env: 'SECRET=replaced-value',
          })
        ).status,
        200,
      );
      assert.deepEqual(store.list('projects')[0].envKeys, ['SECRET']);
      assert.equal(
        store.get('projects', project.id).secret.env,
        'SECRET=replaced-value',
      );
      assert.equal(
        (await request(`/projects/${project.id}`, 'PATCH', { env: 'bad' }))
          .status,
        400,
      );
      assert.deepEqual(store.list('projects')[0].envKeys, ['SECRET']);
    },
  );
  await t.test(
    'project metadata editing preserves deployment identity and allows repeated names',
    async () => {
      const before = store.get('projects', project.id);
      before.updatedAt = '2020-01-01T00:00:00.000Z';
      before.assistant = { id: 'old-plan' };
      before.secret.assistantPlan = { id: 'old-plan', files: {} };
      before.secret.generatedFiles = { 'compose.yaml': 'working deployment' };
      before.secret.managedDeployment = true;
      before.requiredEnvKeys = ['SECRET'];
      store.save('projects', before);
      const update = (body) =>
        request('/projects/' + project.id, 'PATCH', body);
      assert.equal((await update({ name: 'renamed-app' })).status, 200);
      let saved = store.get('projects', project.id);
      assert.equal(saved.name, 'renamed-app');
      assert.equal(saved.kind, before.kind);
      assert.deepEqual(saved.secret, before.secret);
      assert.deepEqual(saved.assistant, before.assistant);
      assert.notEqual(saved.updatedAt, before.updatedAt);
      assert.equal(saved.id, before.id);
      assert.equal(saved.serverId, before.serverId);
      assert.equal(saved.repo, before.repo);
      assert.equal(saved.composeFile, before.composeFile);
      assert.equal(
        (await update({ name: 'renamed-app', kind: 'bot' })).status,
        200,
      );
      saved = store.get('projects', project.id);
      assert.equal(saved.kind, 'bot');
      assert.equal(saved.assistant, undefined);
      assert.equal(saved.secret.assistantPlan, undefined);
      assert.deepEqual(
        saved.secret.generatedFiles,
        before.secret.generatedFiles,
      );
      assert.equal(saved.secret.managedDeployment, true);
      assert.equal(saved.secret.env, before.secret.env);
      assert.equal(saved.secret.webhookSecret, before.secret.webhookSecret);
      assert.deepEqual(saved.requiredEnvKeys, ['SECRET']);
      const stable = structuredClone(saved);
      for (const body of [
        { name: '../invalid' },
        { name: null },
        { kind: 'invalid' },
        { kind: null },
        { name: 'valid-new-name', kind: 'web', env: 'BROKEN' },
      ]) {
        assert.equal((await update(body)).status, 400);
        assert.deepEqual(store.get('projects', project.id), stable);
      }
      const collision = { ...stable, id: randomUUID(), name: 'occupied-name' };
      store.save('projects', collision);
      assert.equal((await update({ name: collision.name })).status, 200);
      assert.equal(store.get('projects', project.id).name, collision.name);
      assert.deepEqual(store.get('projects', collision.id), collision);
      assert.deepEqual(store.get('projects', project.id).secret, stable.secret);
      store.save('projects', stable);
      const activeJob = {
        id: randomUUID(),
        projectId: project.id,
        type: 'deploy',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      store.save('jobs', activeJob);
      assert.equal((await update({ kind: 'service' })).status, 409);
      assert.deepEqual(store.get('projects', project.id), stable);
      store.save('jobs', { ...activeJob, status: 'success' });
      assert.equal((await update({ kind: 'service' })).status, 200);
      const state = await (await request('/state')).json();
      assert.equal(
        state.projects.find((p) => p.id === project.id).kind,
        'service',
      );
      assert.equal(
        state.projects.find((p) => p.id === project.id).name,
        'renamed-app',
      );
      assert.ok(!JSON.stringify(state).includes('replaced-value'));
      assert.equal(jobs.length, 0);
    },
  );
  let hook;
  await t.test(
    'webhook secret rotation invalidates previous secret',
    async () => {
      const before = store.get('projects', project.id).secret.webhookSecret;
      hook = await (
        await request(`/projects/${project.id}/webhook`, 'POST', {})
      ).json();
      assert.notEqual(hook.secret, before);
      assert.equal(
        hook.url,
        `https://runner.example.com/api/webhooks/github/${project.id}`,
      );
      assert.ok(!JSON.stringify(store.snapshot()).includes(hook.secret));
    },
  );
  await t.test(
    'push must be signed and match repo/branch; duplicate ignored',
    async () => {
      const payload = {
        ref: 'refs/heads/main',
        repository: { clone_url: 'https://github.com/example/app.git' },
      };
      const call = async (
        body,
        secret = hook.secret,
        delivery = 'delivery-1',
      ) =>
        fetch(hook.url.replace('https://runner.example.com', base), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'push',
            'X-GitHub-Delivery': delivery,
            'X-Hub-Signature-256':
              'sha256=' +
              createHmac('sha256', secret)
                .update(JSON.stringify(body))
                .digest('hex'),
          },
          body: JSON.stringify(body),
        });
      assert.equal((await call(payload, 'wrong')).status, 401);
      assert.equal(
        (await call({ ...payload, ref: 'refs/heads/other' })).status,
        200,
      );
      assert.equal(jobs.length, 0);
      assert.equal(
        (
          await call({
            ...payload,
            repository: { clone_url: 'https://github.com/other/repo' },
          })
        ).status,
        200,
      );
      assert.equal(jobs.length, 0);
      assert.equal((await call(payload)).status, 202);
      assert.equal(jobs.length, 1);
      assert.equal((await (await call(payload)).json()).duplicate, true);
      assert.equal(jobs.length, 1);
      await request(`/projects/${project.id}`, 'PATCH', { autoDeploy: false });
      assert.equal(
        (await (await call(payload, hook.secret, 'delivery-2')).json()).ignored,
        true,
      );
      assert.equal(jobs.length, 1);
    },
  );
  await t.test(
    'migration requires explicit downtime acknowledgement',
    async () => {
      assert.equal(
        (
          await request(`/projects/${project.id}/migrate`, 'POST', {
            target: 'target',
          })
        ).status,
        400,
      );
      assert.equal(jobs.length, 1);
    },
  );
  await t.test('data survives reopening with same encryption key', () => {
    const another = openStore(dir, key);
    assert.equal(
      another.get('projects', project.id).secret.env,
      'SECRET=replaced-value',
    );
    another.close();
  });
  await t.test(
    'interrupted operations become failed and are not replayed',
    () => {
      const p = store.get('projects', project.id);
      p.status = 'deploying';
      store.save('projects', p);
      const j = {
        id: randomUUID(),
        projectId: p.id,
        type: 'migration',
        status: 'deploying',
        createdAt: new Date().toISOString(),
        logs: [],
      };
      store.save('jobs', j);
      createEngine(store);
      assert.equal(store.get('jobs', j.id).status, 'failed');
      assert.equal(store.get('projects', p.id).status, 'failed');
    },
  );
});
