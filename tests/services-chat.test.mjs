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
import {
  serviceChatCommand,
  serviceChatDefaultRequest,
  serviceChatInput,
  serviceChatRequest,
  splitServiceChatCommand,
  suggestsServiceChatCommand,
  visibleServiceChatInput,
} from '../lib/service-chat.mjs';

const web = { type: 'compose', stack: 'intranet', component: 'web' };
const api = { type: 'compose', stack: 'intranet', component: 'api' };
const tracker = { type: 'compose', stack: 'tasks', component: 'app' };
const repo = 'https://github.com/example/intranet';
const format = (services) =>
  'Подготовил карточки.\n\n```mayplane-services\n' +
  JSON.stringify({ services }) +
  '\n```';

function fakeAgent(reply, messages, factoryState) {
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const events = new EventEmitter();
  const emit = (message) => {
    if (!closed) stdout.write(JSON.stringify(message) + '\n');
  };
  const id = 'native-chat';
  let closed = false;
  const input = new Writable({
    write(bytes, _encoding, next) {
      const message = JSON.parse(bytes.toString());
      messages.push(message);
      queueMicrotask(async () => {
        const respond = (result) => emit({ id: message.id, result });
        if (message.method === 'initialize')
          respond({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          });
        if (message.method === 'account/read')
          respond({ requiresOpenaiAuth: false });
        if (['thread/start', 'thread/resume'].includes(message.method))
          respond({ thread: { id } });
        if (['session/new', 'session/load'].includes(message.method))
          respond({ sessionId: id });
        if (message.method === 'turn/interrupt') respond({});
        if (message.method === 'turn/start') {
          const turnId = 'turn-' + ++factoryState.turns;
          const text = await reply();
          respond({ turn: { id: turnId } });
          emit({
            method: 'turn/started',
            params: { threadId: id, turn: { id: turnId } },
          });
          emit({
            method: 'item/completed',
            params: {
              threadId: id,
              turnId,
              item: { id: turnId + '-answer', type: 'agentMessage', text },
            },
          });
          emit({
            method: 'turn/completed',
            params: { threadId: id, turn: { id: turnId, status: 'completed' } },
          });
        }
        if (message.method === 'session/prompt') {
          const text = await reply();
          for (const content of [text.slice(0, 20), text.slice(20)]) {
            emit({
              method: 'session/update',
              params: {
                sessionId: id,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: content },
                },
              },
            });
          }
          respond({ stopReason: 'end_turn' });
        }
      });
      next();
    },
  });
  return {
    input,
    stdout,
    stderr,
    events,
    close() {
      closed = true;
      events.emit('close');
    },
  };
}

function fixture(t, provider = 'opencode') {
  const directory = mkdtempSync(join(tmpdir(), 'mayplane-service-chat-'));
  const store = openStore(directory, randomBytes(32));
  const machineId = randomUUID(),
    projectId = randomUUID(),
    dev = randomUUID();
  const messages = [],
    calls = [],
    replies = [];
  const state = { turns: 0 };
  const listed = [web, api, tracker].map((source, i) => ({
    ...source,
    id: String(i + 1).repeat(64),
    name: source.stack + '-' + source.component,
  }));
  store.save(
    'servers',
    { id: machineId, name: 'Test VPS', transport: 'ssh', platform: 'linux' },
    {},
  );
  store.save(
    'servers',
    { id: dev, name: 'Development', transport: 'connector', platform: 'linux' },
    {},
  );
  store.save(
    'settings',
    {
      id: projectId,
      recordType: 'workspace',
      machineId: dev,
      name: 'Intranet',
      path: '/projects/intranet',
      repo: repo + '.git',
    },
    {},
  );
  const hub = createHub(new EventEmitter(), store, {
    resolveHome: async () => '/home/owner',
    openProcess: async (machine, options) => {
      assert.equal(machine.id, machineId);
      assert.equal(options.provider, provider);
      return fakeAgent(
        () => {
          assert(replies.length, 'Unexpected agent turn');
          return replies.shift();
        },
        messages,
        state,
      );
    },
    serviceOptions: {
      withMachine: async (machine, work) => {
        assert.equal(machine.id, machineId);
        return work(async (file, args) => {
          calls.push([file, ...args]);
          assert.equal(file, 'docker');
          const selected = listed.filter((entry) => args.includes(entry.id));
          if (args[0] === 'ps')
            return listed.map((entry) => JSON.stringify(entry)).join('\n');
          if (args[0] === 'inspect')
            return selected
              .map((entry) =>
                JSON.stringify({
                  id: entry.id,
                  image: entry.name,
                  state: 'running',
                  started: '2026-10-01T11:00:00Z',
                  restarts: 0,
                }),
              )
              .join('\n');
          if (args[0] === 'stats')
            return selected
              .map((entry) =>
                JSON.stringify({
                  id: entry.id,
                  cpu: '5.00%',
                  memory: '3MiB / 1GiB',
                }),
              )
              .join('\n');
          if (args[0] === 'logs')
            return '2026-10-01T11:00:00Z ' + selected[0].name;
          assert.fail('Unexpected Docker command');
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
    let reply;
    try {
      assert(
        await hub.handle(
          '/api/hub' + path,
          method,
          body,
          (data, status = 200) => {
            reply = { data, status };
          },
        ),
      );
    } catch (error) {
      if (!error.status) throw error;
      return { data: { error: error.message }, status: error.status };
    }
    return reply;
  }
  return { machineId, projectId, provider, messages, calls, replies, request };
}

async function waitFor(read, condition) {
  for (let i = 0; i < 100; i++) {
    const { data } = await read();
    if (condition(data)) return data;
    await pause(10);
  }
  assert.fail('Expected state was not reached');
}

async function chat(f) {
  const { data, status } = await f.request('/sessions', 'POST', {
    machineId: f.machineId,
    provider: f.provider,
  });
  assert.equal(status, 201);
  return '/sessions/' + data.id;
}

async function turn(f, path, message, reply) {
  f.replies.push(reply);
  const result = await f.request(path + '/message', 'POST', { message });
  assert.equal(result.status, 202, result.data.error);
  return waitFor(
    () => f.request(path),
    (detail) => detail.status === 'idle',
  );
}

test('OpenCode chat asks for a repository, then drafts two services and follows each component after saving', async (t) => {
  const f = fixture(t);
  const path = await chat(f);
  await turn(
    f,
    path,
    'Посмотри, что работает.',
    'Найдены сайт, API и тасктрекер.',
  );
  assert.equal(
    (await f.request(path + '/service-drafts', 'PATCH', { active: true }))
      .status,
    200,
  );
  const question = await turn(
    f,
    path,
    'Оформи как два сервиса.',
    'Пришлите ссылку на репозиторий мессенджера.',
  );
  assert.equal(question.serviceDrafting, true);
  assert.deepEqual(question.serviceBatches, []);
  const ready = await turn(
    f,
    path,
    'Репозиторий находится здесь ' + repo,
    format([
      {
        name: 'Мессенджер',
        repo,
        directory: '/srv/intranet',
        sources: [web, api],
        notes: 'Сайт и API',
        machineId: 'wrong',
        healthUrl: 'http://127.0.0.1:50',
      },
      { name: 'Тасктрекер', sources: [tracker] },
    ]),
  );
  assert.equal((await f.request()).data.services.length, 0);
  const [batch] = ready.serviceBatches;
  assert.equal(batch.cards.length, 2);
  assert.equal(batch.cards[0].fields.machineId, f.machineId);
  assert.equal(batch.cards[0].fields.healthUrl, '');
  assert.equal(batch.cards[0].fields.projectId, f.projectId);
  assert.deepEqual(batch.cards[0].fields.additionalSources, [api]);
  const wire = f.messages.filter(
    (message) => message.method === 'session/prompt',
  );
  assert.equal(wire[0].params.prompt[0].text, 'Посмотри, что работает.');
  assert.match(wire[1].params.prompt[0].text, /MAYPLANE_SERVICE_CHAT/);
  assert(wire[2].params.prompt[0].text.endsWith(repo));
  assert(wire.every((call) => call.params.sessionId === 'native-chat'));
  assert(
    ready.messages.every(
      (message) => !message.content.includes('```mayplane-services'),
    ),
  );

  const save = path + '/service-drafts/' + batch.id + '/save';
  const ids = batch.cards.map((card) => card.id);
  assert.equal(
    (await f.request(save, 'POST', { ids: ['invalid'] })).status,
    404,
  );
  const first = await f.request(save, 'POST', { ids: [ids[0]] });
  assert.equal(first.status, 200, first.data.error);
  assert.equal((await f.request(path)).data.serviceDrafting, true);
  const again = await f.request(save, 'POST', { ids: [ids[0]] });
  assert.deepEqual(first, again);
  const second = await f.request(save, 'POST', { ids: [ids[1]] });
  assert.equal(second.status, 200);
  assert.equal((await f.request(path)).data.serviceDrafting, false);
  const servicePath = '/services/' + first.data.results[0].serviceId;
  const service = await waitFor(
    () => f.request(servicePath),
    (data) => data.status === 'running',
  );
  assert.deepEqual(
    service.components.map((entry) => entry.source),
    [web, api],
  );
  assert.equal(service.cpuCores, 0.1);
  assert.equal(
    (await f.request(servicePath + '/logs/0')).data.lines[0].text,
    'intranet-web',
  );
  assert.equal(
    (await f.request(servicePath + '/logs/1')).data.lines[0].text,
    'intranet-api',
  );
  assert.equal((await f.request(servicePath + '/logs/2')).status, 409);
  assert.equal((await f.request()).data.services.length, 2);
  await turn(f, path, 'Спасибо', 'Пожалуйста!');
  assert.equal(
    f.messages.filter((message) => message.method === 'session/prompt').at(-1)
      .params.prompt[0].text,
    'Спасибо',
  );
});

test('Codex slash command persists across follow-ups and prevents saving a superseded proposal', async (t) => {
  const f = fixture(t, 'codex');
  const path = await chat(f);
  const first = await turn(
    f,
    path,
    '/services Оформи приложение',
    format([{ name: 'Первое название' }]),
  );
  const latest = await turn(
    f,
    path,
    'Назови «Интранет».',
    format([{ name: 'Интранет' }]),
  );
  assert.equal(
    first.messages.find((message) => message.role === 'user').content,
    'Оформи приложение',
  );
  assert.equal(
    first.messages.find((message) => message.role === 'user').command,
    serviceChatCommand,
  );
  assert.equal(latest.serviceBatches[0].replaced, true);
  const save = (batch) =>
    f.request(path + '/service-drafts/' + batch.id + '/save', 'POST', {
      ids: batch.cards.map((card) => card.id),
    });
  assert.equal((await save(latest.serviceBatches[0])).status, 409);
  assert.equal((await save(latest.serviceBatches[1])).status, 200);
  assert.equal((await f.request()).data.services[0].name, 'Интранет');
});

test('slash completion distinguishes a partial prefix, an attached command and ordinary text', () => {
  for (const input of ['/', '/s', '  /SERVICES'])
    assert(suggestsServiceChatCommand(input));
  for (const input of [
    'текст /services',
    '/services/other',
    '/services Оформи',
  ])
    assert(!suggestsServiceChatCommand(input));
  assert.equal(splitServiceChatCommand('/services').separated, false);
  assert.deepEqual(splitServiceChatCommand('/services '), {
    content: '',
    separated: true,
  });
  assert.deepEqual(splitServiceChatCommand('  /SERVICES\nСайт и API'), {
    content: 'Сайт и API',
    separated: true,
  });
  assert.equal(serviceChatRequest('/services '), serviceChatDefaultRequest);
  assert.equal(serviceChatRequest('/services/other'), null);
  assert.deepEqual(
    visibleServiceChatInput(
      serviceChatInput('Инструкция', 'Просьба', serviceChatCommand),
    ),
    {
      content: 'Просьба',
      command: serviceChatCommand,
    },
  );
  assert.deepEqual(
    visibleServiceChatInput(serviceChatInput('Инструкция', 'Уточнение')),
    { content: 'Уточнение' },
  );
});

test('OpenCode receives a bare command in its own chat and reports an empty answer before accepting plain JSON', async (t) => {
  const f = fixture(t);
  const path = await chat(f);
  assert.equal((await f.request()).data.capabilities.serviceChat, true);
  const pending = await turn(f, path, '/services ', '');
  const [message, notice] = pending.messages;
  assert.equal(message.command, serviceChatCommand);
  assert.equal(message.content, serviceChatDefaultRequest);
  assert.equal(notice.role, 'system');
  assert.match(notice.content, /без ответа/);
  assert(pending.serviceDrafting);
  const ready = await turn(
    f,
    path,
    'Объедини сайт и API',
    '```json\n' +
      JSON.stringify({
        services: [{ name: 'Интранет', sources: [web, api] }],
      }) +
      '\n```',
  );
  assert.equal(ready.serviceBatches[0].cards[0].fields.name, 'Интранет');
  assert.match(ready.messages.at(-1).content, /Подготовлены черновики/);
  const sent = f.messages.filter((entry) => entry.method === 'session/prompt');
  assert(sent.every((entry) => entry.params.sessionId === 'native-chat'));
  assert.deepEqual(visibleServiceChatInput(sent[0].params.prompt[0].text), {
    content: serviceChatDefaultRequest,
    command: serviceChatCommand,
  });
});

test('conflicting batch cannot create partial records, and ordinary assistant code blocks have no effect', async (t) => {
  const f = fixture(t);
  const path = await chat(f);
  const ordinary = await turn(
    f,
    path,
    'Покажи пример данных',
    format([{ name: 'Пример' }]),
  );
  assert.deepEqual(ordinary.serviceBatches, []);
  const existing = await f.request('/services', 'POST', {
    name: 'Существующий сайт',
    machineId: f.machineId,
    source: web,
  });
  assert.equal(existing.status, 201);
  const ready = await turn(
    f,
    path,
    '/services Оформи оба приложения',
    format([
      { name: 'Тасктрекер', sources: [tracker] },
      { name: 'Интранет', sources: [web, api] },
    ]),
  );
  const [batch] = ready.serviceBatches;
  const refused = await f.request(
    path + '/service-drafts/' + batch.id + '/save',
    'POST',
    { ids: batch.cards.map((card) => card.id) },
  );
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /Существующий сайт/);
  const { data } = await f.request();
  assert.deepEqual(
    data.services.map((service) => service.id),
    [existing.data.id],
  );
  assert(
    (await f.request(path)).data.serviceBatches[0].cards.every(
      (card) => !card.result,
    ),
  );
});

test('stopping a service turn discards late proposals and keeps the next reply in context', async (t) => {
  const f = fixture(t);
  const path = await chat(f);
  let complete;
  f.replies.push(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  assert.equal(
    (
      await f.request(path + '/message', 'POST', {
        message: '/services Оформи',
      })
    ).status,
    202,
  );
  await waitFor(
    () => f.request(path),
    (detail) => detail.status === 'running',
  );
  assert.equal((await f.request(path + '/stop', 'POST')).status, 200);
  complete(format([{ name: 'Запоздавший черновик' }]));
  const ready = await turn(
    f,
    path,
    'Продолжи',
    format([{ name: 'Рабочий сервис' }]),
  );
  assert.equal(ready.serviceBatches.length, 1);
  assert.equal(ready.serviceBatches[0].cards[0].fields.name, 'Рабочий сервис');
});
