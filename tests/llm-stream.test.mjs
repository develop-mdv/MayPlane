import test from 'node:test';
import assert from 'node:assert/strict';
import { chatJson } from '../runner/llm.mjs';
import { withCancellation } from '../runner/cancellation.mjs';
const config = {
  enabled: true,
  baseUrl: 'https://example.test/v1',
  model: 'test',
  secret: { apiKey: 'secret' },
};
const frame = (delta, finish = null) =>
  'data: ' +
  JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) +
  '\r\n\r\n';
const encoder = new TextEncoder();
function response(chunks, delay = 0) {
  let i = 0;
  return new Response(
    new ReadableStream({
      async pull(c) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (i === chunks.length) c.close();
        else
          c.enqueue(
            typeof chunks[i] === 'string'
              ? encoder.encode(chunks[i++])
              : chunks[i++],
          );
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
test('SSE parses split Unicode/events, excludes reasoning, preserves usage and completion', async () => {
  const all = encoder.encode(
    ': heartbeat\r\n\r\n' +
      frame({ reasoning_content: 'private thinking' }) +
      frame({ content: '{"text":"Привет"}' }, 'stop') +
      'data: ' +
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 9 },
      }) +
      '\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  const chunks = Array.from({ length: all.length }, (_, i) =>
    all.slice(i, i + 1),
  );
  let body;
  const r = await chatJson(config, [], {
    fetcher: async (_url, o) => {
      body = JSON.parse(o.body);
      return response(chunks);
    },
  });
  assert.equal(body.stream, true);
  assert.deepEqual(r, {
    data: { text: 'Привет' },
    usage: { input: 8, output: 9 },
  });
});
test('active generation can outlive idle window; stalled body reports actual timeout', async () => {
  const r = await chatJson(config, [], {
    fetcher: async () =>
      response(
        [
          ':a\n\n',
          ':b\n\n',
          ':c\n\n',
          frame({ content: '{"ok":true}' }, 'stop'),
          'data: [DONE]\n\n',
        ],
        15,
      ),
    idleTimeout: 60,
    timeout: 1000,
  });
  assert.equal(r.data.ok, true);
  await assert.rejects(
    chatJson(config, [], {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      idleTimeout: 30,
      timeout: 1000,
    }),
    (e) => e.status === 504 && /не передавала/.test(e.message),
  );
});
test('total deadline also bounds a stream that keeps sending heartbeats', async () => {
  await assert.rejects(
    chatJson(config, [], {
      fetcher: async () => response(Array(50).fill(': heartbeat\n\n'), 10),
      idleTimeout: 100,
      timeout: 55,
    }),
    (e) => e.status === 504 && /не завершила/.test(e.message),
  );
});
test('network errors and HTTP errors are not reported as 90-second timeout; no secrets leak', async () => {
  for (const status of [401, 402, 429, 500])
    await assert.rejects(
      chatJson(config, [], {
        fetcher: async () => new Response('secret', { status }),
      }),
      (e) =>
        e.status === 502 &&
        !e.message.includes('secret') &&
        !e.message.includes('90'),
    );
  await assert.rejects(
    chatJson(config, [], {
      fetcher: async () => {
        throw new TypeError('secret', { cause: { code: 'ENOTFOUND' } });
      },
    }),
    /DNS/,
  );
});
test('truncated, length-limited and provider error streams cannot produce a plan', async () => {
  for (const chunks of [
    [frame({ content: '{"ok":true}' })],
    [frame({ content: '{"ok":true}' }, 'length'), 'data: [DONE]\n\n'],
    ['data: {"error":{"code":429,"message":"secret"}}\n\n'],
  ])
    await assert.rejects(
      chatJson(config, [], { fetcher: async () => response(chunks) }),
      (e) => e.status === 502 && !e.message.includes('secret'),
    );
});
test('user cancellation interrupts an in-flight streaming body', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(
      withCancellation({ controller }, () =>
        chatJson(config, [], {
          fetcher: async () =>
            new Response(
              new ReadableStream({
                pull() {
                  return new Promise(() => {});
                },
              }),
            ),
          idleTimeout: 500,
        }),
      ),
      (e) => e.code === 'JOB_CANCELLED',
    );
  } finally {
    clearTimeout(timer);
  }
});
