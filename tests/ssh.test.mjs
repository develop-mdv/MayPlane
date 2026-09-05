import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { connect, fingerprint, run } from '../runner/ssh.mjs';
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
          stream.on('data', (c) => (script += c));
          stream.on('end', () => {
            assert.equal(info.command, 'bash -se');
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
