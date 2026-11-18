import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import ssh2 from 'ssh2';
import {
  inlineMentionRanges,
  mentionQuery,
  mentionText,
  unwrapChatTargetsInput,
} from '../lib/chat-references.mjs';
import { serviceHasChat } from '../lib/service-workspace.mjs';
import { createHub } from '../runner/hub.mjs';
import { controlServiceSource } from '../runner/service-runtime.mjs';
import { openStore } from '../runner/store.mjs';

test('mention suggestions recognize typed queries without reopening existing tags', () => {
  const name = mentionText('Веб сервис');
  const saved = `Логи ${name}`;
  const mentions = [{ kind: 'service', start: 5, end: saved.length }];
  assert.equal(mentionQuery('dev@example.com', 15, []), null);
  assert.deepEqual(mentionQuery('статус @сервер?', 14, []), {
    start: 7,
    end: 14,
    query: 'сервер',
  });
  assert.equal(mentionQuery(saved, saved.length, mentions), null);
});

test('inline history uses the saved position of repeated names and restores unambiguous legacy mentions', () => {
  const text = 'Пример @prod, проверь @prod.';
  const start = text.lastIndexOf('@prod');
  const mention = { id: 'prod', text: '@prod' };
  const selected = { ...mention, start, end: start + mention.text.length };
  assert.deepEqual(inlineMentionRanges(text, [selected]), [selected]);
  assert.deepEqual(inlineMentionRanges(text, [mention]), []);
  assert.deepEqual(inlineMentionRanges('dev@prod и @prod.', [mention]), [
    { ...mention, start: 11, end: 16 },
  ]);
});

test('Compose control acts only on the replicas of the selected component', async () => {
  const id = (digit) => digit.repeat(64);
  const calls = [];
  const execute = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'ps')
      return [
        { id: id('1'), stack: 'prod', component: 'api' },
        { id: id('2'), stack: 'prod', component: 'api' },
        { id: id('3'), stack: 'prod', component: 'worker' },
        { id: id('4'), stack: 'prod', component: 'api', oneOff: 'true' },
        { id: id('5'), stack: 'staging', component: 'api' },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n');
    return '';
  };
  const source = { type: 'compose', stack: 'prod', component: 'api' };
  assert.equal(
    await controlServiceSource(execute, source, 'restart', () => {
      assert.equal(calls.length, 1);
    }),
    2,
  );
  assert.deepEqual(calls[1], ['docker', 'restart', '--', id('1'), id('2')]);
});

function fakeAgent(calls, prompts) {
  const input = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const events = new EventEmitter();
  const emit = (packet) => stdout.write(JSON.stringify(packet) + '\n');
  input.on('data', (bytes) => {
    const message = JSON.parse(bytes.toString());
    calls.push(message);
    const responses = {
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
        },
      },
      'account/read': { requiresOpenaiAuth: false },
      'thread/start': { thread: { id: 'native' } },
      'thread/resume': { thread: { id: 'native' } },
      'turn/start': { turn: { id: 'turn' } },
      'turn/interrupt': {},
      'session/new': { sessionId: 'native' },
      'session/load': {},
    };
    if (message.method === 'turn/start')
      prompts.push(message.params.input[0].text);
    if (message.method === 'session/prompt')
      prompts.push(message.params.prompt[0].text);
    if (Object.hasOwn(responses, message.method))
      emit({ id: message.id, result: responses[message.method] });
  });
  return { input, stdout, stderr, events, emit, close() {} };
}

async function sshFixture(t, password) {
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const fingerprint =
    'SHA256:' +
    createHash('sha256')
      .update(ssh2.utils.parseKey(key).getPublicSSH())
      .digest('base64')
      .replace(/=+$/, '');
  const scriptRequests = [],
    clients = new Set();
  let authentications = 0;
  const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password' || ctx.password !== password)
        return ctx.reject();
      authentications++;
      ctx.accept();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        accept().on('exec', (accept) => {
          const channel = accept();
          let script = '';
          channel.on('data', (chunk) => {
            script += chunk.toString();
            if (!script.endsWith('\0')) return;
            scriptRequests.push(script);
            if (script.includes("'journalctl'")) {
              channel.write(
                `2025-01-01T12:00:00.000000+00:00 Application log ${password}\n`,
              );
            } else if (script.includes("'show'")) {
              channel.write(
                'Id=worker.service\nLoadState=loaded\nActiveState=inactive\n',
              );
            }
            channel.exit(0);
            channel.end();
          });
        });
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of clients) client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    host: '127.0.0.1',
    port: server.address().port,
    fingerprint,
    scripts: scriptRequests,
    get authentications() {
      return authentications;
    },
  };
}

function chatFixture(t, ssh, password) {
  const cwd = mkdtempSync(join(tmpdir(), 'mayplane-host-ssh-'));
  const store = openStore(cwd, randomBytes(32));
  const local = randomUUID(),
    remote = randomUUID(),
    unrelated = randomUUID(),
    project = randomUUID(),
    service = randomUUID();
  const launches = [],
    prompts = [],
    calls = [];
  store.save(
    'servers',
    {
      id: local,
      transport: 'local',
      name: 'Panel',
      platform: process.platform,
    },
    {},
  );
  for (const [id, name] of [
    [remote, 'Prod'],
    [unrelated, 'Other'],
  ])
    store.save(
      'servers',
      {
        id,
        name,
        host: ssh.host,
        port: ssh.port,
        fingerprint: ssh.fingerprint,
        username: 'owner',
      },
      { password },
    );
  store.save(
    'settings',
    {
      id: project,
      recordType: 'workspace',
      machineId: local,
      name: 'Workspace',
      path: cwd,
    },
    {},
  );
  const card = {
    id: `service:${service}`,
    serviceId: service,
    recordType: 'service',
    machineId: remote,
    name: 'Веб сервис',
    source: { type: 'systemd', unit: 'worker.service' },
  };
  store.save('settings', card, {});
  const hub = createHub(new EventEmitter(), store, {
    resolveHome: async () => cwd,
    openProcess: async (machine, options) => {
      const process = fakeAgent(calls, prompts);
      if (options.operation === 'auth-status')
        setImmediate(() => {
          process.stdout.write('{"loggedIn":true}');
          process.events.emit('close', 0);
        });
      else launches.push({ machine, options, process });
      return process;
    },
  });
  t.after(() => {
    hub.close();
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', body = {}) {
    let data;
    assert(
      await hub.handle('/api/hub' + path, method, body, (value) => {
        data = value;
      }),
    );
    return data;
  }
  async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await check();
      if (value) return value;
      await pause(15);
    }
    assert.fail('Expected chat event');
  }
  let nextId = 0;
  const mcp = (connection, method, params, headers) =>
    fetch(connection.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
      signal: AbortSignal.timeout(5000),
    });
  const tool = async (connection, name, args) => {
    const response = await mcp(connection, 'tools/call', {
      name,
      arguments: args,
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  return {
    local,
    remote,
    unrelated,
    project,
    service,
    card,
    request,
    waitFor,
    launches,
    prompts,
    calls,
    store,
    mcp,
    tool,
  };
}

test(
  'host Codex operates on the selected SSH service using stored credentials and an explicit approval',
  { timeout: 20000 },
  async (t) => {
    const password = 'local-fixture-ssh-password';
    const ssh = await sshFixture(t, password);
    const f = chatFixture(t, ssh, password);
    const session = await f.request('/sessions', 'POST', {
      machineId: f.local,
      provider: 'codex',
    });
    const path = `/sessions/${session.id}`;
    await f.request(path + '/execution', 'PATCH', {
      autoApprove: true,
      confirmAutoApprove: true,
    });
    const message = 'Логи @"Веб сервис" для @Workspace';
    const mentions = [
      { kind: 'service', id: f.service, start: 5, end: 18 },
      { kind: 'project', id: f.project, start: 23, end: message.length },
    ];
    await f.request(path + '/message', 'POST', {
      message: '  ' + message + ' \n',
      mentions: mentions.map((ref) => ({
        ...ref,
        start: ref.start + 2,
        end: ref.end + 2,
      })),
    });
    await f.waitFor(() => f.prompts[0]);
    const connection = f.launches[0].options.hostMcp;
    assert.equal(f.launches[0].machine.id, f.local);
    assert(!JSON.stringify(f.launches[0].options).includes(password));
    assert(!f.prompts[0].includes(password));
    assert(!f.prompts[0].includes(connection.token));
    assert.deepEqual(
      unwrapChatTargetsInput(f.prompts[0]).mentions.map(({ id }) => id),
      [f.service, f.project],
    );
    const saved = (await f.request(path)).messages[0];
    assert.equal(saved.content, message);
    assert.deepEqual(
      saved.mentions.map(({ kind, id, start, end }) => ({
        kind,
        id,
        start,
        end,
      })),
      mentions,
    );
    assert.equal(
      (
        await f.mcp(
          connection,
          'tools/list',
          {},
          { Origin: 'http://example.test' },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.mcp({ ...connection, token: 'invalid' }, 'tools/list', {}))
        .status,
      401,
    );
    assert(
      (
        await (await f.mcp(connection, 'tools/list', {})).json()
      ).result.tools.some(({ name }) => name === 'service_control'),
    );

    const target = `service:${f.service}`;
    const wrongTarget = await f.tool(connection, 'server_status', {
      target: `machine:${f.unrelated}`,
    });
    assert.equal(wrongTarget.isError, true);
    const logs = await f.tool(connection, 'service_logs', { target });
    assert(ssh.authentications > 0);
    assert.equal(logs.isError, undefined);
    assert.match(logs.content[0].text, /Application log \[REDACTED\]/);
    assert(ssh.scripts.every((script) => !script.includes(password)));

    const restart = () =>
      f.tool(connection, 'service_control', { target, action: 'restart' });
    const waitForApproval = () =>
      f.waitFor(async () => (await f.request(path)).approvals[0]);
    const changed = () =>
      ssh.scripts.filter((script) => script.includes("'restart'"));
    const first = restart();
    const denied = await waitForApproval();
    assert.equal(denied.kind, 'ssh');
    assert.equal(denied.params.sshOperation.source, 'worker.service');
    assert.equal(changed().length, 0);
    await f.request(path + '/approval', 'POST', {
      id: denied.id,
      decision: 'decline',
    });
    assert.equal((await first).isError, true);
    assert.equal(changed().length, 0);

    const second = restart();
    const approved = await waitForApproval();
    const decision = { id: approved.id, decision: 'accept' };
    await f.request(path + '/approval', 'POST', decision);
    await assert.rejects(f.request(path + '/approval', 'POST', decision), {
      status: 409,
    });
    assert.equal(JSON.parse((await second).content[0].text).completed, true);
    assert.equal(changed().length, 1);
    assert.match(
      changed()[0],
      /'systemctl' '--no-ask-password' '--no-pager' 'restart' '--' 'worker\.service'/,
    );

    f.launches[0].process.emit({
      method: 'turn/completed',
      params: { threadId: 'native', turn: { id: 'turn', status: 'completed' } },
    });
    await f.waitFor(async () => (await f.request(path)).status === 'idle');
    assert.equal(
      (await f.tool(connection, 'service_logs', { target })).isError,
      true,
    );

    await f.request(path + '/message', 'POST', { message, mentions });
    await f.waitFor(() => f.prompts[1]);
    const third = restart();
    await waitForApproval();
    await f.request(path + '/stop', 'POST');
    await third.catch(() => {});
    assert.equal(changed().length, 1);
    assert.deepEqual((await f.request(path)).approvals, []);
    assert.equal((await f.mcp(connection, 'tools/list', {})).status, 401);
  },
);

test(
  'a host ACP chat pins a service, and changed sources invalidate pending approval',
  { timeout: 15000 },
  async (t) => {
    const password = 'local-acp-ssh-password';
    const ssh = await sshFixture(t, password);
    const f = chatFixture(t, ssh, password);
    const sshTarget = { kind: 'service', id: f.service };
    await assert.rejects(
      f.request('/sessions', 'POST', {
        machineId: f.remote,
        provider: 'opencode',
        sshTarget,
      }),
      { status: 400 },
    );
    const session = await f.request('/sessions', 'POST', {
      machineId: f.local,
      provider: 'opencode',
      sshTarget,
    });
    assert(serviceHasChat({ id: f.service }, session, []));
    const path = `/sessions/${session.id}`;
    await f.request(path + '/message', 'POST', { message: 'Останови службу' });
    const prompt = await f.waitFor(() => f.prompts[0]);
    assert.equal(unwrapChatTargetsInput(prompt).content, 'Останови службу');
    const connection = f.launches[0].options.hostMcp;
    const config = f.calls.find(({ method }) => method === 'session/new').params
      .mcpServers[0];
    assert.equal(config.url, connection.url);
    assert.equal(config.name, 'mayplane_ssh');
    const result = f.tool(connection, 'service_control', {
      target: `service:${f.service}`,
      action: 'stop',
    });
    const approval = await f.waitFor(
      async () => (await f.request(path)).approvals[0],
    );
    f.store.save(
      'settings',
      { ...f.card, source: { type: 'systemd', unit: 'replacement.service' } },
      {},
    );
    await f.request(path + '/approval', 'POST', {
      id: approval.id,
      decision: 'accept',
    });
    assert.equal((await result).isError, true);
    assert(!ssh.scripts.some((script) => script.includes("'stop'")));
    await f.request(path + '/stop', 'POST');
  },
);
