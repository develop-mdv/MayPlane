import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import { createEngine } from '../runner/engine.mjs';
import { createApp } from '../runner/server.mjs';
import { migrationOptions } from '../runner/migration.mjs';

function fixture(t, scenario = 'success') {
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-migration-v2-'));
  const store = openStore(dir, randomBytes(32));
  const sid = randomUUID(),
    tid = randomUUID(),
    pid = randomUUID();
  const p = {
    id: pid,
    name: 'sample',
    repo: 'https://github.com/owner/repo.git',
    branch: 'main',
    kind: 'service',
    serverId: sid,
    status: 'running',
    autoDeploy: true,
    composeFile: 'compose.yaml',
    envKeys: ['TOKEN'],
    secret: { env: 'TOKEN=private-value' },
  };
  for (const id of [sid, tid])
    store.save(
      'servers',
      {
        id,
        host: id === sid ? '192.0.2.1' : '192.0.2.2',
        port: 22,
        username: 'root',
        fingerprint: 'test-' + id,
        name: id,
        status: 'online',
      },
      { password: 'ssh-private' },
    );
  store.save('projects', p);
  const events = [],
    copies = [];
  const inv = {
    runtime: 'docker',
    host: { arch: 'x86_64', os: 'ubuntu', version: '24.04' },
    fingerprint: 'initial',
    bytes: 10000,
    imageBytes: 5000,
    containers: [
      {
        Id: 'a'.repeat(64),
        Name: '/app',
        Config: { Image: 'app:latest', Env: ['DB_PASSWORD=runtime-private'] },
        HostConfig: { RestartPolicy: { Name: 'always' } },
        Mounts: [],
      },
    ],
    volumes: { data: { Name: 'data' } },
    networks: {},
    datasets: [
      {
        key: 'path-0',
        source: '/opt/mayplane/' + pid,
        target: '/opt/mayplane/' + pid,
        kind: 'directory',
        bytes: 5000,
      },
    ],
    warnings: [],
  };
  let phase = '',
    failed = false;
  const overrides = {
    connect: async (s) => ({ id: s.id, end() {} }),
    run: async () => '',
    copyFile: async (a, b, path) => {
      copies.push(path);
      if (scenario === 'checksum' && !failed) {
        failed = true;
        throw Error('Checksum mismatch');
      }
    },
    migrationRemote: async (c, action, data) => {
      events.push({ server: c.id, action, data });
      if (action === 'inventory') return structuredClone(inv);
      if (action === 'preflight')
        return {
          blockers: scenario === 'blocked' ? ['Port conflict'] : [],
          warnings: [],
        };
      if (action === 'source-space' || action === 'reserve') return {};
      if (action === 'stop') {
        phase = 'stopped';
        if (scenario === 'stop-failed' && !failed) {
          failed = true;
          throw Error('SSH lost during stop');
        }
        return { stopped: true };
      }
      if (action === 'snapshot') {
        assert.equal(phase, 'stopped');
        return {
          files: ['path-0.tar', 'images.tar', 'manifest.json'].map(
            (f) => '/opt/mayplane-migrations/' + data.job + '/' + f,
          ),
          entries: 8,
        };
      }
      if (action === 'restore') {
        assert.equal(copies.length, 3);
        if (scenario === 'restore' && !failed) {
          failed = true;
          throw Error('Restored file differs');
        }
        return { ready: true };
      }
      if (action === 'start') {
        assert.equal(
          store.get('projects', pid).migration.targetMayHaveWritten,
          true,
        );
        phase = 'target-started';
        if (scenario === 'start' && !failed) {
          failed = true;
          throw Error('SSH lost after target start');
        }
        return {};
      }
      if (action === 'health') {
        if (scenario === 'health' && !failed) {
          failed = true;
          throw Error('Target unhealthy');
        }
        return { resources: ['b'.repeat(64)], healthy: true };
      }
      if (action === 'resume-source') {
        assert.notEqual(
          phase,
          'target-started',
          'Never revert to stale source after target may have written',
        );
        phase = 'source-resumed';
        return { running: true };
      }
      return {};
    },
  };
  let engine = createEngine(store, overrides);
  t.after(async () => {
    await engine.drain();
    store.close();
    assert.ok(
      resolve(dir).startsWith(resolve(tmpdir()) + sep + 'mayplane-migration-v2-'),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const plan = async (options = {}) => {
    const j = engine.enqueue('migration-plan', {
      projectId: pid,
      target: tid,
      migrationOptions: options,
    });
    await engine.drain();
    return store.get('jobs', j.id);
  };
  const migrate = () =>
    engine.enqueue('migration', {
      projectId: pid,
      target: tid,
      planId: store.get('projects', pid).migrationPlan?.id,
    });
  return {
    store,
    pid,
    sid,
    tid,
    inv,
    events,
    copies,
    overrides,
    plan,
    migrate,
    get engine() {
      return engine;
    },
    restart() {
      engine = createEngine(store, overrides);
    },
  };
}

test('preflight is read-only on servers and runtime/environment/check secrets stay encrypted', async (t) => {
  const f = fixture(t);
  const job = await f.plan({ check: 'test "check-secret" = "check-secret"' });
  assert.equal(job.status, 'success');
  assert.ok(
    f.events.every((e) =>
      ['inventory', 'preflight', 'source-space'].includes(e.action),
    ),
  );
  assert.equal(f.store.get('projects', f.pid).status, 'running');
  assert.equal(f.copies.length, 0);
  const publicData = JSON.stringify(f.store.snapshot());
  for (const secret of ['runtime-private', 'private-value', 'check-secret'])
    assert.ok(!publicData.includes(secret));
  const row = JSON.stringify(
    f.store.db.prepare('SELECT * FROM projects').all(),
  );
  assert.ok(!row.includes('runtime-private'));
  assert.ok(
    f.store
      .get('projects', f.pid)
      .secret.migrationPlan.inventory.containers[0].Config.Env[0].includes(
        'runtime-private',
      ),
  );
});

test('successful migration copies pinned runtime data before start, verifies it and binds new resources without LLM/build', async (t) => {
  const f = fixture(t);
  await f.plan();
  const job = f.migrate();
  assert.throws(
    () => f.engine.enqueue('chat', { serverId: f.tid, intent: 'other' }),
    /уже выполняется/,
  );
  await f.engine.drain();
  const p = f.store.get('projects', f.pid);
  assert.equal(p.serverId, f.tid);
  assert.equal(p.status, 'running');
  assert.equal(p.migration.phase, 'complete');
  assert.equal(p.migration.locked, false);
  assert.deepEqual(p.adoption.resources, ['b'.repeat(64)]);
  assert.equal(p.adoption.migrationId, job.id);
  for (const field of [
    'images',
    'ports',
    'mounts',
    'configFiles',
    'warnings',
    'sourceFiles',
    'environmentConflicts',
  ])
    assert.ok(
      Array.isArray(p.adoption[field]),
      field + ' required by project overview',
    );
  assert.ok(p.secret.adopted.envByService[0].env.includes('runtime-private'));
  assert.ok(!JSON.stringify(f.store.snapshot()).includes('runtime-private'));
  assert.equal(p.secret.env, 'TOKEN=private-value');
  assert.equal(p.autoDeploy, false);
  assert.equal(f.store.get('jobs', job.id).status, 'success');
  assert.equal(f.copies.length, 3);
  assert.ok(!f.events.some((e) => e.action === 'resume-source'));
  assert.ok(
    f.events.findIndex((e) => e.action === 'restore') <
      f.events.findIndex((e) => e.action === 'start'),
  );
  assert.equal(f.events.filter((e) => e.action === 'verify-source').length, 2);
});

for (const scenario of ['checksum', 'restore', 'stop-failed'])
  test(`failure before target start restores source without lost writes: ${scenario}`, async (t) => {
    const f = fixture(t, scenario);
    await f.plan();
    const job = f.migrate();
    await f.engine.drain();
    const p = f.store.get('projects', f.pid);
    assert.equal(f.store.get('jobs', job.id).status, 'failed');
    assert.equal(p.serverId, f.sid);
    assert.equal(p.status, 'running');
    assert.equal(p.autoDeploy, true);
    assert.equal(p.migration.phase, 'rolled_back');
    assert.equal(p.migration.locked, false);
    assert.ok(f.events.some((e) => e.action === 'resume-source'));
    assert.ok(!f.events.some((e) => e.action === 'start'));
  });

for (const scenario of ['start', 'health'])
  test(`failure after possible target writes never reverts old data and can resume target: ${scenario}`, async (t) => {
    const f = fixture(t, scenario);
    await f.plan();
    const job = f.migrate();
    await f.engine.drain();
    let p = f.store.get('projects', f.pid);
    assert.equal(f.store.get('jobs', job.id).status, 'failed');
    assert.equal(p.migration.locked, true);
    assert.equal(p.migration.needsRecovery, true);
    assert.equal(p.migration.targetMayHaveWritten, true);
    assert.ok(!f.events.some((e) => e.action === 'resume-source'));
    assert.throws(
      () => f.engine.enqueue('deploy', { projectId: f.pid }),
      /восстановление переноса/,
    );
    assert.throws(
      () => f.engine.enqueue('provision', { serverId: f.tid }),
      /восстановление переноса/,
    );
    const recovery = f.engine.enqueue('migration-recover', {
      projectId: f.pid,
    });
    await f.engine.drain();
    p = f.store.get('projects', f.pid);
    assert.equal(p.serverId, f.tid);
    assert.equal(p.status, 'running');
    assert.equal(p.migration.locked, false);
    assert.equal(f.store.get('jobs', recovery.id).status, 'success');
    assert.equal(
      f.copies.length,
      3,
      'Recovery must never overwrite new data with old snapshot',
    );
  });

test('blocking checks and source drift reject before any stop or copy', async (t) => {
  const f = fixture(t, 'blocked');
  await f.plan();
  assert.deepEqual(f.store.get('projects', f.pid).migrationPlan.blockers, [
    'Port conflict',
  ]);
  const j = f.migrate();
  await f.engine.drain();
  assert.equal(f.store.get('jobs', j.id).status, 'failed');
  assert.ok(!f.events.some((e) => e.action === 'stop'));
  assert.equal(f.copies.length, 0);
});

test('changed runtime and expired plans reject before stopping source', async (t) => {
  const f = fixture(t);
  await f.plan();
  f.inv.fingerprint = 'changed';
  const j = f.migrate();
  await f.engine.drain();
  assert.equal(f.store.get('jobs', j.id).status, 'failed');
  assert.ok(!f.events.some((e) => e.action === 'stop'));
  f.inv.fingerprint = 'initial';
  await f.plan();
  const p = f.store.get('projects', f.pid);
  p.secret.migrationPlan.expiresAt = '2000-01-01T00:00:00Z';
  f.store.save('projects', p);
  const expired = f.migrate();
  await f.engine.drain();
  assert.equal(f.store.get('jobs', expired.id).status, 'failed');
  assert.equal(f.copies.length, 0);
});

test('executor restart preserves durable migration lock and exposes recovery, even when original job ages out of history', async (t) => {
  const f = fixture(t, 'start');
  await f.plan();
  const j = f.migrate();
  await f.engine.drain();
  const job = f.store.get('jobs', j.id);
  job.status = 'deploying';
  f.store.save('jobs', job);
  const p = f.store.get('projects', f.pid);
  p.migration.needsRecovery = false;
  f.store.save('projects', p);
  f.restart();
  assert.equal(f.store.get('projects', f.pid).migration.needsRecovery, true);
  for (let i = 0; i < 110; i++)
    f.store.save('jobs', {
      id: randomUUID(),
      type: 'check',
      status: 'success',
      logs: [],
      createdAt: '2099-' + String(i).padStart(3, '0'),
    });
  const hidden = f.store.get('projects', f.pid);
  hidden.migration.needsRecovery = false;
  f.store.save('projects', hidden);
  f.restart();
  assert.equal(f.store.get('projects', f.pid).migration.needsRecovery, true);
  assert.throws(
    () => f.engine.enqueue('provision', { serverId: f.tid }),
    /восстановление переноса/,
  );
});

test('changing target identity invalidates recovery and does not start either copy', async (t) => {
  const f = fixture(t, 'start');
  await f.plan();
  f.migrate();
  await f.engine.drain();
  const target = f.store.get('servers', f.tid);
  target.host = '192.0.2.99';
  f.store.save('servers', target);
  const before = f.events.length,
    j = f.engine.enqueue('migration-recover', { projectId: f.pid });
  await f.engine.drain();
  assert.equal(f.store.get('jobs', j.id).status, 'failed');
  assert.equal(f.events.length, before);
  assert.equal(f.store.get('projects', f.pid).migration.locked, true);
});

test('owner API requires plan and manifest/downtime confirmation and exposes recovery routes', async (t) => {
  const f = fixture(t);
  const app = createApp({ legacyApi: true, store: f.store, engine: f.engine, token: 'owner' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
  const request = (path, body, authorized = true) =>
    fetch(
      `http://127.0.0.1:${app.server.address().port}/api/projects/${f.pid}/${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorized ? { Authorization: 'Bearer owner' } : {}),
        },
        body: JSON.stringify(body),
      },
    );
  assert.equal(
    (await request('migration-plan', { target: f.tid }, false)).status,
    401,
  );
  assert.equal(
    (await request('migrate', { target: f.tid, confirmDowntime: true })).status,
    400,
  );
  assert.equal(
    (await request('migration-plan', { target: f.tid, options: { paths: [] } }))
      .status,
    202,
  );
  await f.engine.drain();
  const plan = f.store.get('projects', f.pid).migrationPlan;
  const response = await request('migrate', {
    target: f.tid,
    planId: plan.id,
    confirmDowntime: true,
    confirmManifest: true,
  });
  assert.equal(response.status, 202);
  await f.engine.drain();
  assert.equal(f.store.get('projects', f.pid).serverId, f.tid);
});

test('migration settings reject malformed paths, oversized commands and unknown service syntax', () => {
  assert.throws(() => migrationOptions({ paths: ['/opt/../etc'] }));
  assert.throws(() => migrationOptions({ paths: 'all' }));
  assert.throws(() => migrationOptions({ units: ['a; echo invalid.service'] }));
  assert.throws(() => migrationOptions({ check: 'a\0b' }));
  assert.deepEqual(
    migrationOptions({
      paths: ['/opt/app', '/opt/app'],
      units: ['app.service'],
    }),
    {
      paths: ['/opt/app'],
      units: ['app.service'],
      check: '',
      mode: 'standard',
      intent: '',
      directory: '',
      resources: [],
      stopSignal: '',
      conflictPolicy: 'ask',
    },
  );
});

function assistedFixture(t, scenario = 'success') {
  const f = fixture(t);
  f.store.save(
    'settings',
    {
      id: 'llm',
      enabled: true,
      model: 'fixture/model',
      baseUrl: 'https://fixture.invalid',
    },
    { apiKey: 'provider-private' },
  );
  let installed = false,
    failed = false,
    calls = 0;
  const executeRemote = f.overrides.migrationRemote;
  const prompt = [];
  f.overrides.migrationInspectRepository = async () => ({
    paths: ['README.md'],
    files: {
      'README.md':
        'Requires extra data under /srv/extra. password=repository-secret',
    },
  });
  f.overrides.migrationChat = async (settings, messages) => {
    calls++;
    prompt.push(JSON.stringify(messages));
    return {
      data: {
        summary: 'Перенести дополнительные данные и установить зависимость',
        paths: ['/srv/extra'],
        units: [],
        prepare: [
          {
            description: 'Установить зависимость',
            command: 'fixture-install-dependency',
          },
        ],
        configure: [
          {
            description: 'Настроить новый сервер',
            command:
              scenario === 'secret-command'
                ? 'echo runtime-private'
                : 'fixture-configure-target',
          },
        ],
        check: 'fixture-health',
        notes: [],
        questions:
          scenario === 'questions' ? ['Укажите внешний адрес сервиса'] : [],
      },
      usage: { input: 100, output: 50 },
    };
  };
  f.overrides.migrationRemote = async (client, action, data) => {
    if (
      action === 'inventory' &&
      scenario === 'discovery' &&
      !data.paths.includes('/srv/extra')
    )
      throw Error('Не определены каталоги данных');
    if (action === 'assist-context')
      return {
        Env: ['SHOULD_NOT_LEAVE=runtime-private'],
        password: 'ssh-private',
        paths: [{ path: '/srv/extra' }],
      };
    if (action === 'preflight') {
      f.events.push({ server: client.id, action, data });
      return {
        blockers:
          scenario === 'hard-conflict'
            ? ['Порт занят: 8080/tcp']
            : installed
              ? []
              : ['Не установлена зависимость: /usr/bin/fixture-runtime'],
        warnings: [],
      };
    }
    return executeRemote(client, action, data);
  };
  f.overrides.run = async (client, command) => {
    f.events.push({ server: client.id, action: 'exec', command });
    assert.equal(client.id, f.tid, 'LLM must only execute on destination');
    if (command.includes('fixture-install-dependency')) {
      assert.equal(
        f.store.get('projects', f.pid).migration.sourceMayHaveStopped,
        false,
      );
      if (scenario === 'prepare-failed') throw Error('Install failed');
      installed = true;
    }
    if (command.includes('fixture-configure-target')) {
      assert.equal(
        f.store.get('projects', f.pid).migration.targetMayHaveWritten,
        true,
      );
      if (scenario === 'configure-failed' && !failed) {
        failed = true;
        throw Error('Config failed after possible target write');
      }
    }
    return '';
  };
  f.restart();
  return {
    ...f,
    get engine() {
      return f.engine;
    },
    prompt,
    get calls() {
      return calls;
    },
  };
}

test('LLM mode discovers extra data, shows commands, prepares target then enforces normal copy and verification', async (t) => {
  const f = assistedFixture(t, 'discovery');
  const plan = await f.plan({ mode: 'llm', intent: 'Move with extra data' });
  assert.equal(plan.status, 'success', plan.logs.join('\n'));
  assert.equal(f.calls, 1);
  assert.ok(
    !f.events.some((e) => ['exec', 'stop', 'start'].includes(e.action)),
  );
  const preview = f.store.get('projects', f.pid).migrationPlan;
  assert.equal(preview.mode, 'llm');
  assert.ok(preview.preparationIssues.length);
  assert.equal(
    preview.assistant.prepare[0].command,
    'fixture-install-dependency',
  );
  for (const value of [
    'provider-private',
    'runtime-private',
    'ssh-private',
    'private-value',
    'repository-secret',
  ])
    assert.ok(!f.prompt[0].includes(value), value + ' leaked to provider');
  const j = f.migrate();
  await f.engine.drain();
  assert.equal(
    f.store.get('jobs', j.id).status,
    'success',
    f.store.get('jobs', j.id).logs.join('\n'),
  );
  assert.equal(
    f.calls,
    1,
    'Migration reuses the reviewed commands without more model calls',
  );
  assert.ok(
    f.events.findIndex((e) => e.action === 'exec') <
      f.events.findIndex((e) => e.action === 'stop'),
  );
  assert.equal(f.copies.length, 3);
  assert.equal(f.store.get('projects', f.pid).serverId, f.tid);
});

for (const scenario of ['hard-conflict', 'questions', 'secret-command'])
  test(
    'LLM cannot bypass blockers or expose secret commands: ' + scenario,
    async (t) => {
      const f = assistedFixture(t, scenario);
      const plan = await f.plan({ mode: 'llm' });
      assert.equal(plan.status, 'failed');
      assert.ok(f.store.get('projects', f.pid).migrationPlan.blockers.length);
      const j = f.migrate();
      await f.engine.drain();
      assert.equal(f.store.get('jobs', j.id).status, 'failed');
      assert.ok(
        !f.events.some((e) => ['exec', 'stop', 'start'].includes(e.action)),
      );
    },
  );

test('LLM target preparation failure leaves source untouched and releases migration lock', async (t) => {
  const f = assistedFixture(t, 'prepare-failed');
  await f.plan({ mode: 'llm' });
  const j = f.migrate();
  await f.engine.drain();
  assert.equal(f.store.get('jobs', j.id).status, 'failed');
  assert.equal(f.store.get('projects', f.pid).status, 'running');
  assert.equal(f.store.get('projects', f.pid).migration.locked, false);
  assert.ok(
    !f.events.some((e) =>
      ['stop', 'start', 'resume-source'].includes(e.action),
    ),
  );
  assert.equal(f.copies.length, 0);
});

test('LLM configuration failure protects possible new writes and recovery reuses commands without recopy', async (t) => {
  const f = assistedFixture(t, 'configure-failed');
  await f.plan({ mode: 'llm' });
  f.migrate();
  await f.engine.drain();
  assert.equal(f.store.get('projects', f.pid).migration.locked, true);
  assert.ok(!f.events.some((e) => e.action === 'resume-source'));
  const j = f.engine.enqueue('migration-recover', { projectId: f.pid });
  await f.engine.drain();
  assert.equal(f.store.get('jobs', j.id).status, 'success');
  assert.equal(f.copies.length, 3);
  assert.equal(f.calls, 1);
});

test('ordinary migration never requests LLM and disabled provider rejects LLM mode before job creation', async (t) => {
  const f = fixture(t);
  let called = false;
  f.overrides.migrationChat = async () => {
    called = true;
    throw Error('Unexpected model');
  };
  f.restart();
  await f.plan();
  assert.equal(called, false);
  const before = f.store.list('jobs').length;
  assert.throws(
    () =>
      f.engine.enqueue('migration-plan', {
        projectId: f.pid,
        target: f.tid,
        migrationOptions: { mode: 'llm' },
      }),
    /Подключите LLM/,
  );
  assert.equal(f.store.list('jobs').length, before);
});

test('failed ordinary migration can be repaired with a new reviewed LLM plan without copying old data', async (t) => {
  const f = fixture(t, 'health');
  await f.plan();
  f.migrate();
  await f.engine.drain();
  f.store.save(
    'settings',
    {
      id: 'llm',
      enabled: true,
      model: 'fixture/model',
      baseUrl: 'https://fixture.invalid',
    },
    { apiKey: 'provider-private' },
  );
  let repairs = 0;
  f.overrides.migrationInspectRepository = async () => ({
    paths: [],
    files: {},
  });
  f.overrides.migrationChat = async (settings, messages) => {
    assert.match(messages[0].content, /ВОССТАНОВЛЕНИЕ/);
    return {
      data: {
        summary: 'Исправить текущую копию',
        paths: [],
        units: [],
        resources: [],
        prepare: [],
        configure: [
          {
            description: 'Исправить конфигурацию',
            command: 'fixture-repair-current-target',
          },
        ],
        check: '',
        questions: [],
        notes: [],
      },
    };
  };
  f.overrides.run = async (client, command) => {
    assert.equal(client.id, f.tid);
    assert.match(command, /fixture-repair-current-target/);
    repairs++;
    return '';
  };
  f.restart();
  const app = createApp({ legacyApi: true, store: f.store, engine: f.engine, token: 'owner' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
  const request = (operation, body) =>
    fetch(
      `http://127.0.0.1:${app.server.address().port}/api/projects/${f.pid}/${operation}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
  assert.equal(
    (
      await request('migration-repair-plan', {
        options: { intent: 'Fix current target only' },
      })
    ).status,
    202,
  );
  await f.engine.drain();
  const plan = f.store.get('projects', f.pid).migrationRepairPlan;
  assert.ok(plan?.id);
  assert.equal(repairs, 0);
  assert.equal(f.copies.length, 3);
  assert.equal(
    (await request('migration-recover', { repairPlanId: plan.id })).status,
    400,
  );
  assert.equal(
    (
      await request('migration-recover', {
        repairPlanId: plan.id,
        confirmLlmCommands: true,
      })
    ).status,
    202,
  );
  await f.engine.drain();
  assert.equal(repairs, 1);
  assert.equal(f.copies.length, 3);
  assert.equal(f.store.get('projects', f.pid).serverId, f.tid);
  assert.ok(!f.events.some((e) => e.action === 'resume-source'));
});

test('LLM migration API requires acknowledgement of the reviewed model commands', async (t) => {
  const f = assistedFixture(t);
  await f.plan({ mode: 'llm' });
  const app = createApp({ legacyApi: true, store: f.store, engine: f.engine, token: 'owner' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
  const body = {
    target: f.tid,
    planId: f.store.get('projects', f.pid).migrationPlan.id,
    confirmManifest: true,
    confirmDowntime: true,
  };
  const request = (body) =>
    fetch(
      `http://127.0.0.1:${app.server.address().port}/api/projects/${f.pid}/migrate`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
  assert.equal((await request(body)).status, 400);
  assert.ok(!f.events.some((e) => e.action === 'exec'));
  assert.equal(
    (await request({ ...body, confirmLlmCommands: true })).status,
    202,
  );
  await f.engine.drain();
  assert.equal(f.store.get('projects', f.pid).serverId, f.tid);
});

test('LLM resolves Docker runtime for a directory-only binding and preserves the original project directory', async (t) => {
  const f = fixture(t);
  const p = f.store.get('projects', f.pid);
  p.adoption = {
    id: randomUUID(),
    runtime: 'directory',
    directory: '/opt/existing-app',
    name: 'existing-app',
    resources: [],
  };
  f.store.save('projects', p);
  f.store.save(
    'settings',
    {
      id: 'llm',
      enabled: true,
      model: 'fixture/model',
      baseUrl: 'https://fixture.invalid',
    },
    { apiKey: 'provider-private' },
  );
  f.overrides.migrationInspectRepository = async () => ({
    files: {},
    paths: [],
  });
  f.overrides.migrationChat = async () => ({
    data: {
      summary: 'Перенести найденный контейнер',
      resources: ['a'.repeat(64)],
      paths: [],
      units: [],
      directory: '/opt/another-directory',
      prepare: [],
      configure: [],
      check: '',
      questions: [],
      notes: [],
    },
  });
  const remote = f.overrides.migrationRemote;
  f.overrides.migrationRemote = async (client, action, data) => {
    if (action === 'inventory') {
      assert.equal(data.directory, '/opt/existing-app');
      if (!data.resources.length) throw Error('Способ запуска не найден');
      assert.equal(data.runtime, 'docker');
      assert.deepEqual(data.resources, ['a'.repeat(64)]);
    }
    return remote(client, action, data);
  };
  f.restart();
  const j = await f.plan({ mode: 'llm' });
  assert.equal(j.status, 'success', j.logs.join('\n'));
  assert.equal(f.store.get('projects', f.pid).migrationPlan.runtime, 'docker');
  assert.equal(f.copies.length, 0);
});

test('project descriptions do not create false DNS migration requirements', async (t) => {
  const f = fixture(t);
  const p = f.store.get('projects', f.pid);
  p.kind = 'bot';
  p.domain = 'Telegram · Wife AI';
  f.store.save('projects', p);
  await f.plan();
  assert.ok(
    !f.store
      .get('projects', f.pid)
      .migrationPlan.warnings.some((w) => w.includes('DNS')),
  );
  const job = f.migrate();
  await f.engine.drain();
  assert.equal(f.store.get('jobs', job.id).status, 'success');
  assert.equal(f.store.get('projects', f.pid).migration.phase, 'complete');
  assert.deepEqual(f.store.get('projects', f.pid).deploymentChecks.steps, []);
});

test('saved LLM plans survive checks, expiry and provider disable without further model calls', async (t) => {
  const f = assistedFixture(t);
  await f.plan({ mode: 'llm' });
  const saved = f.store.get('projects', f.pid).savedMigrationPlan;
  assert.ok(saved?.assistant);
  await f.plan({ mode: 'standard' });
  const settings = f.store.get('settings', 'llm');
  settings.enabled = false;
  f.store.save('settings', settings);
  const project = f.store.get('projects', f.pid);
  project.secret.savedMigrationPlan.expiresAt = '2000-01-01';
  f.store.save('projects', project);
  f.restart();
  const job = f.engine.enqueue('migration-plan', {
    projectId: f.pid,
    target: f.tid,
    savedPlanId: saved.id,
  });
  await f.engine.drain();
  const result = f.store.get('jobs', job.id);
  assert.equal(result.status, 'success', result.logs.join('\n'));
  assert.equal(f.calls, 1);
  const next = f.store.get('projects', f.pid);
  assert.equal(next.savedMigrationPlan.id, saved.id);
  assert.equal(next.savedMigrationPlan.createdAt, saved.createdAt);
  assert.notEqual(next.migrationPlan.id, saved.id);
  assert.ok(Date.parse(next.migrationPlan.expiresAt) > Date.now());
  assert.ok(!JSON.stringify(f.store.snapshot()).includes('runtime-private'));
});

test('failed new generation retains prior saved plan; runtime drift blocks saved replay before writes', async (t) => {
  const f = assistedFixture(t);
  await f.plan({ mode: 'llm' });
  const saved = f.store.get('projects', f.pid).savedMigrationPlan;
  f.overrides.migrationChat = async () => {
    throw Error('Provider unavailable');
  };
  f.restart();
  assert.equal((await f.plan({ mode: 'llm' })).status, 'failed');
  assert.equal(f.store.get('projects', f.pid).savedMigrationPlan.id, saved.id);
  f.inv.fingerprint = 'changed';
  const job = f.engine.enqueue('migration-plan', {
    projectId: f.pid,
    target: f.tid,
    savedPlanId: saved.id,
  });
  await f.engine.drain();
  assert.equal(f.store.get('jobs', job.id).status, 'failed');
  assert.ok(
    f.store
      .get('jobs', job.id)
      .logs.join(' ')
      .includes('Состав приложения изменился'),
  );
  assert.ok(
    !f.events.some((e) =>
      ['stop', 'exec', 'archive-conflicts'].includes(e.action),
    ),
  );
});

for (const command of [
  'rm -rf /opt/app',
  'cd /opt/app && docker compose down --volumes',
  'docker ps -q | xargs -r docker stop',
]) {
  test(
    'destructive model plan cannot be generated or replayed: ' + command,
    async (t) => {
      const f = assistedFixture(t);
      await f.plan({ mode: 'llm' });
      const p = f.store.get('projects', f.pid);
      p.secret.savedMigrationPlan.assistant.configure = [
        { description: 'Delete', command },
      ];
      f.store.save('projects', p);
      const job = f.engine.enqueue('migration-plan', {
        projectId: f.pid,
        target: f.tid,
        savedPlanId: p.savedMigrationPlan.id,
      });
      await f.engine.drain();
      assert.equal(f.store.get('jobs', job.id).status, 'failed');
      assert.ok(
        f.store.get('jobs', job.id).logs.join(' ').includes('удаление'),
      );
      f.overrides.migrationChat = async () => ({
        data: {
          summary: 'Перенести проект',
          configure: [{ command }],
          check: 'true',
        },
        usage: {},
      });
      f.restart();
      assert.equal((await f.plan({ mode: 'llm' })).status, 'failed');
      assert.equal(
        f.store.get('projects', f.pid).migrationPlan.assistant,
        null,
      );
      assert.ok(
        !f.events.some((e) =>
          ['stop', 'exec', 'archive-conflicts'].includes(e.action),
        ),
      );
    },
  );
}

function conflictFixture(t, scenario = 'success') {
  const f = assistedFixture(t);
  const base = f.overrides.migrationRemote;
  let archived = false;
  let fingerprint = 'old-copy';
  const resolution = () => ({
    fingerprint,
    inventory: {
      ...structuredClone(f.inv),
      containers: [{ ...f.inv.containers[0], Id: 'c'.repeat(64) }],
    },
    resources: ['app'],
    paths: ['/opt/old-copy'],
    bytes: 1000,
  });
  f.overrides.migrationRemote = async (client, action, data) => {
    if (action === 'preflight')
      return {
        blockers: archived
          ? []
          : ['Контейнер с таким именем уже существует: app'],
        warnings: [],
      };
    if (action === 'conflict-plan') {
      if (scenario === 'running')
        throw Error('Конфликтующий контейнер работает');
      return resolution();
    }
    if (action === 'archive-conflicts') {
      f.events.push({ action, server: client.id });
      assert.equal(client.id, f.tid);
      assert.ok(!f.events.some((e) => e.action === 'stop'));
      if (scenario === 'archive-fails')
        throw Error('Archive verification failed');
      archived = true;
      return { archived: true };
    }
    return base(client, action, data);
  };
  f.restart();
  return {
    ...f,
    get engine() {
      return f.engine;
    },
    drift() {
      fingerprint = 'changed';
    },
  };
}

test('collision resolution is read-only until approval, archives target before stopping source and reuses LLM plan', async (t) => {
  const f = conflictFixture(t);
  assert.equal((await f.plan({ mode: 'llm' })).status, 'failed');
  const saved = f.store.get('projects', f.pid).savedMigrationPlan;
  assert.equal(saved.conflictResolution.available, true);
  assert.equal(saved.conflictResolution.selected, false);
  assert.ok(!f.events.some((e) => e.action === 'archive-conflicts'));
  const job = f.engine.enqueue('migration-plan', {
    projectId: f.pid,
    target: f.tid,
    savedPlanId: saved.id,
    migrationOptions: { conflictPolicy: 'archive-stopped' },
  });
  await f.engine.drain();
  assert.equal(
    f.store.get('jobs', job.id).status,
    'success',
    f.store.get('jobs', job.id).logs.join('\n'),
  );
  const migration = f.migrate();
  await f.engine.drain();
  assert.equal(
    f.store.get('jobs', migration.id).status,
    'success',
    f.store.get('jobs', migration.id).logs.join('\n'),
  );
  assert.equal(f.store.get('projects', f.pid).migrationArchives.length, 1);
  assert.ok(
    f.events.findIndex((e) => e.action === 'archive-conflicts') <
      f.events.findIndex((e) => e.action === 'stop'),
  );
});

for (const scenario of ['running', 'drift', 'archive-fails'])
  test('conflict failure leaves source running: ' + scenario, async (t) => {
    const f = conflictFixture(t, scenario);
    const result = await f.plan({
      mode: 'llm',
      conflictPolicy: 'archive-stopped',
    });
    if (scenario === 'running') assert.equal(result.status, 'failed');
    else assert.equal(result.status, 'success', result.logs.join('\n'));
    if (scenario === 'drift') f.drift();
    const job = f.migrate();
    await f.engine.drain();
    assert.equal(f.store.get('jobs', job.id).status, 'failed');
    assert.ok(
      !f.events.some((e) =>
        ['stop', 'start', 'resume-source'].includes(e.action),
      ),
    );
    assert.equal(f.store.get('projects', f.pid).serverId, f.sid);
    assert.equal(f.store.get('projects', f.pid).status, 'running');
  });

test('archive API requires explicit confirmation of the reviewed target resources', async (t) => {
  const f = conflictFixture(t);
  await f.plan({ mode: 'llm', conflictPolicy: 'archive-stopped' });
  const token = 'owner-token-'.repeat(4);
  const app = createApp({ legacyApi: true, store: f.store, engine: f.engine, token });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url =
    'http://127.0.0.1:' +
    app.server.address().port +
    '/api/projects/' +
    f.pid +
    '/migrate';
  const payload = {
    target: f.tid,
    planId: f.store.get('projects', f.pid).migrationPlan.id,
    confirmDowntime: true,
    confirmManifest: true,
    confirmLlmCommands: true,
  };
  const denied = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /архивирование/);
  assert.ok(!f.events.some((e) => e.action === 'archive-conflicts'));
});

test('choosing archive answers the old prose question without another LLM call', async (t) => {
  const f = conflictFixture(t);
  const original = f.overrides.migrationChat;
  let calls = 0;
  const question =
    'На целевом сервере уже существуют остановленный контейнер с именем app, сеть app_default и каталог /opt/app. Разрешить архивирование этих существующих ресурсов перед переносом? Варианты: 1) Да, архивировать; 2) Использовать другой сервер; 3) Предварительно остановить/удалить вручную владельцем.';
  f.overrides.migrationChat = async (...args) => {
    calls++;
    const response = await original(...args);
    response.data.questions = [question];
    return response;
  };
  f.restart();
  const initial = await f.plan({ mode: 'llm' });
  assert.equal(initial.outcome, 'needs_input');
  const p = f.store.get('projects', f.pid);
  const j = f.engine.enqueue('migration-plan', {
    projectId: f.pid,
    target: f.tid,
    savedPlanId: p.migrationPlan.id,
    migrationOptions: { conflictPolicy: 'archive-stopped' },
  });
  await f.engine.drain();
  assert.equal(
    f.store.get('jobs', j.id).status,
    'success',
    f.store.get('jobs', j.id).logs.join('\n'),
  );
  assert.equal(calls, 1);
  assert.deepEqual(f.store.get('projects', f.pid).migrationPlan.blockers, []);
  assert.ok(!f.events.some((e) => e.action === 'archive-conflicts'));
});

test('automatic preparation stops and archives only the reviewed target before source downtime', async (t) => {
  const f = conflictFixture(t);
  const base = f.overrides.migrationRemote;
  let archived = false;
  f.overrides.migrationRemote = async (client, action, data) => {
    if (action === 'conflict-plan')
      return {
        ...(await base(client, action, data)),
        requiresStop: true,
        releasesPorts: ['8080/tcp'],
      };
    if (action === 'preflight') {
      const report = await base(client, action, data);
      if (!archived) report.blockers.push('Порт занят: 8080/tcp');
      return report;
    }
    if (action === 'stop-archive-conflicts') {
      assert.equal(client.id, f.tid);
      assert.equal(data.resolution.requiresStop, true);
      assert.ok(!f.events.some((e) => e.action === 'stop'));
      archived = true;
      return base(client, 'archive-conflicts', data);
    }
    return base(client, action, data);
  };
  f.restart();
  assert.equal(
    (await f.plan({ mode: 'llm', conflictPolicy: 'archive-stopped' })).status,
    'failed',
  );
  assert.equal(
    (await f.plan({ mode: 'llm', conflictPolicy: 'stop-archive' })).status,
    'success',
  );
  assert.equal(archived, false);
  const j = f.migrate();
  await f.engine.drain();
  assert.equal(
    f.store.get('jobs', j.id).status,
    'success',
    f.store.get('jobs', j.id).logs.join('\n'),
  );
  assert.equal(archived, true);
});

test('migration draft survives executor restart even before a plan finishes', async (t) => {
  const f = assistedFixture(t);
  f.overrides.migrationChat = async () => {
    throw Error('Provider offline');
  };
  f.restart();
  const j = await f.plan({ mode: 'llm' });
  const p = f.store.get('projects', f.pid);
  assert.equal(p.migrationDraft.jobId, j.id);
  assert.equal(p.migrationDraft.targetId, f.tid);
  f.restart();
  assert.deepEqual(
    f.store.get('projects', f.pid).migrationDraft,
    p.migrationDraft,
  );
});

test('manual choice is persisted against the current plan and stale choices are rejected', async (t) => {
  const f = conflictFixture(t);
  await f.plan({ mode: 'llm' });
  const app = createApp({ legacyApi: true, store: f.store, engine: f.engine, token: 'owner' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
  const url =
    'http://127.0.0.1:' +
    app.server.address().port +
    '/api/projects/' +
    f.pid +
    '/migration-choice';
  const request = (planId) =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ choice: 'manual', planId }),
    });
  assert.equal((await request('old-plan')).status, 409);
  const plan = f.store.get('projects', f.pid).migrationPlan;
  assert.equal((await request(plan.id)).status, 200);
  f.restart();
  assert.equal(f.store.get('projects', f.pid).migrationDraft.choice, 'manual');
  assert.equal(f.store.get('projects', f.pid).migrationDraft.jobId, plan.jobId);
  assert.ok(
    !f.events.some((e) => ['stop', 'archive-conflicts'].includes(e.action)),
  );
});

test('automatic stop requires separate API acknowledgement for target downtime', async (t) => {
  const f = conflictFixture(t);
  await f.plan({ mode: 'llm', conflictPolicy: 'stop-archive' });
  const project = f.store.get('projects', f.pid);
  project.secret.migrationPlan.conflictResolution.requiresStop = true;
  f.store.save('projects', project);
  const app = createApp({ legacyApi: true, store: f.store, engine: f.engine, token: 'owner' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
  const response = await fetch(
    'http://127.0.0.1:' +
      app.server.address().port +
      '/api/projects/' +
      f.pid +
      '/migrate',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target: f.tid,
        planId: project.migrationPlan.id,
        confirmDowntime: true,
        confirmManifest: true,
        confirmLlmCommands: true,
        confirmConflictArchive: true,
      }),
    },
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /остановку/);
  assert.ok(
    !f.events.some((e) => ['stop', 'archive-conflicts'].includes(e.action)),
  );
});
