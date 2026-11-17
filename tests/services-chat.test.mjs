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
import { serviceHasChat } from '../lib/service-workspace.mjs';
import {
  serviceFieldLink,
  serviceMetricKey,
  unwrapServiceCustomizationInput,
} from '../lib/service-customization.mjs';
import {
  attachServiceChatCommand,
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
      assert([machineId, dev].includes(machine.id));
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
          if (file === 'curl') {
            return args.at(-1).endsWith('/other.json')
              ? '{"queue":{"waiting":7}}\n200'
              : '{"queue":{"waiting":0,"workers":3,"private":"not-a-metric"}}\n200';
          }
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
  return {
    machineId,
    dev,
    projectId,
    provider,
    messages,
    calls,
    replies,
    request,
  };
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

async function turn(f, path, message, reply, options = {}) {
  f.replies.push(reply);
  const result = await f.request(path + '/message', 'POST', {
    message,
    ...options,
  });
  assert.equal(result.status, 202, result.data.error);
  return waitFor(
    () => f.request(path),
    (detail) => detail.status === 'idle',
  );
}

test('service chats resolve the real folder with or without a registered project', async (t) => {
  const f = fixture(t);
  const { data: service } = await f.request('/services', 'POST', {
    name: 'Worker',
    machineId: f.machineId,
    directory: '/srv/worker/',
  });
  const start = () =>
    f.request('/sessions', 'POST', {
      provider: f.provider,
      serviceId: service.id,
      serviceCwd: '/srv/worker/',
    });
  const { data: loose, status } = await start();
  assert.equal(status, 201);
  assert.equal(loose.cwd, '/srv/worker/');
  assert.equal(loose.projectId, null);
  assert.equal(loose.serviceId, service.id);
  const { data: project } = await f.request('/projects', 'POST', {
    name: 'Worker project',
    machineId: f.machineId,
    path: '/srv/worker',
  });
  assert.equal(
    (
      await f.request('/sessions', 'POST', {
        provider: f.provider,
        serviceId: service.id,
        serviceCwd: '/srv/outdated',
      })
    ).status,
    409,
  );
  const { data: linked } = await start();
  assert.equal(linked.cwd, '/srv/worker');
  assert.equal(linked.projectId, project.id);
  assert.equal(
    serviceHasChat(
      service,
      { ...loose, serviceId: undefined },
      [project],
      'linux',
    ),
    true,
  );
  assert.equal(
    serviceHasChat(
      service,
      { ...loose, cwd: '/srv/worker/other', serviceId: undefined },
      [project],
      'linux',
    ),
    false,
  );
  assert.equal(
    serviceHasChat(
      service,
      { ...loose, machineId: 'elsewhere' },
      [project],
      'linux',
    ),
    false,
  );
  assert.equal(
    serviceHasChat(
      { ...service, directory: 'D:\\Apps\\Worker\\' },
      { ...loose, cwd: 'd:/apps/worker/.', serviceId: undefined },
      [],
      'win32',
    ),
    true,
  );
});

test('service fields link to HTTP(S) destinations, including saved Markdown values', () => {
  const url = 'https://example.test/admin';
  const link = {
    type: 'link',
    label: 'Ссылка на панель',
    value: 'Открыть',
    url,
  };
  assert.deepEqual(serviceFieldLink(link), { label: 'Открыть', url });
  assert.deepEqual(
    serviceFieldLink({ label: link.label, value: '[Открыть](' + url + ')' }),
    { label: 'Открыть', url },
  );
  assert.equal(
    serviceFieldLink({ value: '[Открыть](javascript:alert(1))' }),
    null,
  );
  assert.equal(
    serviceFieldLink({ ...link, url: 'https://example:secret@example.test/' }),
    null,
  );
  assert.equal(serviceFieldLink({ ...link, type: 'code', value: url }), null);
});

test('a proposal from another machine customizes the selected service and measures its sources after approval', async (t) => {
  const f = fixture(t, 'codex');
  const { data: service } = await f.request('/services', 'POST', {
    name: 'Worker',
    machineId: f.machineId,
    directory: '/srv/worker',
    source: web,
  });
  const { data: session, status } = await f.request('/sessions', 'POST', {
    machineId: f.dev,
    projectId: f.projectId,
    provider: f.provider,
  });
  assert.equal(status, 201);
  assert.equal(session.machineId, f.dev);
  assert.equal(serviceHasChat(service, session, [], 'linux'), false);
  const path = '/sessions/' + session.id;
  const servicePath = '/services/' + service.id;
  const target = { customizeServiceId: service.id };
  const fields = [{ label: 'Обработка', value: 'Фоновая' }];
  const metrics = [
    { label: 'Ожидают', path: 'queue.waiting', unit: 'зад.' },
    { label: 'Воркеры', path: 'queue.workers' },
    { label: 'Среднее время', path: 'latency.avg', unit: 'мс' },
  ];
  const metricsUrl = 'http://127.0.0.1:8080/metrics.json';
  const alternate = {
    label: 'Другая очередь',
    path: 'queue.waiting',
    unit: 'зад.',
    url: 'http://127.0.0.1:9090/other.json',
    warningAt: 3,
    criticalAt: 6,
    alertWhen: 'above',
  };
  const runtime = {
    label: 'Процессор',
    path: 'cpuCores',
    unit: 'vCPU',
    source: 'runtime',
  };
  const link = {
    type: 'link',
    label: 'Управление',
    value: 'Открыть',
    url: 'https://example.test/admin',
  };
  const sections = [
    {
      title: 'Управление и нагрузка',
      layout: 'grid',
      description: 'Воркеры по очередям',
      fields: [link],
      metrics: [alternate, runtime],
    },
  ];
  const formatCustomization = (configuration) =>
    'Предлагаю такую карточку.\n\n```mayplane-service-config\n' +
    JSON.stringify(configuration) +
    '\n```';
  const message = 'Покажи очередь и режим обработки';
  const detail = await turn(
    f,
    path,
    message,
    formatCustomization({
      fields,
      metrics,
      metricsUrl,
      sections,
      name: 'Это не имя сервиса',
      serviceId: randomUUID(),
    }),
    target,
  );
  const input = f.messages.find((entry) => entry.method === 'turn/start').params
    .input[0].text;
  assert.equal(unwrapServiceCustomizationInput(input), message);
  assert.match(input, /"machine":"Test VPS","onServiceMachine":false/);
  const draft = detail.serviceCustomizations[0];
  assert.deepEqual(draft.configuration.fields, fields);
  assert.equal(draft.configuration.metricsUrl, metricsUrl);
  assert.equal((await f.request(servicePath)).data.customization, undefined);
  assert.ok(!f.calls.some(([file]) => file === 'curl'));

  const apply = (id) =>
    f.request(path + '/service-customizations/' + id + '/apply', 'POST');
  const saved = await apply(draft.id);
  assert.equal(saved.status, 200);
  assert.deepEqual((await apply(draft.id)).data, saved.data);
  await f.request('/services/refresh', 'POST', {
    machineId: f.machineId,
    wait: true,
  });
  const card = (await f.request(servicePath)).data;
  assert.equal(card.name, 'Worker');
  assert.deepEqual(card.customization.fields, fields);
  assert.deepEqual(card.customization.sections, sections);
  assert.deepEqual(card.customMetricValues, {
    'queue.waiting': 0,
    'queue.workers': 3,
    [serviceMetricKey(alternate)]: 7,
    [serviceMetricKey(runtime)]: 0.05,
  });
  assert.ok(
    f.calls.some(
      ([file, ...args]) => file === 'curl' && args.at(-1) === metricsUrl,
    ),
  );

  const next = await turn(
    f,
    path,
    'Убери основное поле',
    formatCustomization({ fields: [] }),
    target,
  );
  const pending = next.serviceCustomizations.at(-1);
  assert.deepEqual(pending.removedFields, ['Обработка']);
  assert.deepEqual(pending.configuration.sections, sections);
  assert.deepEqual(pending.configuration.metrics, card.customization.metrics);
  await f.request(servicePath, 'PATCH', {
    customization: { fields: [{ label: 'Вручную', value: 'Сохранено' }] },
  });
  assert.equal((await apply(pending.id)).status, 409);
  const invalid = await turn(
    f,
    path,
    'Предложи другой источник',
    formatCustomization({
      fields,
      metrics,
      metricsUrl: 'http://example.test/metrics',
    }),
    target,
  );
  assert.ok(invalid.serviceCustomizations.at(-1).warning);
  assert.equal(invalid.serviceCustomizations.at(-1).configuration, undefined);
  assert.deepEqual((await f.request(servicePath)).data.customization.fields, [
    { label: 'Вручную', value: 'Сохранено' },
  ]);
});

test('OpenCode chat asks for a repository, then drafts two services and follows each component after saving', async (t) => {
  const f = fixture(t);
  const path = await chat(f);
  const badge = {
    label: 'Среда',
    value: 'Внутренняя',
    type: 'badge',
    tone: 'good',
  };
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
        customization: { sections: [{ title: 'Доступ', fields: [badge] }] },
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
  assert.deepEqual(service.customization.sections[0].fields, [badge]);
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
  assert.equal(attachServiceChatCommand(''), '/services ');
  assert.equal(attachServiceChatCommand('/serv'), '/services ');
  const attached = attachServiceChatCommand('Оформи сайт и API');
  assert.equal(attached, '/services Оформи сайт и API');
  assert.equal(attachServiceChatCommand(attached), attached);
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
