import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { Writable } from 'node:stream';
import { withCancellation } from '../runner/cancellation.mjs';
import { connect, fingerprint, run, put } from '../runner/ssh.mjs';
test('SSH verifies pinned host key, authenticates and captures command status', async (t) => {
  // ssh2 accepts RSA PEM on every supported OpenSSL build.
  const rsa = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [rsa] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) =>
      ctx.method === 'password' && ctx.password === 'test-password'
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (accept, reject, info) => {
          const stream = accept();
          let script = '';
          stream.on('data', (c) => {
            script += c;
            if (!script.includes('\0')) return;
            assert.match(
              info.command,
              /^exec timeout --signal=TERM --kill-after=10s \d+ bash -c /,
            );
            if (script.includes('FAIL')) {
              stream.stderr.write('failed\n');
              stream.exit(2);
            } else {
              stream.write('hello\n');
              stream.exit(0);
            }
            stream.end();
          });
        });
      }),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const c of clients) c.end();
    await new Promise((r) => server.close(r));
  });
  const config = {
    host: '127.0.0.1',
    port: server.address().port,
    username: 'root',
    secret: { password: 'test-password' },
  };
  const actual = await fingerprint(config);
  assert.match(actual, /^SHA256:/);
  assert.equal(
    actual,
    'SHA256:' +
      createHash('sha256')
        .update(ssh2.utils.parseKey(rsa).getPublicSSH())
        .digest('base64')
        .replace(/=+$/, ''),
  );
  await assert.rejects(connect({ ...config, fingerprint: 'SHA256:wrong' }));
  const client = await connect({ ...config, fingerprint: actual });
  try {
    assert.equal(await run(client, 'echo hello', { timeout: 3000 }), 'hello\n');
    await assert.rejects(run(client, 'FAIL', { timeout: 3000 }), /кодом 2/);
  } finally {
    client.end();
  }
});

for (const behavior of ['term', 'delayed-term', 'kill', 'no-exit-status'])
  test(`SSH cancellation: ${behavior}`, { timeout: 8000 }, async (t) => {
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    const clients = new Set(),
      received = [],
      started = Promise.withResolvers();
    const server = new ssh2.Server({ hostKeys: [rsa] }, (client) => {
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept();
          let stream;
          session.on('signal', (_accept, _reject, info) => {
            received.push(info.name);
            if (behavior === 'kill' && info.name !== 'KILL') return;
            const exit = () => {
              if (behavior !== 'no-exit-status') stream.exit(info.name);
              stream.end();
            };
            if (behavior === 'delayed-term') setTimeout(exit, 100);
            else exit();
          });
          session.on('exec', (accept) => {
            stream = accept();
            let script = '';
            stream.on('data', (chunk) => {
              script += chunk;
              if (!script.includes('\0')) return;
              if (script.includes('long-command')) {
                stream.write('started\n');
                started.resolve();
              } else {
                stream.write('still-connected\n');
                stream.exit(0);
                stream.end();
              }
            });
          });
        }),
      );
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      for (const c of clients) c.end();
      await new Promise((r) => server.close(r));
    });
    const config = {
      host: '127.0.0.1',
      port: server.address().port,
      username: 'root',
      secret: { password: 'local-only' },
      fingerprint:
        'SHA256:' +
        createHash('sha256')
          .update(ssh2.utils.parseKey(rsa).getPublicSSH())
          .digest('base64')
          .replace(/=+$/, ''),
    };
    const client = await connect(config);
    const controller = new AbortController();
    try {
      const result = run(client, 'long-command', {
        signal: controller.signal,
        timeout: 5000,
        // Use the production grace period: a real SSH round trip and remote
        // cleanup can exceed a 25ms test-only deadline, especially on Linux CI.
      });
      const rejection = assert.rejects(result, {
        code:
          behavior === 'no-exit-status'
            ? 'JOB_CANCEL_UNCONFIRMED'
            : 'JOB_CANCELLED',
      });
      await started.promise;
      controller.abort();
      await rejection;
      assert.deepEqual(
        received,
        behavior === 'kill' ? ['TERM', 'KILL'] : ['TERM'],
      );
      assert.equal(
        await run(client, 'echo still-connected'),
        'still-connected\n',
      );
    } finally {
      controller.abort();
      client.end();
    }
  });

test(
  'SSH handshake cancellation closes the pending authenticated transport',
  { timeout: 5000 },
  async (t) => {
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    const authenticating = Promise.withResolvers(),
      closed = Promise.withResolvers();
    const clients = new Set();
    const server = new ssh2.Server({ hostKeys: [rsa] }, (client) => {
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => {
        clients.delete(client);
        closed.resolve();
      });
      client.on('authentication', () => authenticating.resolve());
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      for (const c of clients) c.end();
      await new Promise((r) => server.close(r));
    });
    const config = {
      host: '127.0.0.1',
      port: server.address().port,
      username: 'root',
      secret: { password: 'local-only' },
      fingerprint:
        'SHA256:' +
        createHash('sha256')
          .update(ssh2.utils.parseKey(rsa).getPublicSSH())
          .digest('base64')
          .replace(/=+$/, ''),
    };
    const controller = new AbortController();
    const connecting = assert.rejects(
      connect(config, { signal: controller.signal }),
      { code: 'JOB_CANCELLED' },
    );
    await authenticating.promise;
    controller.abort();
    await connecting;
    await closed.promise;
  },
);

for (const phase of ['opening', 'stat', 'write'])
  test(
    `SFTP cancellation interrupts ${phase} without later writes or permission changes`,
    { timeout: 3000 },
    async () => {
      const started = Promise.withResolvers();
      let writes = 0,
        permissions = 0,
        ended = 0,
        pendingOpen;
      const sftp = {
        end() {
          ended++;
        },
        stat() {
          started.resolve();
        },
        chmod() {
          permissions++;
        },
        createWriteStream() {
          writes++;
          return new Writable({
            write(_chunk, _encoding, _callback) {
              started.resolve();
            },
          });
        },
      };
      const client = {
        sftp(callback) {
          if (phase === 'opening') {
            pendingOpen = callback;
            started.resolve();
          } else callback(null, sftp);
        },
      };
      const operation = { controller: new AbortController() };
      const result = withCancellation(operation, () =>
        put(client, '/test.env', 'VALUE=local-only', {
          preserveMode: phase === 'stat',
        }),
      );
      const rejected = assert.rejects(result, { code: 'JOB_CANCELLED' });
      await started.promise;
      operation.controller.abort();
      await rejected;
      if (pendingOpen) pendingOpen(null, sftp);
      assert.ok(ended > 0);
      assert.equal(permissions, 0);
      assert.equal(writes, phase === 'write' ? 1 : 0);
    },
  );
