import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { openStore } from '../runner/store.mjs';
import { createEngine } from '../runner/engine.mjs';
import { createApp } from '../runner/server.mjs';
import { saveWorkflow } from '../runner/workflows.mjs';
import { operationSignal, cancellationError } from '../runner/cancellation.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ez-cancellation-'));
  const store = openStore(dir, randomBytes(32));
  const server = {
    id: randomUUID(),
    name: 'test',
    host: '127.0.0.1',
    status: 'online',
    secret: { password: 'test-only' },
  };
  const project = {
    id: randomUUID(),
    name: 'test',
    serverId: server.id,
    kind: 'web',
    repo: 'https://github.com/owner/repo.git',
    branch: 'main',
    composeFile: 'compose.yaml',
    envKeys: [],
    requiredEnvKeys: [],
    status: 'running',
    secret: { env: '' },
  };
  store.save('servers', server);
  store.save('projects', project);
  return {
    store,
    project,
    server,
    close() {
      store.close();
      assert.ok(
        resolve(dir).startsWith(resolve(tmpdir()) + sep + 'ez-cancellation-'),
      );
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const deferred = () => Promise.withResolvers();
const timeout = { timeout: 8000 };

test(
  'queued deployment cancellation never connects or changes the running project and is idempotent',
  timeout,
  async () => {
    const f = fixture();
    let connections = 0;
    const engine = createEngine(f.store, {
      connect: async () => {
        connections++;
        throw new Error('must not connect');
      },
    });
    try {
      const job = engine.enqueue('deploy', { projectId: f.project.id });
      engine.cancel(job.id);
      assert.equal(f.store.get('jobs', job.id).outcome, 'cancelled');
      engine.cancel(job.id);
      await engine.drain();
      assert.equal(connections, 0);
      assert.equal(f.store.get('projects', f.project.id).status, 'running');
      assert.ok(f.store.get('jobs', job.id).finishedAt);
    } finally {
      await engine.drain();
      f.close();
    }
  },
);

for (const workflow of [false, true])
  test(
    `running ${workflow ? 'saved workflow' : 'Compose'} deployment stops current command, holds lock until exit and skips later steps`,
    timeout,
    async () => {
      const f = fixture(),
        started = deferred(),
        exited = deferred();
      if (workflow)
        saveWorkflow(f.store, f.project.id, {
          deploy: 'custom-deploy',
          stop: 'custom-stop',
          remove: 'custom-remove',
          check: 'custom-check',
          logs: 'custom-logs',
        });
      const scripts = [];
      let signal;
      const engine = createEngine(f.store, {
        connect: async () => ({ end() {} }),
        put: async () => {},
        run: async (_client, script) => {
          scripts.push(script);
          if (script.includes(workflow ? 'custom-deploy' : 'up -d --build')) {
            signal = operationSignal();
            started.resolve();
            await exited.promise;
            if (signal.aborted) throw cancellationError();
          }
          return 'a'.repeat(40);
        },
      });
      const job = engine.enqueue('deploy', { projectId: f.project.id });
      try {
        await started.promise;
        engine.cancel(job.id);
        assert.equal(signal.aborted, true);
        assert.equal(f.store.get('jobs', job.id).status, 'deploying');
        assert.throws(
          () => engine.enqueue('deploy', { projectId: f.project.id }),
          /уже выполняется/,
        );
        const commandsAtCancellation = scripts.length;
        exited.resolve();
        await engine.drain();
        assert.equal(scripts.length, commandsAtCancellation);
        assert.equal(f.store.get('jobs', job.id).outcome, 'cancelled');
        assert.equal(
          f.store.get('projects', f.project.id).status,
          'needs_setup',
        );
        assert.ok(
          !scripts.some((s) =>
            s.includes(workflow ? 'custom-check' : 'rev-parse --short'),
          ),
        );
        assert.match(
          f.store.get('jobs', job.id).logs.join('\n'),
          /не откатывались/,
        );
      } finally {
        exited.resolve();
        await engine.drain();
        f.close();
      }
    },
  );

for (const workflow of [false, true])
  test(
    `cancelled private ${workflow ? 'workflow' : 'Compose'} checkout cleans temporary credentials and never writes environment`,
    timeout,
    async () => {
      const f = fixture(),
        started = deferred();
      const gitId = randomUUID();
      f.store.save(
        'git_connections',
        { id: gitId, login: 'owner' },
        { token: 'test-private-token' },
      );
      f.project.gitConnectionId = gitId;
      f.store.save('projects', f.project);
      if (workflow)
        saveWorkflow(f.store, f.project.id, {
          deploy: 'custom-deploy',
          stop: 'true',
          remove: 'true',
          check: 'true',
          logs: 'true',
        });
      const writes = [],
        scripts = [];
      const engine = createEngine(f.store, {
        connect: async () => ({ end() {} }),
        put: async (_c, path) => writes.push(path),
        run: async (_c, script) => {
          scripts.push(script);
          if (script.includes('git reset --hard')) {
            const signal = operationSignal();
            started.resolve();
            await new Promise((_, reject) =>
              signal.addEventListener(
                'abort',
                () => reject(cancellationError()),
                { once: true },
              ),
            );
          }
          if (script.startsWith('rm -f -- '))
            assert.equal(operationSignal(), undefined);
          return '';
        },
      });
      const job = engine.enqueue('deploy', { projectId: f.project.id });
      try {
        await started.promise;
        engine.cancel(job.id);
        await engine.drain();
        assert.match(scripts.at(-1), /^rm -f -- '\/opt\/ezdeploy\/\.auth\//);
        assert.equal(writes.length, 1);
        assert.ok(writes[0].startsWith('/opt/ezdeploy/.auth/'));
        assert.equal(f.store.get('jobs', job.id).outcome, 'cancelled');
        assert.ok(
          !f.store
            .get('jobs', job.id)
            .logs.join('')
            .includes('test-private-token'),
        );
      } finally {
        if (f.store.get('jobs', job.id).status === 'deploying')
          engine.cancel(job.id);
        await engine.drain();
        f.close();
      }
    },
  );

test(
  'cancellation aborts a pending real HTTP model request and never runs model commands',
  timeout,
  async () => {
    const f = fixture(),
      requested = deferred(),
      disconnected = deferred();
    let requests = 0,
      commands = 0;
    const provider = createServer((req, res) => {
      requests++;
      req.resume();
      res.on('close', disconnected.resolve);
      requested.resolve();
    });
    await new Promise((r) => provider.listen(0, '127.0.0.1', r));
    f.store.save(
      'settings',
      {
        id: 'llm',
        enabled: true,
        model: 'local-test',
        baseUrl: `http://127.0.0.1:${provider.address().port}`,
      },
      { apiKey: '' },
    );
    const engine = createEngine(f.store, {
      connect: async () => ({ end() {} }),
      run: async () => {
        commands++;
        return '';
      },
    });
    const job = engine.enqueue('chat', {
      serverId: f.server.id,
      intent: 'Check server',
    });
    try {
      await requested.promise;
      engine.cancel(job.id);
      await engine.drain();
      await disconnected.promise;
      assert.equal(requests, 1);
      assert.equal(commands, 0);
      assert.equal(f.store.get('jobs', job.id).outcome, 'cancelled');
      assert.ok(
        !f.store
          .get('jobs', job.id)
          .logs.join('')
          .includes('Провайдер не ответил'),
      );
    } finally {
      provider.closeAllConnections();
      await new Promise((r) => provider.close(r));
      await engine.drain();
      f.close();
    }
  },
);

test(
  'create-only API resolves default branch, saves card and environment, and enqueues no work',
  timeout,
  async () => {
    const f = fixture();
    let enqueued = 0,
      lookups = 0;
    const app = createApp({ legacyApi: true,
      store: f.store,
      token: 'owner',
      engine: {
        enqueue() {
          enqueued++;
        },
      },
      github: {
        repo: async () => {
          lookups++;
          return { default_branch: 'develop' };
        },
      },
    });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    try {
      const response = await fetch(
        `http://127.0.0.1:${app.server.address().port}/api/projects`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer owner',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'new-project',
            repo: 'https://github.com/owner/repo',
            branch: '',
            serverId: f.server.id,
            kind: 'web',
            resolveDefaultBranch: true,
            env: 'API_TOKEN=local-test',
          }),
        },
      );
      assert.equal(response.status, 201);
      const p = await response.json();
      assert.equal(p.branch, 'develop');
      assert.equal(p.status, 'stopped');
      assert.equal(
        f.store.get('projects', p.id).secret.env,
        'API_TOKEN=local-test',
      );
      assert.equal(enqueued, 0);
      assert.equal(f.store.list('jobs').length, 0);
      assert.equal(lookups, 1);
    } finally {
      await new Promise((r) => app.server.close(r));
      f.close();
    }
  },
);

test(
  'cancel API requires owner authorization and refuses completed or unsupported operations',
  timeout,
  async () => {
    const f = fixture();
    const started = deferred();
    const engine = createEngine(f.store, {
      connect: async () => ({ end() {} }),
      run: async () => {
        const signal = operationSignal();
        started.resolve();
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(cancellationError()), {
            once: true,
          }),
        );
      },
    });
    const done = {
      id: randomUUID(),
      type: 'deploy',
      status: 'success',
      createdAt: new Date().toISOString(),
      logs: [],
    };
    f.store.save('jobs', done);
    const protectedJob = {
      ...done,
      id: randomUUID(),
      type: 'migration',
      status: 'pending',
      serverId: randomUUID(),
    };
    f.store.save('jobs', protectedJob);
    const app = createApp({ legacyApi: true, store: f.store, token: 'owner', engine });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const request = (id, authorized = true) =>
      fetch(
        `http://127.0.0.1:${app.server.address().port}/api/jobs/${id}/cancel`,
        {
          method: 'POST',
          headers: authorized ? { Authorization: 'Bearer owner' } : {},
        },
      );
    try {
      assert.equal((await request(done.id, false)).status, 401);
      assert.equal((await request(done.id)).status, 409);
      assert.equal((await request(protectedJob.id)).status, 409);
      const job = engine.enqueue('deploy', { projectId: f.project.id });
      await started.promise;
      assert.equal((await request(job.id, false)).status, 401);
      assert.ok(!f.store.get('jobs', job.id).cancelRequested);
      assert.equal((await request(job.id)).status, 200);
      await engine.drain();
      assert.equal(f.store.get('jobs', job.id).outcome, 'cancelled');
    } finally {
      await new Promise((r) => app.server.close(r));
      await engine.drain();
      f.close();
    }
  },
);
