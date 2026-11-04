import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { projectPath, processSpec } from '../runner/machine-process.mjs';
import { AgentRpc } from '../runner/agent-rpc.mjs';
import { separateServices } from '../runner/workspace-model.mjs';
import { fakeProfile, fakeAccountBrokers } from './helpers/account-fakes.mjs';
import {
  acpOptions,
  setAcpSelection,
  codexModels,
  createModelCatalog,
} from '../runner/model-catalog.mjs';

function fakeAgent(provider, calls, onClose = () => {}) {
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    events = new EventEmitter();
  const emit = (message) => stdout.write(JSON.stringify(message) + '\n');
  let closed = false;
  let acpModel = 'provider/reasoner',
    acpEffort = 'default';
  const acpState = () => ({
    configOptions: [
      {
        id: 'agent-model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: acpModel,
        options: [
          { value: 'provider/reasoner', name: 'Reasoner' },
          { value: 'provider/plain', name: 'Plain model' },
        ],
      },
      ...(acpModel === 'provider/reasoner'
        ? [
            {
              id: 'thinking',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: acpEffort,
              options: [
                { value: 'default', name: 'Default' },
                { value: 'deep', name: 'Deep reasoning' },
              ],
            },
          ]
        : []),
    ],
  });
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
          respond({ sessionId: 'native-acp', ...acpState() });
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
          respond(acpState());
        } else if (m.method === 'session/set_config_option') {
          if (m.params.configId === 'agent-model') {
            acpModel = m.params.value;
            acpEffort = 'default';
          }
          if (m.params.configId === 'thinking') acpEffort = m.params.value;
          respond(acpState());
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
            data: m.params.cursor
              ? [
                  {
                    id: 'second-model',
                    model: 'plain-model',
                    displayName: 'Plain model',
                    supportedReasoningEfforts: [],
                  },
                ]
              : [
                  {
                    id: 'model-from-agent',
                    model: 'model-from-agent',
                    displayName: 'Available model',
                    isDefault: true,
                    defaultReasoningEffort: 'low',
                    supportedReasoningEfforts: [
                      { reasoningEffort: 'low', description: 'Quick' },
                      { reasoningEffort: 'high', description: 'Deep' },
                    ],
                    token: 'catalog-must-not-leak',
                  },
                  { id: 'internal-hidden-model', hidden: true },
                ],
            nextCursor: m.params.cursor ? null : 'page-2',
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

function fakeVersion(provider, code = 0, errors = '', version = '1.0.0') {
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    events = new EventEmitter();
  setImmediate(() => {
    if (code === 0) stdout.write(provider + ' ' + version + '\n');
    if (errors) stderr.write(errors);
    events.emit('close', code);
  });
  return { stdout, stderr, events, input: new PassThrough(), close() {} };
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ezdeploy-hub-')),
    key = randomBytes(32),
    store = openStore(dir, key),
    token = randomBytes(32).toString('hex'),
    calls = [],
    processes = [],
    profiles = new Map(),
    opened = [];
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
        if (!options.allowAnyMachine) assert.equal(m.id, machineId);
        opened.push({ machineId: m.id, ...opts });
        const p = opts.operation.startsWith('profile-')
          ? fakeProfile({ machineId: m.id, ...opts }, profiles)
          : opts.operation === 'version'
            ? fakeVersion(
                opts.provider,
                0,
                '',
                options.nativeVersion || '1.0.0',
              )
            : fakeAgent(opts.provider, calls);
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
  return {
    store,
    dir,
    request,
    calls,
    processes,
    machineId,
    app,
    base,
    token,
    profiles,
    opened,
  };
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
  const second = await (
    await f.request('/sessions', 'POST', {
      projectId: project.id,
      provider: 'opencode',
    })
  ).json();
  assert.equal(
    (
      await f.request(`/sessions/${second.id}/message`, 'POST', {
        message: 'conflicting write',
      })
    ).status,
    409,
  );
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

test('standalone chats run in the machine home, move to a project on the same machine and survive removing the folder', async (t) => {
  const home =
    process.platform === 'win32' ? 'D:\\Users\\owner' : '/home/owner';
  const folder =
    process.platform === 'win32'
      ? 'D:\\Projects\\workspace'
      : '/home/owner/workspace';
  const f = await fixture(t, { resolveHome: async () => home });
  assert.equal(
    (await f.request('/sessions', 'POST', { provider: 'codex' })).status,
    404,
  );
  const chat = await (
    await f.request('/sessions', 'POST', {
      provider: 'codex',
      machineId: f.machineId,
    })
  ).json();
  assert.equal(chat.projectId, null);
  assert.equal(chat.cwd, home);
  assert.equal(chat.mode, 'read-only');
  await f.request(`/sessions/${chat.id}/message`, 'POST', {
    message: 'Standalone message',
  });
  const read = async () =>
    await (await f.request(`/sessions/${chat.id}`)).json();
  await waitFor(read, (s) => s.status === 'approval');
  assert.equal(
    f.calls.find((c) => c.method === 'thread/start').params.cwd,
    home,
  );
  assert.equal(
    (await f.request(`/sessions/${chat.id}`, 'PATCH', { projectId: null }))
      .status,
    409,
  );
  await f.request(`/sessions/${chat.id}/approval`, 'POST', {
    id: 'permission-1',
    decision: 'accept',
  });
  await waitFor(read, (s) => s.status === 'idle');
  const project = await (
    await f.request('/projects', 'POST', {
      name: 'Workspace',
      machineId: f.machineId,
      path: folder,
    })
  ).json();
  assert.equal(
    (
      await f.request(`/projects/${project.id}`, 'PATCH', {
        name: 'Renamed workspace',
      })
    ).status,
    200,
  );
  const moved = await (
    await f.request(`/sessions/${chat.id}`, 'PATCH', { projectId: project.id })
  ).json();
  assert.equal(moved.projectId, project.id);
  assert.equal(moved.cwd, folder);
  assert.equal(moved.nativeId, 'native-thread');
  assert.equal((await read()).messages[0].content, 'Standalone message');
  await f.request(`/sessions/${chat.id}/message`, 'POST', {
    message: 'Continue in project',
  });
  await waitFor(read, (s) => s.status === 'approval');
  assert.equal(
    f.calls.find((c) => c.method === 'thread/resume').params.cwd,
    folder,
  );
  assert.equal(
    (await f.request(`/projects/${project.id}`, 'DELETE', {})).status,
    409,
  );
  await f.request(`/sessions/${chat.id}/approval`, 'POST', {
    id: 'permission-1',
    decision: 'accept',
  });
  await waitFor(read, (s) => s.status === 'idle');
  const otherMachine = randomUUID();
  f.store.save(
    'servers',
    {
      id: otherMachine,
      name: 'Other',
      platform: process.platform,
      transport: 'local',
    },
    {},
  );
  const other = await (
    await f.request('/projects', 'POST', {
      name: 'Other folder',
      machineId: otherMachine,
      path: folder,
    })
  ).json();
  assert.equal(
    (await f.request(`/sessions/${chat.id}`, 'PATCH', { projectId: other.id }))
      .status,
    409,
  );
  assert.equal((await read()).projectId, project.id);
  assert.equal(
    (await f.request(`/projects/${project.id}`, 'DELETE', {})).status,
    200,
  );
  const detached = await read();
  assert.equal(detached.projectId, null);
  assert.equal(detached.cwd, folder);
  assert.equal(detached.nativeId, 'native-thread');
  assert.ok(detached.messages.some((m) => m.content === 'Continue in project'));
});

test('services remain separate from real working folders; migration retains native chats, encrypted history and deployment data', async (t) => {
  const f = await fixture(t),
    serviceId = randomUUID(),
    importedId = randomUUID(),
    chatId = randomUUID(),
    realFolderId = randomUUID();
  const path =
    process.platform === 'win32' ? 'D:\\Projects\\service' : '/srv/service';
  f.store.save(
    'projects',
    {
      id: serviceId,
      name: 'Production service',
      serverId: f.machineId,
      repo: 'https://github.com/example/service',
      kind: 'web',
      status: 'running',
    },
    { env: 'PRIVATE_SERVICE_KEY=keep' },
  );
  f.store.save(
    'settings',
    {
      id: importedId,
      recordType: 'workspace',
      legacyProjectId: serviceId,
      name: 'Production service',
      machineId: f.machineId,
      path,
    },
    {},
  );
  f.store.save(
    'settings',
    {
      id: realFolderId,
      recordType: 'workspace',
      name: 'Real folder',
      machineId: f.machineId,
      path: path + '-source',
    },
    {},
  );
  f.store.save(
    'settings',
    {
      id: chatId,
      recordType: 'session',
      projectId: importedId,
      machineId: f.machineId,
      provider: 'opencode',
      nativeId: 'existing-acp-native',
      mode: 'workspace-write',
      status: 'idle',
      updatedAt: new Date().toISOString(),
    },
    {
      title: 'Private conversation title',
      messages: [
        { id: 'old-msg', role: 'user', content: 'Private existing message' },
      ],
      approvals: [],
    },
  );
  separateServices(f.store);
  separateServices(f.store);
  const snapshot = await (await f.request('')).json();
  assert.deepEqual(
    snapshot.projects.map((p) => p.id),
    [realFolderId],
  );
  assert.equal(snapshot.services[0].name, 'Production service');
  assert.equal(snapshot.sessions[0].projectId, null);
  assert.equal(snapshot.sessions[0].cwd, path);
  assert.equal(snapshot.sessions[0].nativeId, 'existing-acp-native');
  const chat = await (await f.request(`/sessions/${chatId}`)).json();
  assert.equal(chat.messages[0].content, 'Private existing message');
  assert.equal(chat.title, 'Private conversation title');
  assert.equal(
    f.store.get('projects', serviceId).secret.env,
    'PRIVATE_SERVICE_KEY=keep',
  );
  assert.equal(
    f.store.get('settings', importedId).recordType,
    'service_context',
  );
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_SERVICE_KEY'));
  const row = f.store.db
    .prepare('SELECT data,secret FROM settings WHERE id=?')
    .get(chatId);
  assert.ok(!row.data.includes('Private conversation'));
  assert.ok(!row.secret.includes('Private existing'));
});

test('OpenCode standalone sessions receive a real absolute cwd without requiring a project', async (t) => {
  const home =
    process.platform === 'win32' ? 'D:\\Users\\owner' : '/home/owner';
  const f = await fixture(t, { resolveHome: async () => home });
  const s = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'opencode',
    })
  ).json();
  assert.equal(s.projectId, null);
  assert.equal(s.cwd, home);
  await f.request(`/sessions/${s.id}/message`, 'POST', {
    message: 'Hello without project',
  });
  const read = async () => await (await f.request(`/sessions/${s.id}`)).json();
  await waitFor(read, (s) => s.status === 'approval');
  assert.equal(
    f.calls.find((c) => c.method === 'session/new').params.cwd,
    home,
  );
  await f.request(`/sessions/${s.id}/stop`, 'POST', {});
});

test('a manually named empty chat keeps its name after the first prompt', async (t) => {
  const f = await fixture(t, {
    resolveHome: async () =>
      process.platform === 'win32' ? 'D:\\Users\\owner' : '/home/owner',
  });
  const s = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'codex',
    })
  ).json();
  await f.request(`/sessions/${s.id}`, 'PATCH', { title: 'Название вручную' });
  await f.request(`/sessions/${s.id}/message`, 'POST', {
    message: 'Первое сообщение',
  });
  const read = async () => await (await f.request(`/sessions/${s.id}`)).json();
  const current = await waitFor(read, (s) => s.status === 'approval');
  assert.equal(current.title, 'Название вручную');
  await f.request(`/sessions/${s.id}/stop`, 'POST', {});
});

test('process launch rejects unsupported providers, arbitrary operations and traversal on both platforms', () => {
  assert.throws(() => processSpec('shell', 'agent'));
  assert.throws(() => processSpec('codex', 'rm -rf /'));
  assert.deepEqual(processSpec('codex', 'install', 'win32').args, [
    'install',
    '--global',
    '@openai/codex',
  ]);
  assert.equal(
    processSpec('codex', 'install', 'linux').executable,
    '/bin/bash',
  );
  assert.ok(
    !processSpec('codex', 'install', 'linux').args[1].includes('npm install'),
  );
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

test('live model catalogs paginate, cache, refresh and validate machine context without inference or secrets', async (t) => {
  const f = await fixture(t);
  const path = '/machines/' + f.machineId + '/agents/codex/models';
  const read = async (body = {}) =>
    (await f.request(path, 'POST', body)).json();
  const catalog = await read();
  assert.deepEqual(
    catalog.models.map((m) => m.id),
    ['model-from-agent', 'plain-model'],
  );
  assert.equal(catalog.models[0].reasoning[1].id, 'high');
  assert.equal(catalog.models[0].defaultReasoning, 'low');
  assert.equal(catalog.defaultModelId, 'model-from-agent');
  assert.ok(catalog.updatedAt);
  assert.ok(!JSON.stringify(catalog).includes('catalog-must-not-leak'));
  assert.equal(f.calls.filter((c) => c.method === 'model/list').length, 2);
  await read();
  assert.equal(f.calls.filter((c) => c.method === 'model/list').length, 2);
  await read({ refresh: true });
  assert.equal(f.calls.filter((c) => c.method === 'model/list').length, 4);
  assert.ok(
    !f.calls.some((c) =>
      ['thread/start', 'turn/start', 'session/prompt'].includes(c.method),
    ),
  );
  const alien = randomUUID();
  f.store.save(
    'settings',
    {
      id: alien,
      recordType: 'workspace',
      name: 'Other',
      machineId: randomUUID(),
      path: '/tmp',
    },
    {},
  );
  assert.equal(
    (await f.request(path, 'POST', { projectId: alien })).status,
    400,
  );
});

test('Codex model and reasoning persist, apply to the next turn and reject unsupported or active changes', async (t) => {
  const f = await fixture(t);
  const create = (body) =>
    f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'codex',
      mode: 'read-only',
      ...body,
    });
  assert.equal((await create({ model: 'made-up-model' })).status, 409);
  assert.equal(
    (await create({ model: 'plain-model', reasoning: 'high' })).status,
    409,
  );
  assert.equal((await create({ reasoning: 'high' })).status, 400);
  const s = await (
    await create({ model: 'model-from-agent', reasoning: 'high' })
  ).json();
  assert.equal(s.reasoning, 'high');
  const endpoint = '/sessions/' + s.id;
  await f.request(endpoint + '/message', 'POST', {
    message: 'Test model selection',
  });
  const read = async () => (await f.request(endpoint)).json();
  await waitFor(read, (s) => s.status === 'approval');
  const turn = f.calls.find((c) => c.method === 'turn/start');
  assert.equal(turn.params.model, 'model-from-agent');
  assert.equal(turn.params.effort, 'high');
  assert.equal(
    (await f.request(endpoint, 'PATCH', { model: 'plain-model' })).status,
    409,
  );
  await f.request(endpoint + '/approval', 'POST', {
    id: 'permission-1',
    decision: 'accept',
  });
  await waitFor(read, (s) => s.status === 'idle');
  const changed = await (
    await f.request(endpoint, 'PATCH', { model: 'plain-model' })
  ).json();
  assert.equal(changed.reasoning, '');
  await f.request(endpoint + '/message', 'POST', {
    message: 'Continue with another model',
  });
  await waitFor(read, (s) => s.status === 'approval');
  assert.equal(
    f.calls.filter((c) => c.method === 'turn/start').at(-1).params.model,
    'plain-model',
  );
  assert.equal(
    f.calls.filter((c) => c.method === 'turn/start').at(-1).params.effort,
    null,
  );
  assert.ok(f.calls.some((c) => c.method === 'thread/resume'));
  assert.equal(
    (await read()).messages.filter((m) => m.role === 'user').length,
    2,
  );
});

test('OpenCode models use project config, discover dependent reasoning, reuse probes and apply native config IDs', async (t) => {
  const f = await fixture(t);
  const path = '/machines/' + f.machineId + '/agents/opencode/models';
  const first = await (await f.request(path, 'POST', {})).json();
  assert.deepEqual(
    first.models.map((m) => m.id),
    ['provider/reasoner', 'provider/plain'],
  );
  assert.equal(first.models[0].reasoning[1].id, 'deep');
  const next = await (
    await f.request(path, 'POST', { model: 'provider/plain' })
  ).json();
  assert.deepEqual(
    next.models.find((m) => m.id === 'provider/plain').reasoning,
    [],
  );
  assert.ok(f.calls.some((c) => c.method === 'session/load'));
  assert.equal(f.calls.filter((c) => c.method === 'session/new').length, 1);
  assert.ok(!f.calls.some((c) => c.method === 'session/prompt'));
  const refreshed = await (
    await f.request(path, 'POST', { model: 'removed-model', refresh: true })
  ).json();
  assert.equal(refreshed.models.length, 2);
  const s = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'opencode',
      model: 'provider/reasoner',
      reasoning: 'deep',
    })
  ).json();
  assert.ok(s.id);
  const endpoint = '/sessions/' + s.id;
  await f.request(endpoint + '/message', 'POST', {
    message: 'Native ACP config test',
  });
  await waitFor(
    async () => (await f.request(endpoint)).json(),
    (s) => s.status === 'approval',
  );
  assert.ok(
    f.calls.some(
      (c) =>
        c.method === 'session/set_config_option' &&
        c.params.configId === 'thinking' &&
        c.params.value === 'deep',
    ),
  );
  assert.ok(!f.calls.some((c) => c.method === 'session/set_model'));
  await f.request(endpoint + '/stop', 'POST');
  const detail = await (await f.request(endpoint)).json();
  assert.ok(
    !detail.messages.some((m) => m.content === 'Replay must not be duplicated'),
  );
});

test('ACP legacy catalogs retain set_model fallback; grouped options and current-model-only effort stay capability driven', async () => {
  const state = {
    models: {
      currentModelId: 'old/a',
      availableModels: [
        { modelId: 'old/a', name: 'Old A' },
        { modelId: 'old/b', name: 'Old B' },
      ],
    },
  };
  const runtime = { nativeId: 'old-session', modelState: state };
  const calls = [];
  await setAcpSelection(
    {
      request: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
    runtime,
    'old/b',
  );
  assert.equal(calls[0].method, 'session/set_model');
  await assert.rejects(
    () =>
      setAcpSelection({ request: async () => ({}) }, runtime, 'old/b', 'high'),
    /reasoning/,
  );
  const grouped = acpOptions({
    configOptions: [
      {
        id: 'models',
        category: 'model',
        type: 'select',
        currentValue: 'p/a',
        options: [
          {
            group: 'p',
            name: 'Provider',
            options: [
              { value: 'p/a', name: 'A' },
              { value: 'p/b', name: 'B' },
            ],
          },
        ],
      },
      {
        id: 'depth',
        category: 'thought_level',
        type: 'select',
        currentValue: 'deep',
        options: [{ value: 'deep', name: 'Deep' }],
      },
    ],
  });
  assert.equal(grouped.models[0].group, 'Provider');
  assert.equal(grouped.models[0].reasoning[0].id, 'deep');
  assert.deepEqual(grouped.models[1].reasoning, []);
  await assert.rejects(
    () =>
      codexModels({ request: async () => ({ data: [], nextCursor: 'same' }) }),
    /повторяющуюся/,
  );
});

test('catalog failures can be retried and parallel reads share one probe whose process is closed', async () => {
  let opened = 0,
    closed = 0;
  const calls = [];
  const catalog = createModelCatalog({
    connectors: null,
    isClosed: () => false,
    openProcess: async () => {
      opened++;
      if (opened === 1) throw new Error('Agent requires sign-in');
      await new Promise((r) => setImmediate(r));
      return fakeAgent('codex', calls, () => closed++);
    },
  });
  const machine = { id: 'catalog-machine' };
  try {
    await assert.rejects(
      () => catalog.get(machine, 'codex', '/test'),
      /sign-in/,
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => catalog.get(machine, 'codex', '/test')),
    );
    assert.equal(opened, 2);
    assert.equal(closed, 1);
    assert.ok(results.every((r) => r.models.length === 2));
    await catalog.get(machine, 'codex', '/test', { refresh: true });
    assert.equal(opened, 3);
    assert.equal(closed, 2);
    assert.ok(!calls.some((c) => c.method === 'turn/start'));
  } finally {
    catalog.close();
  }
});

test('installed Codex remains installed when app-server fails, and missing CLI keeps useful diagnostics', async (t) => {
  const broken = await fixture(t, {
    openProcess: async (m, opts) => {
      if (opts.operation === 'version') return fakeVersion(opts.provider);
      throw new Error('app-server failed hidden-ssh-password');
    },
  });
  const status = await (
    await broken.request('/machines/' + broken.machineId + '/agents/codex')
  ).json();
  assert.equal(status.installed, true);
  assert.equal(status.ready, false);
  assert.equal(status.version, 'codex 1.0.0');
  assert.match(status.error, /app-server failed/);
  assert.ok(!status.error.includes('hidden-ssh-password'));
  const absent = await fixture(t, {
    openProcess: async () => fakeVersion('codex', 127, 'codex: not found'),
  });
  const missing = await (
    await absent.request('/machines/' + absent.machineId + '/agents/codex')
  ).json();
  assert.equal(missing.installed, false);
  assert.equal(missing.missing, true);
  assert.match(missing.error, /not found/);
});

test('successful installation clears cached runtimes and models before checking the installed version again', async (t) => {
  const calls = [];
  let starts = 0,
    closed = 0;
  const f = await fixture(t, {
    openProcess: async (m, opts) => {
      if (opts.operation === 'version' || opts.operation === 'install')
        return fakeVersion(opts.provider);
      starts++;
      return fakeAgent(opts.provider, calls, () => closed++);
    },
  });
  const base = '/machines/' + f.machineId + '/agents/codex';
  assert.equal((await (await f.request(base)).json()).ready, true);
  await f.request(base + '/models', 'POST', {});
  assert.equal(starts, 2);
  const install = await (
    await f.request(base + '/install', 'POST', { confirm: true })
  ).json();
  await waitFor(
    async () => (await f.request('/tasks/' + install.id)).json(),
    (x) => x.status === 'success',
  );
  assert.equal(closed, 2);
  await f.request(base + '/models', 'POST', {});
  assert.equal(starts, 3);
  assert.equal((await (await f.request(base)).json()).ready, true);
  assert.equal(starts, 4);
});

test('an installation opening its SSH channel already reserves the machine against duplicate installs', async (t) => {
  let release,
    starting = false;
  const gate = new Promise((r) => {
    release = r;
  });
  const f = await fixture(t, {
    openProcess: async (m, opts) => {
      if (opts.operation === 'install') {
        starting = true;
        await gate;
      }
      return fakeVersion(opts.provider);
    },
  });
  const base = '/machines/' + f.machineId + '/agents/codex/install';
  const first = f.request(base, 'POST', { confirm: true });
  await waitFor(
    async () => starting,
    (x) => x,
  );
  const second = await f.request(base, 'POST', { confirm: true });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 202);
});

test('account vault supports personal and work accounts, encrypts credentials, binds defaults and pins each chat independently', async (t) => {
  const brokers = fakeAccountBrokers(),
    f = await fixture(t, { accountOptions: brokers, allowAnyMachine: true });
  const create = async (name, key) => {
    const r = await f.request('/accounts', 'POST', {
      provider: 'codex',
      name,
      method: 'api',
      apiKey: key,
    });
    assert.equal(r.status, 201);
    return r.json();
  };
  const personal = await create('Personal', 'private-personal-key'),
    work = await create('Work', 'private-work-key');
  assert.equal(personal.status, 'connected');
  assert.equal(work.email, 'work@example.test');
  const row = f.store.db
    .prepare('SELECT data,secret FROM settings WHERE id=?')
    .get(personal.id);
  assert.ok(!row.data.includes('private-personal-key'));
  assert.ok(!row.secret.includes('private-personal-key'));
  assert.equal(
    f.store.get('settings', personal.id).secret.credentials.OPENAI_API_KEY,
    'private-personal-key',
  );
  const secondId = randomUUID();
  f.store.save(
    'servers',
    { ...f.store.list('servers')[0], id: secondId, name: 'Second computer' },
    {},
  );
  const bind = (m, a) =>
    f.request('/machines/' + m + '/agents/codex/account', 'POST', {
      accountId: a,
    });
  assert.equal((await bind(f.machineId, personal.id)).status, 200);
  await bind(secondId, personal.id);
  const make = (m) =>
    f
      .request('/sessions', 'POST', {
        machineId: m,
        provider: 'codex',
        mode: 'read-only',
      })
      .then((r) => r.json());
  const first = await make(f.machineId),
    second = await make(secondId);
  assert.equal(first.accountId, personal.id);
  assert.equal(first.profileId, first.id);
  await bind(f.machineId, work.id);
  const third = await make(f.machineId);
  assert.equal(third.accountId, work.id);
  assert.equal(
    (await (await f.request('/sessions/' + first.id)).json()).accountId,
    personal.id,
  );
  assert.equal(
    (
      await f.request('/sessions/' + first.id + '/message', 'POST', {
        message: 'First account context',
      })
    ).status,
    202,
  );
  const read = async () => (await f.request('/sessions/' + first.id)).json();
  await waitFor(read, (s) => s.status === 'approval');
  assert.ok(
    f.calls.some(
      (c) =>
        c.method === 'account/login/start' &&
        c.params.apiKey === 'private-personal-key',
    ),
  );
  assert.equal(
    (await f.request('/accounts/' + personal.id, 'DELETE', {})).status,
    409,
  );
  await f.request('/sessions/' + first.id + '/approval', 'POST', {
    id: 'permission-1',
    decision: 'accept',
  });
  await waitFor(read, (s) => s.status === 'idle');
  const switched = await (
    await f.request('/sessions/' + first.id, 'PATCH', { accountId: work.id })
  ).json();
  assert.equal(switched.accountId, work.id);
  assert.equal(switched.nativeId, 'native-thread');
  assert.equal(switched.profileId, first.id);
  await f.request('/sessions/' + first.id + '/message', 'POST', {
    message: 'Continue with work account',
  });
  await waitFor(read, (s) => s.status === 'approval');
  assert.ok(f.calls.some((c) => c.method === 'thread/resume'));
  assert.ok(
    f.calls.some(
      (c) =>
        c.method === 'account/login/start' &&
        c.params.apiKey === 'private-work-key',
    ),
  );
  await f.request('/sessions/' + first.id + '/approval', 'POST', {
    id: 'permission-1',
    decision: 'accept',
  });
  await waitFor(read, (s) => s.status === 'idle');
  assert.equal(
    (await read()).messages.filter((m) => m.role === 'user').length,
    2,
  );
  const snapshot = await (await f.request('')).json();
  assert.equal(snapshot.accounts.length, 2);
  assert.ok(!JSON.stringify(snapshot).includes('private-personal-key'));
  const detail = await (await f.request('/accounts/' + personal.id)).json();
  assert.ok(!('secret' in detail));
  assert.equal(
    (await f.request('/accounts/' + personal.id, 'DELETE', {})).status,
    200,
  );
  assert.equal(f.store.get('servers', secondId).agentAccounts.codex, null);
  assert.equal(
    (
      await f.request('/sessions/' + second.id + '/message', 'POST', {
        message: 'Revoked account must not run',
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request('/accounts/' + work.id, 'PATCH', { name: 'Work renamed' }))
      .status,
    200,
  );
});

test('Codex device authorization stays private, supplies access tokens only, and handles refresh without exposing approval requests', async (t) => {
  const brokers = fakeAccountBrokers(),
    f = await fixture(t, { accountOptions: brokers });
  const created = await (
    await f.request('/accounts', 'POST', {
      provider: 'codex',
      name: 'ChatGPT personal',
      method: 'oauth',
    })
  ).json();
  assert.equal(created.status, 'pending');
  assert.equal(created.login.userCode, 'SAFE-CODE');
  const flow = brokers.logins[0];
  flow.onLogin({ success: true });
  const account = await waitFor(
    async () => (await f.request('/accounts/' + created.id)).json(),
    (a) => a.status === 'connected',
  );
  assert.equal(account.email, 'personal@example.test');
  assert.ok(flow.closed);
  const session = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'codex',
      accountId: account.id,
      mode: 'read-only',
    })
  ).json();
  await f.request('/sessions/' + session.id + '/message', 'POST', {
    message: 'Check external authorization',
  });
  const read = async () => (await f.request('/sessions/' + session.id)).json();
  await waitFor(read, (s) => s.status === 'approval');
  const login = f.calls.find(
    (c) =>
      c.method === 'account/login/start' &&
      c.params.type === 'chatgptAuthTokens',
  );
  assert.equal(login.params.chatgptAccountId, 'org-personal');
  assert.ok(login.params.accessToken);
  assert.ok(!JSON.stringify(f.calls).includes('private-refresh-org-personal'));
  assert.ok(
    f.calls.find((c) => c.method === 'initialize').params.capabilities
      .experimentalApi,
  );
  const native = f.processes.find((p) => p.emit && p.input);
  native.emit({
    id: 'refresh-auth',
    method: 'account/chatgptAuthTokens/refresh',
    params: { previousAccountId: 'org-personal' },
  });
  await waitFor(
    async () => f.calls.find((c) => c.id === 'refresh-auth' && !c.method),
    (x) => !!x,
  );
  assert.ok(
    f.calls.find((c) => c.id === 'refresh-auth' && !c.method).result
      .accessToken,
  );
  const beforeRefresh = brokers.refreshes;
  for (const id of ['concurrent-one', 'concurrent-two'])
    native.emit({
      id,
      method: 'account/chatgptAuthTokens/refresh',
      params: { previousAccountId: 'org-personal' },
    });
  await waitFor(
    async () =>
      f.calls.filter(
        (c) => ['concurrent-one', 'concurrent-two'].includes(c.id) && !c.method,
      ).length,
    (n) => n === 2,
  );
  assert.equal(
    brokers.refreshes - beforeRefresh,
    1,
    'concurrent refresh requests must reuse one rotating token refresh',
  );
  native.emit({
    id: 'wrong-account',
    method: 'account/chatgptAuthTokens/refresh',
    params: { previousAccountId: 'org-other' },
  });
  await waitFor(
    async () => f.calls.find((c) => c.id === 'wrong-account' && !c.method),
    (x) => !!x,
  );
  assert.ok(f.calls.find((c) => c.id === 'wrong-account' && !c.method).error);
  assert.equal((await read()).approvals.length, 1);
  assert.ok(
    !JSON.stringify(await read()).includes('private-refresh-org-personal'),
  );
  await f.request('/sessions/' + session.id + '/stop', 'POST');
});

test('OpenCode portable accounts use isolated profiles, preserve native chat history and serialize OAuth token updates', async (t) => {
  const brokers = fakeAccountBrokers(),
    f = await fixture(t, { accountOptions: brokers });
  const result = await (
    await f.request('/accounts', 'POST', {
      provider: 'opencode',
      vendor: 'openai',
      name: 'OpenCode OAuth',
      method: 'device',
    })
  ).json();
  assert.equal(result.status, 'pending');
  brokers.logins.at(-1).complete();
  const account = await waitFor(
    async () => (await f.request('/accounts/' + result.id)).json(),
    (a) => a.status === 'connected',
  );
  const first = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'opencode',
      accountId: account.id,
    })
  ).json();
  const second = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'opencode',
      accountId: account.id,
      mode: 'workspace-write',
    })
  ).json();
  await f.request('/sessions/' + first.id + '/message', 'POST', {
    message: 'Run a safe mocked turn',
  });
  const read = async () => (await f.request('/sessions/' + first.id)).json();
  await waitFor(read, (s) => s.status === 'approval');
  assert.equal(
    f.profiles.get(f.machineId + ':' + first.id).openai.type,
    'oauth',
  );
  const blocked = await f.request(
    '/machines/' + f.machineId + '/agents/opencode/models',
    'POST',
    { sessionId: second.id },
  );
  assert.equal(blocked.status, 409);
  assert.equal(
    (
      await f.request('/accounts/' + account.id + '/login', 'POST', {
        method: 'device',
      })
    ).status,
    409,
  );
  await f.request('/sessions/' + first.id + '/approval', 'POST', {
    id: 'permission-1',
    decision: 'once',
  });
  await waitFor(read, (s) => s.status === 'idle');
  assert.ok(!f.profiles.has(f.machineId + ':' + first.id));
  await f.request('/sessions/' + first.id + '/message', 'POST', {
    message: 'Resume native session',
  });
  await waitFor(read, (s) => s.status === 'approval');
  assert.ok(f.calls.some((c) => c.method === 'session/load'));
  assert.ok(
    f.opened.filter((p) => p.operation === 'agent').every((p) => p.profileId),
  );
  await f.request('/sessions/' + first.id + '/approval', 'POST', {
    id: 'permission-1',
    decision: 'once',
  });
  await waitFor(read, (s) => s.status === 'idle');
  assert.equal(
    (await read()).messages.filter((m) => m.role === 'user').length,
    2,
  );
  assert.ok(!JSON.stringify(await read()).includes('private-refresh'));
  const rows = f.store.list('settings');
  assert.ok(
    rows
      .filter((x) => x.recordType === 'account_target')
      .every((x) => !x.credentialPresent),
  );
});

test('unauthenticated Codex rejects before accepting or persisting the message and returns a durable sign-in explanation', async (t) => {
  const f = await fixture(t, {
    openProcess: async (m, opts) => {
      if (opts.operation === 'version') return fakeVersion('codex');
      const p = fakeAgent('codex', []),
        write = p.input.write.bind(p.input);
      p.input.write = (bytes) => {
        const request = JSON.parse(bytes.toString());
        if (request.method === 'account/read') {
          setImmediate(() =>
            p.emit({
              id: request.id,
              result: { account: null, requiresOpenaiAuth: true },
            }),
          );
          return true;
        }
        return write(bytes);
      };
      return p;
    },
  });
  const s = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'codex',
    })
  ).json();
  const response = await f.request('/sessions/' + s.id + '/message', 'POST', {
    message: 'Keep this draft',
  });
  assert.equal(response.status, 403);
  const detail = await (await f.request('/sessions/' + s.id)).json();
  assert.equal(detail.messages.length, 0);
  assert.match(detail.authError, /авторизац/);
  assert.match(detail.errorMessage, /Настройках/);
});

test('vault validates account/provider context and cancellation cannot leave an authenticated browser payload', async (t) => {
  const brokers = fakeAccountBrokers(),
    f = await fixture(t, { accountOptions: brokers });
  const a = await (
    await f.request('/accounts', 'POST', {
      provider: 'codex',
      name: 'Temporary',
      method: 'oauth',
    })
  ).json();
  assert.equal(
    (await f.request('/accounts', 'GET', null, 'wrong')).status,
    401,
  );
  assert.equal(
    (await f.request('/accounts/' + a.id + '/cancel', 'POST', {})).status,
    200,
  );
  const cancelled = await (await f.request('/accounts/' + a.id)).json();
  assert.equal(cancelled.status, 'disconnected');
  assert.ok(!cancelled.login);
  assert.ok(brokers.logins[0].closed);
  assert.equal(
    (
      await f.request('/sessions', 'POST', {
        machineId: f.machineId,
        provider: 'codex',
        accountId: a.id,
      })
    ).status,
    403,
  );
  const key = await (
    await f.request('/accounts', 'POST', {
      provider: 'codex',
      name: 'Work',
      method: 'api',
      apiKey: 'private-work-api-key',
    })
  ).json();
  assert.equal(
    (
      await f.request(
        '/machines/' + f.machineId + '/agents/opencode/account',
        'POST',
        { accountId: key.id },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/sessions', 'POST', {
        machineId: f.machineId,
        provider: 'opencode',
        accountId: key.id,
      })
    ).status,
    400,
  );
});

test('OpenCode v-prefixed native versions transfer and revoke exact native credentials without interactive pickers', async (t) => {
  const f = await fixture(t, {
    accountOptions: fakeAccountBrokers(),
    nativeVersion: 'v2.0.29',
  });
  const a = await (
    await f.request('/accounts', 'POST', {
      provider: 'opencode',
      vendor: 'openai',
      name: 'Work',
      method: 'key',
      apiKey: 'private-v2-test-key',
    })
  ).json();
  const r = await f.request(
    `/machines/${f.machineId}/agents/opencode/models`,
    'POST',
    { accountId: a.id },
  );
  assert.equal(r.status, 200);
  assert.ok((await r.json()).models.length);
  const transfers = f.opened.filter((o) => o.operation.startsWith('profile-'));
  assert.ok(transfers.every((o) => o.profileFormat === 'opencode-v2'));
  const cleared = transfers.find((o) => o.operation === 'profile-clear');
  assert.match(cleared.profileCredential, /^cred_test/);
  assert.equal(cleared.profileVendor, 'openai');
  assert.equal(f.profiles.size, 0);
  assert.ok(
    f.store
      .list('settings')
      .filter((r) => r.recordType === 'account_target')
      .every((r) => !r.credentialPresent),
  );
});

test('cancelling an OAuth flow while its final read is pending cannot reconnect the account', async (t) => {
  const brokers = fakeAccountBrokers();
  let completeRead,
    reading = false;
  const f = await fixture(t, {
    accountOptions: {
      ...brokers,
      codexLogin: async (...args) => {
        const broker = await brokers.codexLogin(...args),
          read = broker.read;
        broker.read = async () => {
          reading = true;
          await new Promise((r) => {
            completeRead = r;
          });
          return read();
        };
        return broker;
      },
    },
  });
  const a = await (
    await f.request('/accounts', 'POST', {
      provider: 'codex',
      name: 'Cancelled',
      method: 'oauth',
    })
  ).json();
  brokers.logins[0].onLogin({ success: true });
  await waitFor(
    async () => reading,
    (x) => x,
  );
  assert.equal(
    (await f.request(`/accounts/${a.id}/cancel`, 'POST', {})).status,
    200,
  );
  completeRead();
  await new Promise((r) => setImmediate(r));
  const state = await (await f.request(`/accounts/${a.id}`)).json();
  assert.equal(state.status, 'disconnected');
  assert.ok(!f.store.get('settings', a.id).secret.credentials);
});

test('OpenCode recovers rotated credentials after interruption and discards copies from a previous login', async (t) => {
  const brokers = fakeAccountBrokers(),
    f = await fixture(t, { accountOptions: brokers });
  const result = await (
    await f.request('/accounts', 'POST', {
      provider: 'opencode',
      vendor: 'openai',
      name: 'Portable',
      method: 'device',
    })
  ).json();
  brokers.logins.at(-1).complete();
  await waitFor(
    async () => (await f.request(`/accounts/${result.id}`)).json(),
    (a) => a.status === 'connected',
  );
  async function abandoned(refresh, generation) {
    const a = f.store.get('settings', result.id),
      profileId = randomUUID();
    const credentials = { ...a.secret.credentials.legacy.openai, refresh };
    f.profiles.set(`${f.machineId}:${profileId}`, { openai: credentials });
    f.store.save(
      'settings',
      {
        id: `account-target:${f.machineId}:opencode:${profileId}`,
        recordType: 'account_target',
        machineId: f.machineId,
        profileId,
        accountId: a.id,
        provider: 'opencode',
        vendor: 'openai',
        format: 'opencode-v1',
        credentialPresent: true,
        authGeneration: generation,
      },
      {},
    );
    return profileId;
  }
  const dirty = await abandoned('rotated-after-crash', 1);
  assert.equal(
    (
      await f.request(
        `/machines/${f.machineId}/agents/opencode/models`,
        'POST',
        { accountId: result.id },
      )
    ).status,
    200,
  );
  assert.equal(
    f.store.get('settings', result.id).secret.credentials.legacy.openai.refresh,
    'rotated-after-crash',
  );
  assert.ok(!f.profiles.has(`${f.machineId}:${dirty}`));
  const a = f.store.get('settings', result.id);
  a.authGeneration = 2;
  f.store.save('settings', a, a.secret);
  const stale = await abandoned('old-invalidated-login', 1);
  assert.equal(
    (
      await f.request(
        `/machines/${f.machineId}/agents/opencode/models`,
        'POST',
        { accountId: result.id, refresh: true },
      )
    ).status,
    200,
  );
  assert.equal(
    f.store.get('settings', result.id).secret.credentials.legacy.openai.refresh,
    'rotated-after-crash',
  );
  assert.ok(!f.profiles.has(`${f.machineId}:${stale}`));
});

test('failed OpenCode authentication releases its OAuth lease and allows a fresh sign-in', async (t) => {
  const brokers = fakeAccountBrokers(),
    profiles = new Map();
  const f = await fixture(t, {
    accountOptions: brokers,
    openProcess: async (m, opts) => {
      if (opts.operation.startsWith('profile-'))
        return fakeProfile({ machineId: m.id, ...opts }, profiles);
      if (opts.operation === 'version') return fakeVersion(opts.provider);
      const p = fakeAgent(opts.provider, []),
        write = p.input.write.bind(p.input);
      p.input.write = (bytes) => {
        const message = JSON.parse(bytes.toString());
        if (message.method === 'session/prompt') {
          setImmediate(() =>
            p.emit({
              id: message.id,
              error: { message: '401 authentication rejected' },
            }),
          );
          return true;
        }
        return write(bytes);
      };
      return p;
    },
  });
  const a = await (
    await f.request('/accounts', 'POST', {
      provider: 'opencode',
      vendor: 'openai',
      name: 'Reconnect',
      method: 'device',
    })
  ).json();
  brokers.logins.at(-1).complete();
  await waitFor(
    async () => (await f.request(`/accounts/${a.id}`)).json(),
    (x) => x.status === 'connected',
  );
  const s = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'opencode',
      accountId: a.id,
    })
  ).json();
  assert.equal(
    (
      await f.request(`/sessions/${s.id}/message`, 'POST', {
        message: 'Fail safely',
      })
    ).status,
    202,
  );
  const detail = await waitFor(
    async () => (await f.request(`/sessions/${s.id}`)).json(),
    (x) => x.status === 'error',
  );
  assert.match(detail.authError, /авторизац/);
  assert.equal(profiles.size, 0);
  assert.equal(
    (await f.request(`/accounts/${a.id}/login`, 'POST', { method: 'device' }))
      .status,
    200,
  );
});

test('stopping during agent initialization preserves the draft and never starts a model turn', async (t) => {
  let initialized, finish;
  const calls = [];
  const f = await fixture(t, {
    openProcess: async (_m, opts) => {
      const p = fakeAgent(opts.provider, calls),
        write = p.input.write.bind(p.input);
      p.input.write = (bytes) => {
        const m = JSON.parse(bytes.toString());
        if (m.method === 'initialize') {
          initialized = true;
          finish = () => write(bytes);
          return true;
        }
        return write(bytes);
      };
      return p;
    },
  });
  const s = await (
    await f.request('/sessions', 'POST', {
      machineId: f.machineId,
      provider: 'codex',
    })
  ).json();
  const sending = f.request(`/sessions/${s.id}/message`, 'POST', {
    message: 'Keep cancelled draft',
  });
  await waitFor(
    async () => initialized,
    (x) => x,
  );
  await f.request(`/sessions/${s.id}/stop`, 'POST', {});
  finish();
  assert.equal((await sending).status, 409);
  const detail = await (await f.request(`/sessions/${s.id}`)).json();
  assert.equal(detail.status, 'interrupted');
  assert.equal(detail.messages.length, 0);
  assert.ok(!calls.some((c) => c.method === 'turn/start'));
});
