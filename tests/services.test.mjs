import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { createHub } from '../runner/hub.mjs';
import { openStore } from '../runner/store.mjs';

const appSource = { type: 'compose', stack: 'shop', component: 'api' };
const sshSecret = 'private-ssh-value';
const manifestSecret = 'private-manifest-value';

function fakeCodex(messages) {
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const events = new EventEmitter();
  const emit = (message) => stdout.write(JSON.stringify(message) + '\n');
  const input = new Writable({
    write(chunk, _enc, done) {
      const message = JSON.parse(chunk.toString());
      messages.push(message);
      const result = {
        initialize: {},
        'account/read': { account: { type: 'chatgpt' } },
        'thread/start': { thread: { id: 'draft-thread' } },
        'turn/start': { turn: { id: 'draft-turn' } },
      }[message.method];
      if (result) emit({ id: message.id, result });
      if (message.method === 'turn/start') {
        emit({
          method: 'item/completed',
          params: {
            threadId: 'draft-thread',
            item: {
              type: 'agentMessage',
              text: JSON.stringify({
                name: 'Shop API',
                description: 'HTTP API магазина',
                environment: '',
                notes: 'Запускается как сервис api в стеке shop.',
              }),
            },
          },
        });
        emit({
          method: 'turn/completed',
          params: { threadId: 'draft-thread', turn: { status: 'completed' } },
        });
      }
      done();
    },
  });
  return { input, stdout, stderr, events, close: () => events.emit('close') };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mayplane-services-'));
  const store = openStore(directory, randomBytes(32));
  const host = randomUUID(),
    remote = randomUUID();
  const calls = [],
    agentCalls = [];
  let container = 'a'.repeat(64),
    online = true;
  store.save(
    'servers',
    {
      id: host,
      name: 'Хост панели',
      transport: 'local',
      platform: process.platform,
      status: 'online',
    },
    {},
  );
  store.save(
    'servers',
    {
      id: remote,
      name: 'VPS',
      transport: 'ssh',
      platform: 'linux',
      status: 'online',
    },
    { password: sshSecret },
  );
  const hub = createHub(new EventEmitter(), store, {
    openProcess: async (machine, options) => {
      assert.equal(machine.id, host);
      assert.equal(machine.transport, 'local');
      assert.equal(options.provider, 'codex');
      return fakeCodex(agentCalls);
    },
    serviceOptions: {
      withMachine: async (machine, work) => {
        assert.equal(machine.id, remote);
        if (!online) throw new Error('SSH-соединение недоступно.');
        return work(async (file, args) => {
          calls.push([file, ...args]);
          if (file === 'docker' && args[0] === 'ps')
            return JSON.stringify({
              id: container,
              name: 'shop-api-1',
              stack: 'shop',
              component: 'api',
            });
          if (file === 'docker' && args[0] === 'inspect')
            return JSON.stringify({
              id: container,
              image: 'registry.example/shop',
              state: 'running',
              exitCode: 0,
              started: '2025-01-10T11:00:00.000Z',
              restarts: 2,
              health: 'healthy',
              directory: '/srv/shop',
              ports: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
              },
            });
          if (file === 'docker' && args[0] === 'stats')
            return JSON.stringify({
              id: container,
              cpu: '42.50%',
              memory: '18MiB / 1GiB',
            });
          if (file === 'docker' && args[0] === 'logs')
            return '2025-01-10T11:00:00.123456789Z started ' + sshSecret + '\n';
          if (file === 'systemctl' && args[0] === 'list-units')
            return 'worker.service loaded active running Worker\n';
          if (file === 'systemctl' && args[0] === 'show')
            return [
              'Id=worker.service',
              'LoadState=loaded',
              'ActiveState=active',
              'SubState=running',
              'Description=Queue worker',
              'WorkingDirectory=/srv/worker',
              'FragmentPath=/etc/systemd/system/worker.service',
              'Type=simple',
              'NRestarts=3',
              'MemoryCurrent=12000',
            ].join('\n');
          if (file === 'journalctl')
            return '2025-01-10T11:00:00.123456+0000 vps worker[123]: boot\n';
          if (file === 'curl') return '204';
          if (file === 'bash') {
            const pkg = {
              name: 'shop-api',
              scripts: { start: 'node app.js --token ' + manifestSecret },
              dependencies: { fastify: '1.0.0' },
              private: manifestSecret,
            };
            return (
              'FILE:package.json\nFILE:compose.yaml\nPACKAGE:' +
              Buffer.from(JSON.stringify(pkg)).toString('base64') +
              '\n'
            );
          }
          assert.fail('Unexpected machine command: ' + file + ' ' + args[0]);
        });
      },
    },
  });
  t.after(() => {
    hub.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function request(path = '', method = 'GET', body = {}) {
    let response;
    try {
      assert(
        await hub.handle(
          '/api/hub' + path,
          method,
          body,
          (data, status = 200) => {
            response = { data, status };
          },
        ),
      );
    } catch (error) {
      if (!error.status) throw error;
      return { status: error.status, data: { error: error.message } };
    }
    return response;
  }
  return {
    host,
    remote,
    request,
    store,
    calls,
    agentCalls,
    recreateContainer() {
      container = 'b'.repeat(64);
      return container;
    },
    disconnect() {
      online = false;
    },
  };
}

async function until(read, matches) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await read();
    if (matches(result)) return result;
    await pause(10);
  }
  assert.fail('The service did not reach the requested state.');
}

test('service discovery and observations follow a Compose service through recreation and machine failure', async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['Date'] });
  const project = await f.request('/projects', 'POST', {
    name: 'Магазин',
    machineId: f.host,
    path:
      process.platform === 'win32' ? 'C:\\Projects\\shop' : '/workspace/shop',
  });
  const discovered = await f.request('/services/discover', 'POST', {
    machineId: f.remote,
  });
  assert.equal(discovered.status, 200);
  assert.deepEqual(
    discovered.data.candidates.map((candidate) => candidate.source),
    [appSource, { type: 'systemd', unit: 'worker.service' }],
  );
  const fields = {
    machineId: f.remote,
    projectId: project.data.id,
    source: appSource,
    name: 'API',
    directory: '/srv/shop',
    healthUrl: 'http://127.0.0.1:8080/health',
  };
  const created = await f.request('/services', 'POST', fields);
  assert.equal(created.status, 201);
  const path = '/services/' + created.data.id;
  const { data: service } = await until(
    () => f.request(path),
    (r) => r.data.status === 'running',
  );
  assert.equal(service.projectId, project.data.id);
  assert.equal(service.machineId, f.remote);
  assert.equal(service.health, 'healthy');
  assert.equal(service.cpuCores, 0.425);
  assert.equal(service.memoryBytes, 18 * 1024 * 1024);
  assert.equal(service.restarts, 2);
  assert.deepEqual(service.http, { status: 'ok', code: 204 });
  assert.equal(service.history.length, 1);
  assert.equal((await f.request('/services', 'POST', fields)).status, 409);
  assert.equal(
    (await f.request(path, 'PATCH', { healthUrl: 'http://169.254.169.254' }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(path, 'PATCH', {
        source: { type: 'systemd', unit: 'x.service; thing' },
      })
    ).status,
    400,
  );
  const replacement = f.recreateContainer();
  const logs = await f.request(path + '/logs');
  assert.equal(logs.data.lines[0].text, 'started [REDACTED]');
  assert.equal(logs.data.lines[0].source, replacement.slice(0, 12));
  const beforePoll = f.calls.length;
  await f.request();
  await f.request();
  assert.equal(f.calls.length, beforePoll);
  f.disconnect();
  t.mock.timers.tick(11000);
  assert.equal(
    (await f.request('/services/refresh', 'POST', { machineId: f.remote }))
      .status,
    202,
  );
  const failed = await until(
    () => f.request(path),
    (r) => r.data.status === 'unknown',
  );
  assert.equal(failed.data.checkedAt, service.checkedAt);
  assert.equal(failed.data.error, 'SSH-соединение недоступно.');
  assert.equal(failed.data.history.length, 2);
});

test('native Codex on the panel host receives selected service facts and prepares an unsaved draft', async (t) => {
  const f = fixture(t);
  const project = await f.request('/projects', 'POST', {
    name: 'Магазин',
    machineId: f.remote,
    path: '/srv/shop',
  });
  const created = await f.request('/services/drafts', 'POST', {
    machineId: f.remote,
    source: appSource,
    notes: 'private-user-note',
  });
  assert.equal(created.status, 202);
  const { data } = await until(
    () => f.request('/services/drafts/' + created.data.id),
    (r) => ['ready', 'failed'].includes(r.data.status),
  );
  assert.equal(data.status, 'ready', data.error);
  assert.deepEqual(data.suggestion, {
    name: 'Shop API',
    description: 'HTTP API магазина',
    environment: '',
    notes: 'Запускается как сервис api в стеке shop.',
    directory: '/srv/shop',
    projectId: project.data.id,
  });
  assert.deepEqual((await f.request()).data.services, []);
  assert.deepEqual((await f.request()).data.sessions, []);
  const thread = f.agentCalls.find((call) => call.method === 'thread/start');
  assert.equal(thread.params.ephemeral, true);
  assert.equal(thread.params.sandbox, 'read-only');
  assert.equal(thread.params.approvalPolicy, 'never');
  assert.deepEqual(thread.params.environments, []);
  const turn = f.agentCalls.find((call) => call.method === 'turn/start');
  assert.deepEqual(turn.params.outputSchema.required, [
    'name',
    'description',
    'environment',
    'notes',
  ]);
  const facts = JSON.parse(turn.params.input[0].text);
  assert.deepEqual(facts.package, {
    name: 'shop-api',
    scriptNames: ['start'],
    dependencies: ['fastify'],
  });
  assert.deepEqual(facts.publishedPorts, ['127.0.0.1:8080 → 8080/tcp']);
  assert.doesNotMatch(turn.params.input[0].text, /private-|node app/);
});

test('project removal unlinks services and machine removal includes registered, legacy and edited legacy cards', async (t) => {
  const f = fixture(t);
  const legacy = randomUUID();
  f.store.save(
    'settings',
    {
      id: legacy,
      recordType: 'service_context',
      legacyProjectId: legacy,
      machineId: f.remote,
    },
    { retained: 'old imported context' },
  );
  f.store.save(
    'projects',
    {
      id: legacy,
      name: 'Прежний сервис',
      serverId: f.remote,
      status: 'running',
      domain: 'example.com',
    },
    { env: 'PRIVATE=legacy-value' },
  );
  const project = await f.request('/projects', 'POST', {
    name: 'Рабочая папка',
    machineId: f.host,
    path: process.platform === 'win32' ? 'C:\\Projects\\ops' : '/workspace/ops',
  });
  const fallback = await f.request('/services/' + legacy);
  assert.equal(fallback.data.status, 'unconfigured');
  assert.equal(fallback.data.url, 'https://example.com/');
  const overlay = await f.request('/services/' + legacy, 'PATCH', {
    projectId: project.data.id,
    notes: 'На сервере VPS',
  });
  assert.equal(overlay.status, 200);
  assert.equal(overlay.data.id, legacy);
  assert.equal(
    f.store.get('settings', legacy).secret.retained,
    'old imported context',
  );
  assert.equal(
    f.store.get('projects', legacy).secret.env,
    'PRIVATE=legacy-value',
  );
  const worker = await f.request('/services', 'POST', {
    machineId: f.remote,
    projectId: project.data.id,
    name: 'Worker',
    source: { type: 'systemd', unit: 'worker.service' },
  });
  const path = '/services/' + worker.data.id;
  const journal = await f.request(path + '/logs');
  assert.equal(journal.data.lines[0].source, 'worker.service');
  assert.match(journal.data.lines[0].text, /boot$/);
  const preview = await f.request('/removals/project/' + project.data.id);
  assert.equal(preview.data.detachedServices, 2);
  assert.equal(
    (await f.request('/projects/' + project.data.id, 'DELETE')).status,
    200,
  );
  assert.equal((await f.request(path)).data.projectId, null);
  assert.equal((await f.request('/services/' + legacy)).data.projectId, null);

  const remove = '/removals/machine/' + f.remote;
  const toRemove = await f.request(remove);
  assert.equal(toRemove.data.services, 2);
  const removed = await f.request(remove, 'DELETE', {
    confirm: true,
    confirmName: 'VPS',
    revision: toRemove.data.revision,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    new Set(removed.data.deletedServices),
    new Set([worker.data.id, legacy]),
  );
  assert.equal(f.store.get('settings', legacy), null);
  assert.equal(f.store.get('settings', 'service:' + legacy), null);
  assert.equal(f.store.get('projects', legacy), null);
  assert.deepEqual((await f.request()).data.services, []);
  assert(!f.calls.some((args) => args.includes('stop') || args.includes('rm')));
});
