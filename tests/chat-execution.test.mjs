import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { unwrapHarnessInput } from '../lib/chat-harness.mjs';
import { visibleServiceChatInput } from '../lib/service-chat.mjs';
import { createHub } from '../runner/hub.mjs';
import { openStore } from '../runner/store.mjs';

function agent(operation) {
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  const calls = [];
  const emit = (packet) => stdout.write(JSON.stringify(packet) + '\n');
  const reply = (id, result) => emit({ id, result });
  const responses = {
    initialize: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    },
    'account/read': { account: { type: 'chatgpt' } },
    'thread/start': { thread: { id: 'native-chat' } },
    'thread/resume': { thread: { id: 'native-chat' } },
    'session/new': { sessionId: 'native-chat' },
    'session/load': {},
    'turn/start': { turn: { id: 'native-turn' } },
    'turn/interrupt': {},
  };
  input.on('data', (bytes) => {
    const request = JSON.parse(bytes.toString());
    calls.push(request);
    if (Object.hasOwn(responses, request.method))
      reply(request.id, responses[request.method]);
    events.emit('call', request);
  });
  if (operation !== 'agent') {
    setImmediate(() => {
      stdout.write(operation === 'auth-status' ? '{"loggedIn":true}' : '1.0.0');
      events.emit('close', 0);
    });
  }
  return { input, stdout, stderr, events, calls, emit, reply, close() {} };
}

async function fixture(t, provider) {
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-chat-execution-'));
  const store = openStore(dir, randomBytes(32));
  const machineId = randomUUID(),
    server = createServer();
  const processes = [];
  store.save(
    'servers',
    { id: machineId, transport: 'local', platform: process.platform },
    {},
  );
  const hub = createHub(server, store, {
    resolveHome: async () => dir,
    openProcess: async (_, { operation }) => {
      const p = agent(operation);
      if (operation === 'agent') processes.push(p);
      return p;
    },
  });
  t.after(() => {
    hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', body = {}) {
    let response;
    await hub.handle('/api/hub' + path, method, body, (data, status = 200) => {
      response = { data, status };
    });
    return response;
  }
  const { data: session } = await request('/sessions', 'POST', {
    provider,
    machineId,
  });
  return { request, session, processes, store };
}

function permission(id, codex, allow = true) {
  const params = codex
    ? {
        threadId: 'native-chat',
        turnId: 'native-turn',
        availableDecisions: [allow ? 'accept' : 'decline', 'acceptForSession'],
      }
    : {
        sessionId: 'native-chat',
        options: [
          { kind: 'allow_always', optionId: 'always' },
          { kind: 'reject_once', optionId: 'no' },
          ...(allow ? [{ kind: 'allow_once', optionId: 'once' }] : []),
        ],
      };
  return {
    id,
    params,
    method: codex
      ? 'item/commandExecution/requestApproval'
      : 'session/request_permission',
  };
}

test('chat modes work with Codex, OpenCode and Claude and revoke auto approval during a turn', async (t) => {
  for (const provider of ['codex', 'opencode', 'claude'])
    await t.test(provider, async (t) => {
      const { request, session, processes, store } = await fixture(t, provider);
      const url = `/sessions/${session.id}`;
      const patch = (value) => request(url + '/execution', 'PATCH', value);
      const read = async () => (await request(url)).data;
      const codex = provider === 'codex';
      const promptMethod = codex ? 'turn/start' : 'session/prompt';
      const promptText = (m) =>
        (codex ? m.params.input : m.params.prompt)[0].text;
      const firstTask = 'Проверь привязку компонентов';
      const lesson = 'Сначала проверяй имена компонентов в Compose';
      const toolOutput = 'Compose components verified: web, worker';
      const pending = async (process, index = 0) => {
        const signal = AbortSignal.timeout(1500);
        for (;;) {
          const call = process.calls.filter((m) => m.method === promptMethod)[
            index
          ];
          if (call) return call;
          await once(process.events, 'call', { signal });
        }
      };
      function deliver(process, text, itemId) {
        process.emit(
          codex
            ? {
                method: 'item/agentMessage/delta',
                params: {
                  itemId,
                  threadId: 'native-chat',
                  turnId: 'native-turn',
                  delta: text,
                },
              }
            : {
                method: 'session/update',
                params: {
                  sessionId: 'native-chat',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text },
                  },
                },
              },
        );
      }
      async function finish(process, call) {
        if (codex)
          process.emit({
            method: 'turn/completed',
            params: {
              threadId: 'native-chat',
              turn: { id: 'native-turn', status: 'completed' },
            },
          });
        else process.reply(call.id, { stopReason: 'end_turn' });
        const until = AbortSignal.timeout(7500);
        let result = await read();
        while (
          ['running', 'approval'].includes(result.status) &&
          !until.aborted
        ) {
          await delay(10);
          result = await read();
        }
        assert.equal(result.status, 'idle');
        return result;
      }
      function report(observation) {
        return (
          '\n\n```mayplane-harness\n' +
          JSON.stringify({ lesson: observation, evidence: toolOutput }) +
          '\n```'
        );
      }

      assert.notEqual((await read()).autoApprove, true);
      await assert.rejects(patch({ harnessEnabled: 'true' }), { status: 400 });
      await assert.rejects(patch({ autoApprove: true }), { status: 400 });
      assert.equal(
        (await patch({ harnessEnabled: true })).data.harnessEnabled,
        true,
      );
      assert.equal(
        (await patch({ autoApprove: true, confirmAutoApprove: true })).data
          .autoApprove,
        true,
      );
      assert.equal(
        (await request(url + '/message', 'POST', { message: firstTask }))
          .status,
        202,
      );
      let process = processes.at(-1);
      const first = await pending(process);
      assert.equal(unwrapHarnessInput(promptText(first)), firstTask);
      assert.match(promptText(first), /Propose[\s\S]*Probe[\s\S]*Compose/);

      process.emit({ id: 'unknown', method: 'unknown/request' });
      assert.equal(
        process.calls.find((m) => m.id === 'unknown').error.code,
        -32601,
      );
      process.emit(permission('auto', codex));
      assert.deepEqual(
        process.calls.find((m) => m.id === 'auto').result,
        codex
          ? { decision: 'accept' }
          : { outcome: { outcome: 'selected', optionId: 'once' } },
      );
      assert.deepEqual((await read()).approvals, []);
      process.emit(permission('no-once', codex, false));
      if (codex)
        process.emit({
          id: 'question',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [{ id: 'choice', question: 'Какой компонент?' }],
          },
        });
      assert.equal((await read()).approvals.length, codex ? 2 : 1);
      assert.ok(
        !process.calls.some((m) => ['no-once', 'question'].includes(m.id)),
      );
      await assert.rejects(patch({ harnessEnabled: false }), { status: 409 });
      assert.equal(
        (await patch({ autoApprove: false })).data.autoApprove,
        false,
      );
      process.emit(permission('manual', codex));
      assert.ok((await read()).approvals.some((a) => a.id === 'manual'));
      assert.ok(!process.calls.some((m) => m.id === 'manual'));

      process.emit(
        codex
          ? {
              method: 'item/completed',
              params: {
                threadId: 'native-chat',
                turnId: 'native-turn',
                item: {
                  type: 'commandExecution',
                  id: 'tool',
                  exitCode: 0,
                  aggregatedOutput: toolOutput,
                },
              },
            }
          : {
              method: 'session/update',
              params: {
                sessionId: 'native-chat',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tool',
                  status: 'completed',
                  rawOutput: toolOutput,
                },
              },
            },
      );
      deliver(process, 'Готово.' + report(lesson), 'first-assistant');
      const firstResult = await finish(process, first);
      assert.deepEqual(
        firstResult.messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content),
        [firstTask],
      );
      assert.equal(
        firstResult.messages.find((m) => m.role === 'assistant').content,
        'Готово.',
      );
      assert.ok(
        firstResult.messages.some(
          (m) => m.content === 'Автоматически одобрено действий · 1',
        ),
      );
      assert.deepEqual(
        store.get('settings', session.id).secret.harnessMemory.lessons,
        [lesson],
      );

      process.events.emit('close', 0);
      await request(url + '/message', 'POST', { message: 'Проверь снова' });
      process = processes.at(-1);
      const second = await pending(process);
      assert.ok(promptText(second).includes(lesson));
      assert.ok(
        process.calls.some(
          (m) => m.method === (codex ? 'thread/resume' : 'session/load'),
        ),
      );
      deliver(
        process,
        'Проверил.' + report('Наблюдение без свежего подтверждения'),
        'second-assistant',
      );
      await finish(process, second);
      assert.deepEqual(
        store.get('settings', session.id).secret.harnessMemory.lessons,
        [lesson],
      );

      assert.equal(
        (await patch({ harnessEnabled: false })).data.harnessEnabled,
        false,
      );
      await request(url + '/message', 'POST', { message: 'Обычная задача' });
      const ordinary = await pending(process, 1);
      assert.equal(promptText(ordinary), 'Обычная задача');
      await finish(process, ordinary);

      if (codex) {
        await patch({ harnessEnabled: true });
        await request(url + '/message', 'POST', {
          message: '/services Оформи демо',
        });
        const drafting = await pending(process, 2);
        assert.deepEqual(
          visibleServiceChatInput(unwrapHarnessInput(promptText(drafting))),
          {
            command: '/services',
            content: 'Оформи демо',
          },
        );
        deliver(
          process,
          'Черновик.' +
            report('Наблюдение без вывода') +
            '\n\n```mayplane-services\n{"services":[{"name":"Demo","sources":[]}]}\n```',
          'service-assistant',
        );
        assert.equal(
          (await finish(process, drafting)).serviceBatches[0].cards[0].fields
            .name,
          'Demo',
        );
      }
    });
});
