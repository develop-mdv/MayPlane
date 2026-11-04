import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import {
  createAdoption,
  adoptionDirectory,
  adoptionCommands,
  normalizedRepo,
} from '../runner/adoption.mjs';
import { createEngine } from '../runner/engine.mjs';
import { createApp } from '../runner/server.mjs';
import { operatorSecrets } from '../runner/operator.mjs';
import { createWorkflowRunner, saveWorkflow } from '../runner/workflows.mjs';
import { parseEnvDocument } from '../lib/environment.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-adoption-'));
  const store = openStore(dir, randomBytes(32));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const server = {
    id: randomUUID(),
    name: 'VPS',
    host: '203.0.113.10',
    port: 22,
    username: 'root',
    fingerprint: 'pinned',
    secret: { password: 'ssh-hidden-value' },
  };
  const project = {
    id: randomUUID(),
    serverId: server.id,
    name: 'existing',
    repo: 'https://github.com/owner/app',
    branch: 'main',
    kind: 'service',
    status: 'stopped',
    autoDeploy: true,
    composeFile: 'compose.yaml',
    envKeys: ['OLD_TOKEN'],
    secret: { env: 'OLD_TOKEN=old-hidden-value' },
  };
  store.save('servers', server);
  store.save('projects', project);
  const container = (letter, service) => ({
    id: letter.repeat(64),
    name: '/app-' + service,
    image: 'example/app:v1',
    running: true,
    status: 'running',
    health: null,
    project: 'app',
    directory: '/srv/app',
    configFiles: '/srv/app/compose.yaml',
    service,
    oneoff: 'False',
    ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8088' }] },
    mounts: [
      {
        Type: 'volume',
        Name: 'app-data',
        Source: '/var/lib/docker/volumes/app-data/_data',
        Destination: '/data',
        RW: true,
      },
    ],
  });
  const f = {
    store,
    server,
    project,
    containers: [container('a', 'web'), container('b', 'worker')],
    units: '',
    commands: [],
    files: {
      '/srv/app/compose.yaml':
        'services:\n  web:\n    environment:\n      API_TOKEN: ${API_TOKEN:?required}\n',
    },
    fail: false,
  };
  f.run = async (_c, script, options = {}) => {
    f.commands.push(script);
    if (script.includes('# mayplane:discover-docker'))
      return f.containers.map((c) => JSON.stringify(c)).join('\n');
    if (script.includes('# mayplane:discover-systemd')) return f.units;
    if (script.includes('# mayplane:discover-directory'))
      return '/srv/unmanaged';
    if (script.includes('# mayplane:inspect-git'))
      return (
        '/srv/app\nhttps://userinfo:git-secret@github.com/owner/app.git\nmain\n' +
        'c'.repeat(40) +
        '\n'
      );
    if (script.includes('# mayplane:inspect-selected-containers'))
      return JSON.stringify(
        f.containers.map((c, i) => ({
          Id: c.id,
          Name: c.name,
          Config: {
            Env: [
              'SHARED=ok',
              'API_TOKEN=' + (i ? 'worker-secret-value' : 'web-secret-value'),
              'PATH=/untrusted/bin',
            ],
            Labels: { 'com.docker.compose.service': c.service },
          },
          HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
        })),
      );
    if (script.includes('# mayplane:inspect-selected-unit'))
      return '[Service]\nExecStart=/srv/service/app\n';
    if (script.includes('# mayplane:inspect-selected-environment'))
      return Buffer.from(
        'API_TOKEN=systemd-secret-value\0MODE=production\0',
      ).toString('base64');
    if (script.includes('# mayplane:read-adoption-file')) {
      const path = Object.keys(f.files).find((p) =>
        script.includes("'" + p + "'"),
      );
      return path
        ? 'FILE:' + Buffer.from(f.files[path]).toString('base64')
        : '';
    }
    if (f.fail) throw new Error('fixture command failed');
    options.log?.('service output worker-secret-value');
    return 'service output worker-secret-value';
  };
  f.adoption = createAdoption(store, { run: f.run });
  f.get = () => store.get('projects', project.id);
  f.scan = async (directory = '') => {
    await f.adoption.discover({}, f.get(), server, directory, () => {});
    return f.get().secret.discovery;
  };
  f.attach = async (scan, candidate = scan.candidates[0]) =>
    f.adoption.attach(
      {},
      f.get(),
      server,
      { scanId: scan.id, candidateId: candidate.id },
      () => {},
    );
  return f;
}
test('discovery groups Compose resources, matches canonical Git and reads no environment', async (t) => {
  const f = fixture(t),
    scan = await f.scan();
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].runtime, 'compose');
  assert.equal(scan.candidates[0].resources.length, 2);
  assert.equal(scan.candidates[0].repoMatch, true);
  assert.equal(scan.candidates[0].git.repo, 'https://github.com/owner/app');
  assert.ok(!JSON.stringify(scan).includes('git-secret'));
  assert.ok(!JSON.stringify(scan).includes('containers'));
  assert.ok(!f.commands.join('\n').includes('.Config.Env'));
  assert.ok(
    !f.commands.some((s) =>
      /docker (start|stop|rm|compose)|git (clone|pull|fetch)|systemctl (start|stop)/.test(
        s,
      ),
    ),
  );
  assert.equal(f.get().secret.env, 'OLD_TOKEN=old-hidden-value');
  assert.equal(f.get().status, 'stopped');
});
test('binding saves encrypted configuration and separate environments, omits conflicting flat values, no remote writes', async (t) => {
  const f = fixture(t),
    scan = await f.scan();
  await f.attach(scan);
  const p = f.get();
  assert.equal(p.status, 'running');
  assert.equal(p.autoDeploy, false);
  assert.equal(p.adoption.runtime, 'compose');
  assert.deepEqual(p.adoption.environmentConflicts, ['API_TOKEN']);
  assert.equal(p.secret.adopted.envByService.length, 2);
  assert.ok(p.secret.adopted.sourceFiles['/srv/app/compose.yaml']);
  assert.equal(p.secret.discovery, undefined);
  assert.ok(
    !parseEnvDocument(p.secret.env).rows.some((r) => r.key === 'API_TOKEN'),
  );
  assert.ok(operatorSecrets(f.store).includes('worker-secret-value'));
  const publicState = JSON.stringify(f.store.snapshot());
  const raw = JSON.stringify(
    f.store.db.prepare('SELECT * FROM projects').all(),
  );
  for (const value of [
    'worker-secret-value',
    'web-secret-value',
    'old-hidden-value',
  ]) {
    assert.ok(!publicState.includes(value));
    assert.ok(!raw.includes(value));
  }
  assert.ok(
    !f.commands.some((s) =>
      /docker (start|stop|rm|compose)|systemctl (start|stop)|chmod|install -d|git (clone|fetch)/.test(
        s,
      ),
    ),
  );
});
test('source .env takes precedence and suspicious config paths are not read', async (t) => {
  const f = fixture(t);
  f.files['/srv/app/.env'] = 'API_TOKEN=file-secret-value\nOPTIONAL=\n';
  f.containers[0].configFiles =
    '/srv/app/compose.yaml,/etc/private.yaml,/srv/app/../../etc/secret.yaml';
  const scan = await f.scan();
  await f.attach(scan);
  const p = f.get();
  assert.equal(p.secret.env, f.files['/srv/app/.env']);
  assert.equal(p.adoption.environmentSource, 'file');
  assert.ok(p.adoption.warnings.some((w) => w.includes('/etc/private.yaml')));
  assert.ok(
    !f.commands
      .filter((s) => s.includes('read-adoption-file'))
      .some((s) => s.includes('/etc/')),
  );
  assert.ok(
    f.commands
      .filter((s) => s.includes('read-adoption-file'))
      .every((s) => s.includes('realpath')),
  );
});
test('stale scan, changed SSH identity and changed container identity reject before binding', async (t) => {
  const f = fixture(t);
  const scan = await f.scan();
  await assert.rejects(
    () =>
      f.adoption.attach(
        {},
        f.get(),
        f.server,
        { scanId: 'wrong', candidateId: scan.candidates[0].id },
        () => {},
      ),
    /устарел/,
  );
  await assert.rejects(
    () =>
      f.adoption.attach(
        {},
        f.get(),
        { ...f.server, fingerprint: 'changed' },
        { scanId: scan.id, candidateId: scan.candidates[0].id },
        () => {},
      ),
    /устарел/,
  );
  f.containers[0].id = 'd'.repeat(64);
  await assert.rejects(() => f.attach(scan), /изменилось|исчезло/);
  assert.equal(f.get().adoption, undefined);
  assert.equal(f.get().secret.env, 'OLD_TOKEN=old-hidden-value');
});
test('duplicate binding is marked in discovery and rejected even if another card links after scan', async (t) => {
  const f = fixture(t),
    scan = await f.scan();
  f.store.save('projects', {
    ...f.project,
    id: randomUUID(),
    name: 'neighbor',
    adoption: { resources: scan.candidates[0].resources },
  });
  await assert.rejects(() => f.attach(scan), /другой карточке/);
  const next = await f.scan();
  assert.equal(next.candidates[0].linkedProject, 'neighbor');
});
test('bound lifecycle uses exact original IDs without Git, file writes or model, check preserves stopped state', async (t) => {
  const f = fixture(t),
    scan = await f.scan();
  await f.attach(scan);
  f.commands.length = 0;
  const engine = createEngine(f.store, {
    run: f.run,
    connect: async () => ({ end() {} }),
    put: async () => assert.fail('Unexpected write'),
    chat: async () => assert.fail('Unexpected LLM'),
  });
  for (const op of ['stop', 'deploy', 'restart']) {
    const job = engine.enqueue(op, { projectId: f.project.id });
    await engine.drain();
    assert.equal(f.store.get('jobs', job.id).status, 'success');
  }
  assert.ok(
    f.commands.some(
      (s) => s === `docker start '${'a'.repeat(64)}' '${'b'.repeat(64)}'`,
    ),
  );
  assert.ok(!f.commands.some((s) => /git |compose --|install -d/.test(s)));
  assert.ok(
    !JSON.stringify(f.store.list('jobs')).includes('worker-secret-value'),
  );
  f.containers.forEach((c) => (c.running = false));
  let job = engine.enqueue('check', { projectId: f.project.id });
  await engine.drain();
  assert.equal(f.get().status, 'stopped');
  assert.equal(f.store.get('jobs', job.id).status, 'success');
  assert.throws(
    () =>
      engine.enqueue('auto-deploy', { projectId: f.project.id, useLlm: false }),
    /существующего/,
  );
  f.fail = true;
  job = engine.enqueue('remove', {
    projectId: f.project.id,
    deleteProject: true,
  });
  await engine.drain();
  assert.equal(f.store.get('jobs', job.id).status, 'failed');
  assert.ok(f.get());
  f.fail = false;
  job = engine.enqueue('remove', {
    projectId: f.project.id,
    deleteProject: true,
  });
  await engine.drain();
  assert.equal(f.store.get('jobs', job.id).status, 'success');
  assert.equal(f.get(), null);
});
test('systemd import selects custom units and lifecycle does not touch critical services', async (t) => {
  const f = fixture(t);
  f.containers = [];
  f.units = ['app', 'ssh@instance']
    .map(
      (name) =>
        `Id=${name}.service\nDescription=App\nActiveState=active\nSubState=running\nMainPID=123\nWorkingDirectory=/srv/service\nFragmentPath=/etc/systemd/system/${name}.service\nUser=app`,
    )
    .join('\n\n');
  f.files['/etc/systemd/system/app.service'] =
    '[Service]\nExecStart=/srv/service/app\n';
  const scan = await f.scan();
  assert.equal(scan.candidates.length, 1);
  await f.attach(scan);
  assert.ok(f.get().secret.env.includes('systemd-secret-value'));
  await f.adoption.execute({}, f.get(), 'stop');
  assert.ok(f.commands.includes("systemctl stop -- 'app.service'"));
  assert.throws(() =>
    adoptionCommands({ runtime: 'systemd', unit: 'ssh@instance.service' }),
  );
});
test('unrecognized runtime binds directory only and needs explicit workflow for mutation', async (t) => {
  const f = fixture(t);
  f.containers = [];
  const scan = await f.scan('/srv/unmanaged');
  assert.equal(scan.candidates[0].runtime, 'directory');
  await f.attach(scan);
  assert.equal(f.get().status, 'needs_setup');
  const commands = adoptionCommands(f.get().adoption);
  for (const op of ['deploy', 'stop', 'remove'])
    assert.ok(commands[op].includes('exit 1'));
});
test('custom workflows use original directory without importing PATH or overwriting original env', async (t) => {
  const f = fixture(t);
  await f.attach(await f.scan());
  f.commands.length = 0;
  saveWorkflow(f.store, f.project.id, {
    summary: 'update in place',
    deploy: './update-app',
    stop: './stop-app',
    remove: './remove-app',
    check: './check-app',
    logs: './logs-app',
    files: {},
    env: [],
  });
  const runner = createWorkflowRunner(f.store, {
    run: f.run,
    put: async () => assert.fail('Unexpected config overwrite'),
  });
  await runner.execute({}, f.get(), f.server, 'deploy', () => {});
  assert.ok(f.commands.every((s) => s.includes("cd '/srv/app'")));
  assert.ok(!f.commands.join('\n').includes('export PATH='));
  assert.ok(!f.commands.join('\n').includes('git fetch'));
  assert.ok(!f.commands.join('\n').includes('/untrusted/bin'));
  const stopped = f.get();
  stopped.status = 'stopped';
  f.store.save('projects', stopped);
  await runner.execute({}, f.get(), f.server, 'check', () => {});
  assert.equal(f.get().status, 'running');
  f.fail = true;
  await assert.rejects(() =>
    runner.execute({}, f.get(), f.server, 'check', () => {}),
  );
  assert.equal(f.get().status, 'failed');
});
test('owner API requires selected adoption confirmation, keeps env read-only and unlinks without remote commands', async (t) => {
  const f = fixture(t);
  const scan = await f.scan();
  const enqueued = [];
  const app = createApp({ legacyApi: true,
    store: f.store,
    token: 'owner',
    engine: {
      enqueue: (...args) => {
        enqueued.push(args);
        return { id: 'job' };
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
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
  const path = '/projects/' + f.project.id;
  assert.equal((await fetch(base + path + '/adoption-snapshot')).status, 401);
  assert.equal((await request(path + '/adopt', 'POST', {})).status, 400);
  assert.equal(
    (
      await request(path + '/adopt', 'POST', {
        confirmAdopt: true,
        scanId: scan.id,
        candidateId: scan.candidates[0].id,
      })
    ).status,
    202,
  );
  assert.equal(enqueued[0][0], 'adopt');
  await f.attach(scan);
  assert.equal(
    (await request(path, 'PATCH', { env: 'BAD=overwrite' })).status,
    400,
  );
  assert.equal(
    (await request(path, 'PATCH', { autoDeploy: true })).status,
    400,
  );
  assert.equal((await request(path + '/adoption-snapshot')).status, 200);
  f.store.save('jobs', {
    id: randomUUID(),
    type: 'chat',
    serverId: f.server.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    logs: [],
  });
  assert.equal((await request(path + '/unlink', 'POST', {})).status, 409);
  f.store.db.prepare('DELETE FROM jobs').run();
  const count = f.commands.length;
  assert.equal((await request(path + '/unlink', 'POST', {})).status, 200);
  assert.equal(f.get().adoption, undefined);
  assert.equal(f.commands.length, count);
});
test('paths, SSH repository normalization and resource IDs reject ambiguous inputs', () => {
  for (const path of [
    '/',
    '/srv',
    '/etc',
    '/proc/12',
    '/srv/app/../other',
    'relative',
    '/srv/app\ncommand',
  ])
    assert.throws(() => adoptionDirectory(path));
  assert.equal(adoptionDirectory('/srv/a b/'), '/srv/a b');
  assert.equal(
    normalizedRepo('git@github.com:owner/app.git'),
    'https://github.com/owner/app',
  );
  assert.throws(() =>
    adoptionCommands({ runtime: 'docker', resources: ['container; rm -rf /'] }),
  );
});

// A linked application may already rely on executable/readable file permissions.
test('writing adopted workflow files preserves existing modes; new files remain private', async () => {
  const { Writable } = await import('node:stream');
  const { put } = await import('../runner/ssh.mjs');
  for (const existing of [true, false]) {
    const modes = [];
    const sftp = {
      stat(_path, cb) {
        cb(
          existing ? null : Object.assign(new Error('missing'), { code: 2 }),
          existing ? { mode: 0o100750 } : undefined,
        );
      },
      createWriteStream(_path, options) {
        modes.push(options.mode);
        return new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        });
      },
      chmod(_path, mode, done) {
        modes.push(mode);
        done();
      },
      end() {},
    };
    await put(
      {
        sftp(cb) {
          cb(null, sftp);
        },
      },
      '/srv/app/start.sh',
      '#!/bin/sh\n',
      { preserveMode: true },
    );
    assert.deepEqual(modes, existing ? [0o750, 0o750] : [0o600, 0o600]);
  }
});

test('standalone Docker imports without Compose labels or repository directory', async (t) => {
  const f = fixture(t);
  f.containers = [
    {
      ...f.containers[0],
      project: null,
      directory: null,
      configFiles: null,
      service: null,
    },
  ];
  const scan = await f.scan();
  assert.equal(scan.candidates[0].runtime, 'docker');
  assert.equal(scan.candidates[0].directory, '');
  await f.attach(scan);
  assert.equal(f.get().adoption.runtime, 'docker');
  assert.equal(f.get().secret.adopted.configuration.containers.length, 1);
  assert.ok(
    parseEnvDocument(f.get().secret.env).rows.some(
      (r) => r.key === 'API_TOKEN',
    ),
  );
  assert.equal(
    adoptionCommands(f.get().adoption).deploy,
    `docker start '${'a'.repeat(64)}'`,
  );
});
