import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { WebSocket } from 'ws';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { fingerprint } from '../runner/ssh.mjs';
const waitFor = async (fn) => {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
test('terminal: real SSH PTY, input, resize, ticket binding and disconnect cleanup', async (t) => {
  const rsa = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set();
  let pty,
    windowSize,
    received = '';
  const ssh = new ssh2.Server({ hostKeys: [rsa] }, (client) => {
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
        session.on('pty', (accept, _reject, info) => {
          pty = info;
          accept();
        });
        session.on('window-change', (accept, _reject, info) => {
          windowSize = info;
          accept?.();
        });
        session.on('shell', (accept) => {
          const channel = accept();
          channel.write('test-shell\r\n');
          channel.on('data', (data) => {
            received += data;
            channel.write(data);
          });
        });
      }),
    );
  });
  await new Promise((r) => ssh.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-terminal-'));
  const store = openStore(dir, randomBytes(32));
  const id = randomUUID();
  const origin = 'http://localhost:3000';
  let now = Date.now();
  const config = {
    id,
    name: 'test',
    host: '127.0.0.1',
    port: ssh.address().port,
    username: 'root',
    secret: { password: 'test-password' },
  };
  config.fingerprint = await fingerprint(config);
  store.save('servers', config);
  const { server, terminals } = createApp({
    store,
    token: 'owner-token',
    origins: [origin],
    engine: {},
    terminalOptions: { now: () => now },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.terminate());
    terminals.close();
    for (const c of clients) c.destroy();
    await Promise.all([
      new Promise((r) => server.close(r)),
      new Promise((r) => ssh.close(r)),
    ]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function ticket(extra = {}) {
    return fetch(base + `/api/servers/${id}/terminal-ticket`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        Origin: origin,
        ...extra,
      },
    });
  }
  const open = (key, site = origin, target = id) => {
    const ws = new WebSocket(
      base.replace('http', 'ws') + `/api/servers/${target}/terminal`,
      ['mayplane-terminal', key],
      { origin: site },
    );
    sockets.push(ws);
    return ws;
  };
  const rejected = (ws) =>
    new Promise((resolve, reject) => {
      ws.on('open', () => reject(new Error('Unexpected authorization')));
      ws.on('error', (e) => resolve(e.message));
    });
  assert.equal((await ticket({ Authorization: 'wrong' })).status, 401);
  assert.equal((await ticket({ Origin: 'https://evil.example' })).status, 403);
  const key = (await (await ticket()).json()).ticket;
  assert.match(await rejected(open(key, 'https://evil.example')), /403/);
  assert.match(await rejected(open(key, origin, randomUUID())), /403/);
  const ws = open(key);
  const messages = [];
  let output = '';
  ws.on('error', () => {});
  ws.on('message', (data, binary) => {
    if (binary) output += data;
    else {
      const m = JSON.parse(data);
      messages.push(m);
      if (m.type === 'connected')
        ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    }
  });
  await waitFor(() => messages.some((m) => m.type === 'ready'));
  assert.equal(pty.cols, 100);
  assert.equal(pty.rows, 30);
  assert.equal(pty.term, 'xterm-256color');
  ws.send(JSON.stringify({ type: 'input', data: 'pwd\r\u0003' }));
  ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await waitFor(
    () =>
      received.includes('\u0003') &&
      windowSize?.cols === 120 &&
      output.includes('pwd'),
  );
  assert.equal(windowSize.rows, 40);
  assert.match(await rejected(open(key)), /403/);
  const expired = (await (await ticket()).json()).ticket;
  now += 31000;
  assert.match(await rejected(open(expired)), /403/);
  const revoked = (await (await ticket()).json()).ticket;
  terminals.invalidate(id);
  await waitFor(() => ws.readyState === WebSocket.CLOSED);
  assert.match(await rejected(open(revoked)), /403/);
  await waitFor(() => clients.size === 0);
});
