import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { projectPath, processSpec } from '../runner/machine-process.mjs';
import { AgentRpc } from '../runner/agent-rpc.mjs';

function fakeAgent(provider, calls, onClose = () => {}) {
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    events = new EventEmitter();
  const emit = (message) => stdout.write(JSON.stringify(message) + '\n');
  let closed = false;
  const input = new Writable({
    write(bytes, _encoding, callback) {
      for (const line of bytes.toString().trim().split('\n')) {
        const m = JSON.parse(line);
        calls.push(m);
        if (!m.method) {
          if (m.id === 'permission-1') {
            if (provider === 'codex') {
              emit({
                method: 'item/agentMessage/delta',
                params: { itemId: 'reply', delta: 'Секретный ответ агента' },
              });
              emit({
                method: 'turn/completed',
                params: { turn: { status: 'completed' } },
              });
            } else {
              emit({
                method: 'session/update',
                params: {
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Ответ OpenCode' },
                  },
                },
              });
              emit({
                id: input._pendingPrompt,
                result: { stopReason: 'end_turn' },
              });
            }
          }
          continue;
        }
        const respond = (result) =>
          setImmediate(() => emit({ id: m.id, result }));
        if (m.method === 'initialize')
          respond({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          });
        else if (m.method === 'thread/start' || m.method === 'thread/resume')
          respond({ thread: { id: 'native-thread' } });
        else if (m.method === 'session/new')
          respond({ sessionId: 'native-acp' });
        else if (m.method === 'session/load') {
          emit({
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Replay must not be duplicated',
                },
              },
            },
          });
          respond({});
        } else if (m.method === 'turn/start') {
          respond({ turn: { id: 'turn-1' } });
          setImmediate(() =>
            emit({
              id: 'permission-1',
              method: 'item/commandExecution/requestApproval',
              params: {
                command: 'git status',
                threadId: 'native-thread',
                turnId: 'turn-1',
              },
            }),
          );
        } else if (m.method === 'session/prompt') {
          // Delay the prompt response until the permission decision.
          input._pendingPrompt = m.id;
          setImmediate(() =>
            emit({
              id: 'permission-1',
              method: 'session/request_permission',
              params: {
                toolCall: { title: 'git status' },
                options: [
                  { optionId: 'once', kind: 'allow_once', name: 'Разрешить' },
                  { optionId: 'always', kind: 'allow_always', name: 'Всегда' },
                  { optionId: 'no', kind: 'reject_once', name: 'Отклонить' },
                ],
              },
            }),
          );
        } else if (m.method === 'turn/interrupt') {
          respond({});
          emit({
            method: 'turn/completed',
            params: { turn: { status: 'interrupted' } },
          });
        } else if (m.method === 'account/read')
          respond({
            account: {
              type: 'chatgpt',
              email: 'owner@example.test',
              planType: 'plus',
              accessToken: 'must-not-leak',
            },
          });
        else if (m.method === 'model/list')
          respond({
            data: [{ id: 'model-from-agent', displayName: 'Available model' }],
          });
        else if (m.method === 'account/login/start')
          respond({
            type: 'chatgptDeviceCode',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'TEST-CODE',
          });
        else if (m.id !== undefined) respond({});
      }
      callback();
    },
  });
  return {
    input,
    stdout,
    stderr,
    events,
    emit,
    close() {
      if (closed) return;
      closed = true;
      onClose();
      events.emit('close', 0);
    },
  };
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ezdeploy-hub-')),
    key = randomBytes(32),
    store = openStore(dir, key),
    token = randomBytes(32).toString('hex'),
    calls = [],
    processes = [];
  const machineId = randomUUID();
  store.save(
    'servers',
    {
      id: machineId,
      name: 'Home',
      transport: 'local',
      platform: process.platform,
      host: '127.0.0.1',
      port: 0,
      username: 'developer',
      status: 'online',
      cpu: 0,
      memory: 10,
      disk: 20,
      specs: 'test',
    },
    { password: 'hidden-ssh-password' },
  );
  const app = createApp({
    store,
    token,
    origins: ['http://localhost:3000'],
    engine: {},
    legacyApi: options.legacyApi ?? false,
    hubOptions: {
      openProcess: async (m, opts) => {
        assert.equal(m.id, machineId);
        const p = fakeAgent(opts.provider, calls);
        processes.push(p);
        return p;
      },
      ...options,
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, method = 'GET', body, auth = token) =>
    fetch(base + '/api/hub' + path, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
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
  return { store, dir, request, calls, processes, machineId, app, base, token };
}
async function waitFor(read, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}

test('hub authenticates, pins session context and encrypts conversations; Codex approvals unblock exactly one action', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('', 'GET', null, 'wrong')).status, 401);
  const path =
    process.platform === 'win32'
      ? 'D:\\Projects\\hello'
      : '/home/developer/hello';
  const project = await (
    await f.request('/projects', 'POST', {
      name: 'My app',
      machineId: f.machineId,
      path,
    })
  ).json();
  assert.ok(project.id);
  assert.equal(
    (
      await f.request('/projects', 'POST', {
        name: 'Again',
        machineId: f.machineId,
        path,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request('/projects', 'POST', {
        name: 'Bad',
        machineId: f.machineId,
        path: '../../etc',
      })
    ).status,
    400,
  );
  const s = await (
    await f.request('/sessions', 'POST', {
      projectId: project.id,
      provider: 'codex',
      mode: 'read-only',
    })
  ).json();
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/message`, 'POST', {
        message: 'Private task text',
      })
    ).status,
    202,
  );
  const read = async () => await (await f.request(`/sessions/${s.id}`)).json();
  const waiting = await waitFor(read, (s) => s.status === 'approval');
  assert.equal(waiting.approvals[0].params.command, 'git status');
  assert.equal(
    f.calls.find((c) => c.method === 'thread/start').params.cwd,
    path,
  );
  assert.equal(
    f.calls.find((c) => c.method === 'thread/start').params.sandbox,
    'read-only',
  );
  assert.equal(
    f.calls.find((c) => c.method === 'thread/start').params.approvalPolicy,
    'on-request',
  );
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/message`, 'POST', {
        message: 'overlap',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/approval`, 'POST', {
        id: 'permission-1',
        decision: 'acceptForSession',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/approval`, 'POST', {
        id: 'permission-1',
        decision: 'accept',
      })
    ).status,
    200,
  );
  const finished = await waitFor(read, (s) => s.status === 'idle');
  assert.equal(finished.messages.at(-1).content, 'Секретный ответ агента');
  assert.equal(finished.approvals.length, 0);
  const snap = await (await f.request('')).json();
  assert.equal(snap.sessions[0].nativeId, 'native-thread');
  assert.ok(!JSON.stringify(snap).includes('Секретный ответ агента'));
  assert.ok(!Object.hasOwn(snap.sessions[0], 'messages'));
  assert.ok(!JSON.stringify(snap).includes('hidden-ssh-password'));
  const raw = f.store.db
    .prepare('SELECT data,secret FROM settings WHERE id=?')
    .get(s.id);
  assert.ok(!raw.data.includes('Private task text'));
  assert.ok(!raw.secret.includes('Private task text'));
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/approval`, 'POST', {
        id: 'permission-1',
        decision: 'accept',
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request(`/sessions/${s.id}`, 'PATCH', { archived: true })).status,
    200,
  );
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/message`, 'POST', {
        message: 'archived',
      })
    ).status,
    409,
  );
});

test('Codex account API supports device login without exposing agent tokens; installation needs explicit action', async (t) => {
  const f = await fixture(t);
  const status = await (
    await f.request(`/machines/${f.machineId}/agents/codex`)
  ).json();
  assert.equal(status.account.email, 'owner@example.test');
  assert.ok(!JSON.stringify(status).includes('must-not-leak'));
  assert.equal(status.models[0].id, 'model-from-agent');
  const login = await (
    await f.request(`/machines/${f.machineId}/agents/codex/login`, 'POST', {})
  ).json();
  assert.equal(login.userCode, 'TEST-CODE');
  assert.equal(
    f.calls.find((c) => c.method === 'account/login/start').params.type,
    'chatgptDeviceCode',
  );
  assert.equal(
    (
      await f.request(
        `/machines/${f.machineId}/agents/codex/install`,
        'POST',
        {},
      )
    ).status,
    400,
  );
  const password = await (
    await f.request(`/machines/${f.machineId}/credentials`, 'POST', {
      reveal: true,
    })
  ).json();
  assert.equal(password.password, 'hidden-ssh-password');
  assert.equal(
    (await f.request(`/machines/${f.machineId}/credentials`, 'POST', {}))
      .status,
    400,
  );
});

test('OpenCode ACP requires per-action permission, rejects permanent grants and can be stopped', async (t) => {
  const f = await fixture(t);
  const project = await (
    await f.request('/projects', 'POST', {
      name: 'ACP',
      machineId: f.machineId,
      path: process.platform === 'win32' ? 'D:\\test' : '/test',
    })
  ).json();
  const s = await (
    await f.request('/sessions', 'POST', {
      projectId: project.id,
      provider: 'opencode',
    })
  ).json();
  assert.equal(
    (await f.request(`/sessions/${s.id}/message`, 'POST', { message: 'test' }))
      .status,
    202,
  );
  const read = async () => await (await f.request(`/sessions/${s.id}`)).json();
  const waiting = await waitFor(read, (s) => s.status === 'approval');
  assert.equal(waiting.nativeId, 'native-acp');
  const second = await (await f.request('/sessions', 'POST', { projectId: project.id, provider: 'opencode' })).json();
  assert.equal((await f.request(`/sessions/${second.id}/message`, 'POST', { message: 'conflicting write' })).status, 409);
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/approval`, 'POST', {
        id: 'permission-1',
        decision: 'always',
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request(`/sessions/${s.id}/stop`, 'POST', {})).status,
    200,
  );
  const stopped = await read();
  assert.equal(stopped.status, 'interrupted');
  assert.deepEqual(stopped.approvals, []);
  assert.ok(f.calls.some((c) => c.method === 'session/cancel'));
  await f.request(`/sessions/${second.id}/message`, 'POST', {
    message: 'second',
  });
  const readSecond = async () =>
    await (await f.request(`/sessions/${second.id}`)).json();
  await waitFor(readSecond, (s) => s.status === 'approval');
  assert.equal(
    (
      await f.request(`/sessions/${second.id}/approval`, 'POST', {
        id: 'permission-1',
        decision: 'once',
      })
    ).status,
    200,
  );
  const complete = await waitFor(readSecond, (s) => s.status === 'idle');
  assert.equal(complete.messages.at(-1).content, 'Ответ OpenCode');
});

test('workspace mode disables legacy root deployment and LLM endpoints', async (t) => {
  const f = await fixture(t, { legacyApi: false });
  for (const path of [
    '/projects',
    '/llm/settings',
    '/servers/00000000-0000-0000-0000-000000000000/provision',
  ]) {
    const response = await fetch(f.base + '/api' + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${f.token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 410);
  }
  assert.equal((await f.request('')).status, 200);
});

test('process launch rejects unsupported providers, arbitrary operations and traversal on both platforms', () => {
  assert.throws(() => processSpec('shell', 'agent'));
  assert.throws(() => processSpec('codex', 'rm -rf /'));
  assert.deepEqual(processSpec('codex', 'install').args, [
    'install',
    '--global',
    '@openai/codex',
  ]);
  assert.throws(() => projectPath('/project/../etc'));
  assert.throws(() => projectPath('C:\\project\\..\\Windows', 'win32'));
  assert.throws(() => projectPath('/tmp/hello\nworld'));
  assert.equal(
    projectPath('D:\\Projects\\hello', 'win32'),
    'D:\\Projects\\hello',
  );
});

test('RPC streams fragmented lines, handles timeouts and rejects pending work when transport closes', async () => {
  const p = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    input: new PassThrough(),
    events: new EventEmitter(),
    close() {},
  };
  const rpc = new AgentRpc(p, { timeout: 30 });
  const request = rpc.request('hello');
  p.stdout.write('{"id":1,"res');
  p.stdout.write('ult":{"ok":true}}\n');
  assert.deepEqual(await request, { ok: true });
  await assert.rejects(rpc.request('timeout'), /не ответил/);
  const pending = rpc.request('later');
  rpc.close();
  await assert.rejects(pending, /отключён/);
});
