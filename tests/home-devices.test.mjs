import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  connectorEndpoint,
  automaticConnectorEndpoint,
} from '../lib/machine-connection.mjs';
import { connectorServicePlan } from '../runner/connector-service.mjs';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';

test('hosted connector addresses require TLS and never accept credentials or ambiguous paths', () => {
  assert.equal(
    connectorEndpoint('https://control.example.com/'),
    'wss://control.example.com/api/connector',
  );
  assert.equal(
    connectorEndpoint('http://127.0.0.1:8788'),
    'ws://127.0.0.1:8788/api/connector',
  );
  assert.equal(
    connectorEndpoint('wss://control.example.com/api/connector'),
    'wss://control.example.com/api/connector',
  );
  for (const value of [
    'http://192.168.1.3:8788',
    'ws://public.example/api/connector',
    'https://secret@panel.example',
    'https://panel.example/?token=secret',
    'https://panel.example/#secret',
    'https://panel.example/other',
  ])
    assert.throws(() => connectorEndpoint(value));
});
test('automatic address follows configured public URL, separate API or browser origin including IP and ports', () => {
  assert.equal(
    automaticConnectorEndpoint({ pageOrigin: 'https://83.217.221.18:8443' }),
    'wss://83.217.221.18:8443/api/connector',
  );
  assert.equal(
    automaticConnectorEndpoint({ pageOrigin: 'https://panel.example.com' }),
    'wss://panel.example.com/api/connector',
  );
  assert.equal(
    automaticConnectorEndpoint({ pageOrigin: 'https://[2001:db8::1]:8443' }),
    'wss://[2001:db8::1]:8443/api/connector',
  );
  assert.equal(
    automaticConnectorEndpoint({ pageOrigin: 'http://localhost:3000' }),
    'ws://localhost:3000/api/connector',
  );
  assert.equal(
    automaticConnectorEndpoint({
      apiUrl: 'https://api.example.com',
      pageOrigin: 'https://ui.example.com',
    }),
    'wss://api.example.com/api/connector',
  );
  assert.equal(
    automaticConnectorEndpoint({
      publicUrl: 'wss://public.example.com/api/connector',
      apiUrl: 'https://internal.example.com',
      pageOrigin: 'http://localhost:3000',
    }),
    'wss://public.example.com/api/connector',
  );
  assert.throws(
    () =>
      automaticConnectorEndpoint({ pageOrigin: 'http://83.217.221.18:8788' }),
    /HTTPS/,
  );
});
test('autostart plans use the current user and quote paths without placing credentials in commands', () => {
  const opts = {
    home: '/home/user',
    directory: '/home/user/Connector & Projects',
    script: '/path with spaces/connector.mjs',
    node: '/node/bin/node',
    username: 'owner',
    uid: 501,
  };
  const linux = connectorServicePlan('linux', opts),
    mac = connectorServicePlan('darwin', opts),
    win = connectorServicePlan('win32', {
      ...opts,
      home: 'C:\\Users\\owner',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      directory: 'C:\\Users\\owner\\Connector & Data',
      script: 'D:\\A B\\connector.mjs',
      domain: 'PC',
    });
  assert.match(
    linux.content,
    /ExecStart="\/node\/bin\/node" "\/path with spaces\/connector.mjs"/,
  );
  assert.ok(linux.install.every(([, args]) => args.includes('--user')));
  assert.match(mac.content, /Connector &amp; Projects/);
  assert.match(mac.content, /RunAtLoad/);
  assert.match(win.content, /InteractiveToken/);
  assert.match(win.content, /LeastPrivilege/);
  const bootstrap = Buffer.from(
    win.content.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1],
    'base64',
  ).toString('utf16le');
  assert.match(bootstrap, /Connector & Data/);
  assert.match(bootstrap, /-WindowStyle Hidden/);
  assert.ok(win.install.every(([cmd]) => cmd === 'schtasks.exe'));
  for (const plan of [linux, mac, win])
    assert.ok(!JSON.stringify(plan).includes('connectorToken'));
  assert.throws(() =>
    connectorServicePlan('linux', { ...opts, script: '/tmp/evil\ncommand' }),
  );
});

async function fixture(t, { oldOpenCode = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ez-home-')),
    store = openStore(dir, randomBytes(32)),
    machineId = randomUUID(),
    calls = [],
    opened = [];
  const cwd =
    process.platform === 'win32'
      ? 'D:\\Work\\local-project'
      : '/home/user/local-project';
  const items = [
    {
      item: {
        id: 'user-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Private local task' }],
      },
    },
    {
      item: {
        id: 'reply-1',
        type: 'agentMessage',
        text: 'Private local answer',
      },
    },
  ];
  const row = {
    id: 'local-thread',
    cwd,
    name: 'Local work',
    modelProvider: 'local_ollama',
    updatedAt: 1700000000,
    status: { type: 'notLoaded' },
  };
  store.save(
    'servers',
    {
      id: machineId,
      name: 'Home Mac mini',
      transport: 'local',
      platform: process.platform,
      status: 'online',
    },
    {},
  );
  const token = randomBytes(32).toString('hex');
  const app = createApp({
    store,
    token,
    publicUrl: 'https://control.example.com',
    engine: {},
    hubOptions: {
      resolveHome: async () => cwd,
      openProcess: async (_m, options) => {
        opened.push(options);
        const stdout = new PassThrough(),
          stderr = new PassThrough(),
          events = new EventEmitter();
        let dead = false;
        const emit = (m) => stdout.write(JSON.stringify(m) + '\n');
        const input = new Writable({
          write(chunk, _e, done) {
            const m = JSON.parse(chunk.toString());
            calls.push(m);
            const respond = (result) =>
              setImmediate(() => emit({ id: m.id, result }));
            if (m.method === 'initialize')
              respond({
                agentCapabilities: {
                  loadSession: true,
                  ...(!oldOpenCode
                    ? { sessionCapabilities: { list: {} } }
                    : {}),
                },
              });
            else if (m.method === 'thread/list')
              respond({
                data: [row, { ...row, id: 'unsafe', cwd: '../invalid' }],
                nextCursor: null,
              });
            else if (m.method === 'thread/read') respond({ thread: row });
            else if (m.method === 'thread/items/list')
              respond({ data: items.slice().reverse(), nextCursor: null });
            else if (m.method === 'account/read')
              respond({ account: null, requiresOpenaiAuth: true });
            else if (m.method === 'thread/resume')
              respond({ thread: { id: m.params.threadId } });
            else if (m.method === 'turn/start') {
              respond({ turn: { id: 'turn' } });
              setImmediate(() =>
                emit({
                  method: 'turn/completed',
                  params: { turn: { status: 'completed' } },
                }),
              );
            } else if (m.method === 'session/list')
              respond({
                sessions: [
                  {
                    sessionId: 'ses_local',
                    title: 'OpenCode local',
                    cwd,
                    updatedAt: '2026-11-04T10:00:00Z',
                  },
                ],
                nextCursor: null,
              });
            else if (m.method === 'session/load') {
              setImmediate(() => {
                for (const role of ['user', 'agent'])
                  emit({
                    method: 'session/update',
                    params: {
                      sessionId: 'ses_local',
                      update: {
                        sessionUpdate: role + '_message_chunk',
                        content: {
                          type: 'text',
                          text: role + ' local history',
                        },
                      },
                    },
                  });
                emit({ id: m.id, result: { sessionId: 'ses_local' } });
              });
            } else if (m.id !== undefined) respond({});
            done();
          },
        });
        return {
          stdout,
          stderr,
          input,
          events,
          close() {
            if (!dead) {
              dead = true;
              events.emit('close', 0);
            }
          },
        };
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const request = (path, method = 'GET', body, auth = token) =>
    fetch(`http://127.0.0.1:${app.server.address().port}/api/hub` + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + auth,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  t.after(async () => {
    app.hub.close();
    await new Promise((r) => app.server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, machineId, request, cwd, calls, opened, row, items };
}
test('panel host is idempotent, explicitly named and public pairing tickets can be cancelled without exposing keys', async (t) => {
  const f = await fixture(t),
    hub = await (await f.request('')).json();
  assert.equal(
    hub.connection.connectorUrl,
    'wss://control.example.com/api/connector',
  );
  assert.ok(hub.host.name);
  const host = await (
    await f.request('/host', 'POST', { name: 'Panel host' })
  ).json();
  assert.equal(host.id, f.machineId);
  assert.equal(
    (await (await f.request('/host', 'POST', {})).json()).id,
    host.id,
  );
  assert.equal((await f.request('/host', 'POST', { name: '' })).status, 400);
  const pair = await (
    await f.request('/pair', 'POST', { name: 'Home server' })
  ).json();
  assert.ok(pair.expiresAt > Date.now());
  assert.ok(pair.pairingId);
  assert.equal(
    (await f.request('/pair/' + pair.pairingId, 'GET', null, 'wrong')).status,
    401,
  );
  const cancelled = await (
    await f.request('/pair/' + pair.pairingId, 'DELETE')
  ).json();
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!JSON.stringify(cancelled).includes(pair.code));
});
test('native CLI and desktop chats import once, encrypt history, synchronize and resume the same local provider and folder', async (t) => {
  const f = await fixture(t);
  const list = await (
    await f.request(
      `/machines/${f.machineId}/agents/codex/native-sessions`,
      'POST',
      {},
    )
  ).json();
  assert.equal(list.sessions.length, 1);
  const input = {
    machineId: f.machineId,
    provider: 'codex',
    nativeId: 'local-thread',
    cwd: f.cwd,
    stopped: true,
  };
  assert.equal(
    (await f.request('/sessions/import', 'POST', { ...input, stopped: false }))
      .status,
    400,
  );
  const result = await f.request('/sessions/import', 'POST', input);
  assert.equal(result.status, 201);
  const s = await result.json();
  assert.ok(s.nativeSource);
  assert.equal(s.accountId, null);
  assert.equal(s.cwd, f.cwd);
  const legacy = f.store.get('settings', s.id);
  legacy.nativeSource = false;
  f.store.save('settings', legacy, legacy.secret);
  const restored = await (
    await f.request('/sessions/import', 'POST', {
      ...input,
      mode: 'workspace-write',
    })
  ).json();
  assert.equal(restored.id, s.id);
  assert.ok(restored.nativeSource);
  assert.equal(restored.mode, 'workspace-write');
  assert.equal(
    (await (await f.request('/sessions/import', 'POST', input)).json()).id,
    s.id,
  );
  let detail = await (await f.request('/sessions/' + s.id)).json();
  assert.deepEqual(
    detail.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.equal(
    f.store.list('settings').find((x) => x.id === s.id).secret,
    undefined,
  );
  f.items.push({
    item: {
      id: 'external-2',
      type: 'agentMessage',
      text: 'More work from desktop',
    },
  });
  await f.request(`/sessions/${s.id}/sync`, 'POST', {});
  detail = await (await f.request('/sessions/' + s.id)).json();
  assert.equal(detail.messages.at(-1).content, 'More work from desktop');
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/message`, 'POST', {
        message: 'Continue from phone',
      })
    ).status,
    202,
  );
  const resume = f.calls.find((c) => c.method === 'thread/resume');
  assert.ok(
    f.calls
      .filter((c) => c.method === 'initialize')
      .every((c) => c.params.capabilities?.experimentalApi),
  );
  assert.equal(resume.params.threadId, 'local-thread');
  assert.equal(resume.params.cwd, f.cwd);
  assert.equal(resume.params.modelProvider, 'local_ollama');
  assert.ok(
    f.opened
      .filter((o) => o.operation === 'agent')
      .every((o) => o.nativeDesktop),
  );
  assert.ok(!f.calls.some((c) => c.method === 'account/login/start'));
  f.row.status = { type: 'active' };
  assert.equal(
    (
      await f.request('/sessions/import', 'POST', {
        ...input,
        nativeId: 'other',
      })
    ).status,
    404,
  );
});
test('OpenCode loads native replay without inference and older agents report the required capability', async (t) => {
  const f = await fixture(t);
  const list = await (
    await f.request(
      `/machines/${f.machineId}/agents/opencode/native-sessions`,
      'POST',
      {},
    )
  ).json();
  assert.equal(list.sessions[0].nativeId, 'ses_local');
  const s = await (
    await f.request('/sessions/import', 'POST', {
      machineId: f.machineId,
      provider: 'opencode',
      nativeId: 'ses_local',
      cwd: f.cwd,
      stopped: true,
    })
  ).json();
  const detail = await (await f.request('/sessions/' + s.id)).json();
  assert.deepEqual(
    detail.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.ok(!f.calls.some((c) => c.method === 'session/prompt'));
  const older = await fixture(t, { oldOpenCode: true });
  assert.equal(
    (
      await older.request(
        `/machines/${older.machineId}/agents/opencode/native-sessions`,
        'POST',
        {},
      )
    ).status,
    409,
  );
});
