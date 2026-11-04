import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  createAgentLimits,
  codexLimits,
  sessionUsage,
} from '../runner/agent-limits.mjs';

const reset = Math.floor(Date.now() / 1000) + 3600;
const quota = (used = 25) => ({
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: used, windowDurationMins: 300, resetsAt: reset },
    secondary: {
      usedPercent: 10,
      windowDurationMins: 10080,
      resetsAt: reset + 86400,
    },
    credits: {
      hasCredits: true,
      unlimited: false,
      balance: '12.50',
      token: 'private-credit-token',
    },
  },
});
function fixture(t, options = {}) {
  const calls = [],
    prepared = [],
    released = [];
  let opened = 0,
    closed = 0;
  const service = createAgentLimits({
    prepareAccount: async (_machine, _provider, id, profile) => {
      prepared.push({ id, profile });
      return () => released.push(id);
    },
    authenticateAccount: (rpc, id) =>
      rpc.request('account/login/start', { accessToken: 'private-' + id }),
    refreshAccount: async () => {},
    openProcess: async (_machine, opts) => {
      opened++;
      assert.equal(opts.operation, 'agent');
      const stdout = new PassThrough(),
        stderr = new PassThrough(),
        events = new EventEmitter();
      let auth = '',
        stopped = false;
      const input = new Writable({
        write(bytes, _encoding, callback) {
          const message = JSON.parse(bytes);
          calls.push(message);
          const emit = (result) =>
            stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
          if (message.method === 'initialize') emit({});
          else if (message.method === 'account/login/start') {
            auth = message.params.accessToken;
            emit({});
          } else if (message.method === 'account/read')
            emit({
              account:
                options.account === undefined
                  ? { type: 'chatgpt' }
                  : options.account,
              requiresOpenaiAuth: true,
            });
          else if (message.method === 'account/rateLimits/read') {
            if (options.hold) options.hold(() => emit(quota()));
            else if (options.error)
              stdout.write(
                JSON.stringify({
                  id: message.id,
                  error: { message: options.error },
                }) + '\n',
              );
            else emit(quota(auth === 'private-work' ? 80 : 25));
          } else
            assert.equal(
              message.method,
              'initialized',
              'Quota reads must not create threads or start inference',
            );
          callback();
        },
      });
      return {
        stdout,
        stderr,
        events,
        input,
        close() {
          if (!stopped) {
            stopped = true;
            closed++;
            events.emit('close', 0);
          }
        },
      };
    },
  });
  t.after(() => service.close());
  return {
    service,
    calls,
    prepared,
    released,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
  };
}

test('quota projection handles multiple buckets and Unix resets without exposing provider metadata', () => {
  const data = codexLimits({
    ...quota(),
    rateLimitsByLimitId: {
      codex: {
        ...quota(30).rateLimits,
        limitName: 'Codex quota',
        planType: 'plus',
        accessToken: 'private',
      },
      separate: {
        primary: { usedPercent: 101, resetsAt: null },
        secondary: null,
      },
      invalid: { primary: { usedPercent: '50' }, apiKey: 'private' },
    },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [{ id: 'opaque-private-id' }],
    },
  });
  assert.equal(data.buckets.length, 2);
  assert.equal(data.buckets[0].primary.usedPercent, 30);
  assert.equal(
    data.buckets[0].primary.resetsAt,
    new Date(reset * 1000).toISOString(),
  );
  assert.equal(data.buckets[0].credits.balance, 12.5);
  assert.equal(data.buckets[1].primary.usedPercent, 100);
  assert.equal(data.availableResets, 2);
  assert.ok(!JSON.stringify(data).includes('private'));
  assert.equal(
    sessionUsage({
      used: 123,
      size: 200000,
      cost: { amount: 0.01, currency: 'USD' },
      secret: 'private',
    }).used,
    123,
  );
  assert.equal(sessionUsage({ used: Infinity, size: 200000 }), null);
  assert.equal(sessionUsage({ used: 10, size: 0 }), null);
});

test('read-only quota probes deduplicate concurrent requests, cache by account and always close transports', async (t) => {
  const f = fixture(t),
    machine = { id: 'host' };
  const [a, b] = await Promise.all([
    f.service.get(machine, 'codex', { accountId: 'personal' }),
    f.service.get(machine, 'codex', { accountId: 'personal' }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'available');
  assert.equal(a.buckets[0].primary.usedPercent, 25);
  assert.equal(f.opened, 1);
  assert.equal(f.closed, 1);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.released.length, 1);
  assert.equal(
    (await f.service.get(machine, 'codex', { accountId: 'work' })).buckets[0]
      .primary.usedPercent,
    80,
  );
  assert.equal(
    (
      await f.service.get(machine, 'codex', {
        accountId: 'personal',
        refresh: true,
      })
    ).buckets[0].primary.usedPercent,
    25,
  );
  assert.equal(f.opened, 2); // Manual refresh is throttled too.
  assert.notEqual(f.prepared[0].profile, f.prepared[1].profile);
  assert.ok(!JSON.stringify(a).includes('private-'));
});

test('live partial updates preserve other quota windows and do not cross account or machine boundaries', async (t) => {
  const f = fixture(t),
    machine = { id: 'host' };
  await f.service.get(machine, 'codex', { accountId: 'personal' });
  await f.service.get(machine, 'codex', { accountId: 'work' });
  f.service.update('host', 'codex', 'personal', {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: reset },
    },
  });
  const a = await f.service.get(machine, 'codex', { accountId: 'personal' });
  assert.equal(a.buckets[0].primary.usedPercent, 50);
  assert.equal(a.buckets[0].secondary.usedPercent, 10);
  assert.equal(a.buckets[0].credits.balance, 12.5);
  assert.equal(
    (await f.service.get(machine, 'codex', { accountId: 'work' })).buckets[0]
      .primary.usedPercent,
    80,
  );
  assert.equal(
    (await f.service.get({ id: 'second' }, 'codex', { accountId: 'personal' }))
      .buckets[0].primary.usedPercent,
    25,
  );
  f.service.invalidateAccount('personal');
  assert.equal(
    (await f.service.get(machine, 'codex', { accountId: 'personal' }))
      .buckets[0].primary.usedPercent,
    25,
  );
});

for (const account of [null, { type: 'apiKey' }])
  test(`quota probe reports ${account ? 'API-key limitations' : 'missing login'} without requesting subscription quotas`, async (t) => {
    const f = fixture(t, { account });
    const result = await f.service.get({ id: 'host' }, 'codex');
    assert.equal(result.status, account ? 'unsupported' : 'unauthenticated');
    assert.ok(!f.calls.some((c) => c.method === 'account/rateLimits/read'));
    assert.equal(f.closed, 1);
  });

test('unsupported OpenCode quota reads do not open an agent or acquire its OAuth lease', async (t) => {
  const f = fixture(t);
  const value = await f.service.get({ id: 'host' }, 'opencode', {
    accountId: 'personal',
  });
  assert.equal(value.status, 'unsupported');
  assert.equal(value.reason, 'provider');
  assert.equal(f.opened, 0);
  assert.equal(f.prepared.length, 0);
});

test('private upstream errors stay private and an invalidated in-flight probe cannot restore old quota data', async (t) => {
  const failed = fixture(t, {
    error: 'private-access-token in upstream response',
  });
  const result = await failed.service.get({ id: 'host' }, 'codex');
  assert.equal(result.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(failed.closed, 1);
  const started = Promise.withResolvers();
  let finish;
  const delayed = fixture(t, {
    hold: (emit) => {
      finish = emit;
      started.resolve();
    },
  });
  const pending = delayed.service.get({ id: 'host' }, 'codex', {
    accountId: 'personal',
  });
  await started.promise;
  delayed.service.invalidateAccount('personal');
  finish();
  assert.equal((await pending).status, 'unavailable');
  assert.equal(delayed.closed, 1);
  assert.equal(delayed.released.length, 1);
});
