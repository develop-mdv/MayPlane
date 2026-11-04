import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { WebSocket } from 'ws';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { initializeOwner } from '../runner/owner-auth.mjs';
import { withoutPanelSecrets } from '../runner/config.mjs';

const password = 'test-only owner passphrase 12345';
test('malformed unauthenticated WebSocket targets are rejected without taking down the panel', async (t) => {
  const f = await fixture(t);
  for (const target of ['http://[', '//bad-host/api/connector']) {
    const response = await new Promise((resolve, reject) => {
      const socket = connectTcp({
        host: '127.0.0.1',
        port: new URL(f.base).port,
      });
      let result = '';
      socket.setTimeout(3000, () =>
        socket.destroy(new Error('Upgrade timeout')),
      );
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        result += chunk;
      });
      socket.on('end', () => resolve(result));
      socket.on('connect', () =>
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        ),
      );
    });
    assert.match(response, /HTTP\/1\.1 (400|404)/);
    assert.equal((await f.request('/healthz')).status, 200);
  }
});
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-owner-auth-'));
  const store = openStore(dir, randomBytes(32));
  await initializeOwner(store.db, { username: 'owner', password });
  const origins = [],
    peers = [];
  let sshClosed = 0;
  const app = createApp({
    store,
    ownerAuth: true,
    origins,
    engine: {},
    ...options,
    terminalOptions: {
      openSsh: async () =>
        Object.assign(new EventEmitter(), {
          destroy() {
            sshClosed++;
          },
        }),
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`,
    origin = options.publicUrl || base;
  origins.push(origin);
  const request = (
    path,
    { method = 'GET', body, cookie, csrf, headers = {} } = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(csrf ? { 'X-MayPlane-CSRF': csrf } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (name = 'owner', pass = password, headers = {}) => {
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: { username: name, password: pass },
      headers,
    });
    assert.equal(response.status, 200, await response.clone().text());
    return {
      cookie: response.headers.get('set-cookie').split(';')[0],
      data: await response.json(),
      header: response.headers.get('set-cookie'),
    };
  };
  t.after(async () => {
    for (const p of peers) p.terminate();
    app.terminals.close();
    app.hub.close();
    await new Promise((r) => app.server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    app,
    base,
    origin,
    request,
    login,
    peers,
    get sshClosed() {
      return sshClosed;
    },
  };
}

test('anonymous requests and old administrative bearer tokens cannot bypass owner login; cookies and hashes stay private', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal(
    (
      await f.request('/api/state', {
        headers: { Authorization: 'Bearer old-private-token' },
      })
    ).status,
    401,
  );
  assert.deepEqual(await (await f.request('/api/auth/session')).json(), {
    authenticated: false,
    configured: true,
  });
  const session = await f.login();
  assert.match(session.header, /HttpOnly/);
  assert.match(session.header, /SameSite=Strict/);
  assert.match(session.header, /Path=\//);
  assert.ok(!/Secure/.test(session.header));
  assert.ok(!JSON.stringify(session.data).includes(password));
  const row = f.store.db.prepare('SELECT * FROM owner_credentials').get();
  assert.ok(!JSON.stringify(row).includes(password));
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(
    !JSON.stringify(
      f.store.db.prepare('SELECT * FROM owner_sessions').all(),
    ).includes(session.cookie.split('=')[1]),
  );
  assert.equal(
    (await f.request('/api/state', { cookie: session.cookie })).status,
    200,
  );
  assert.equal(
    (await f.request('/api/auth/deployment', { cookie: session.cookie }))
      .status,
    200,
  );
  assert.deepEqual(
    await (
      await f.request('/api/auth/deployment', { cookie: session.cookie })
    ).json(),
    { enabled: false, managed: false, state: 'local' },
  );
});

test('owner mutations require the same Origin and per-session CSRF; malformed and oversized login requests fail closed', async (t) => {
  const f = await fixture(t),
    session = await f.login();
  const write = {
    method: 'POST',
    body: { name: 'Home' },
    cookie: session.cookie,
  };
  assert.equal((await f.request('/api/hub/pair', write)).status, 403);
  assert.equal(
    (
      await f.request('/api/hub/pair', {
        ...write,
        csrf: session.data.csrf,
        headers: { Origin: 'https://attacker.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request('/api/hub/pair', { ...write, csrf: 'wrong' })).status,
    403,
  );
  assert.equal(
    (await f.request('/api/hub/pair', { ...write, csrf: session.data.csrf }))
      .status,
    201,
  );
  assert.equal(
    (
      await f.request('/api/auth/login', {
        method: 'POST',
        body: { username: 'owner', password },
        headers: { Origin: 'null' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request('/api/auth/login', {
        method: 'POST',
        body: { username: 'owner', password: 'x'.repeat(9000) },
      })
    ).status,
    413,
  );
  const malformed = await fetch(f.base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: f.origin, 'Content-Type': 'application/json' },
    body: '{bad',
  });
  assert.equal(malformed.status, 400);
  assert.equal(
    (
      await f.request('/api/auth/logout', {
        ...write,
        body: {},
        csrf: session.data.csrf,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request('/api/state', { cookie: session.cookie })).status,
    401,
  );
});

test('credential changes require the current password, preserve application secrets and revoke every earlier login and pairing ticket', async (t) => {
  const f = await fixture(t),
    first = await f.login(),
    second = await f.login();
  const marker = { id: 'private-test', recordType: 'test-marker' };
  f.store.save('settings', marker, { value: 'saved-private-value' });
  const pair = await (
    await f.request('/api/hub/pair', {
      method: 'POST',
      cookie: first.cookie,
      csrf: first.data.csrf,
      body: { name: 'Home' },
    })
  ).json();
  const path = '/api/auth/credentials';
  const base = { method: 'POST', cookie: first.cookie, csrf: first.data.csrf };
  assert.equal(
    (
      await f.request(path, {
        ...base,
        body: {
          username: 'new-owner',
          currentPassword: 'incorrect',
          newPassword: 'new owner passphrase 12345',
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        ...base,
        body: {
          username: 'new-owner',
          currentPassword: password,
          newPassword: 'short',
        },
      })
    ).status,
    400,
  );
  const changed = await f.request(path, {
    ...base,
    body: {
      username: 'new-owner',
      currentPassword: password,
      newPassword: 'new owner passphrase 12345',
    },
  });
  assert.equal(changed.status, 200);
  const freshCookie = changed.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await f.request('/api/state', { cookie: first.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request('/api/state', { cookie: second.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request('/api/state', { cookie: freshCookie })).status,
    200,
  );
  assert.equal(
    f.store.get('settings', marker.id).secret.value,
    'saved-private-value',
  );
  const state = await (
    await f.request('/api/hub/pair/' + pair.pairingId, { cookie: freshCookie })
  ).json();
  assert.equal(state.status, 'cancelled');
  assert.equal(
    (
      await f.request('/api/auth/login', {
        method: 'POST',
        body: { username: 'owner', password },
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.login('new-owner', 'new owner passphrase 12345')).data.user
      .username,
    'new-owner',
  );
});

test('sessions expire server-side and idempotent setup never resets a password or existing application data', async (t) => {
  const f = await fixture(t),
    first = await f.login();
  const old = f.store.db
    .prepare('SELECT password_hash FROM owner_credentials')
    .get().password_hash;
  assert.equal(
    await initializeOwner(f.store.db, {
      username: 'ignored',
      password: 'another setup password 12345',
    }),
    null,
  );
  assert.equal(
    f.store.db.prepare('SELECT password_hash FROM owner_credentials').get()
      .password_hash,
    old,
  );
  f.store.db.exec('UPDATE owner_sessions SET expires_at=0');
  assert.equal(
    (await f.request('/api/state', { cookie: first.cookie })).status,
    401,
  );
  await initializeOwner(f.store.db, {
    username: 'owner',
    password: 'recovery test password 12345',
    reset: true,
  });
  assert.equal(
    (await f.login('owner', 'recovery test password 12345')).data.authenticated,
    true,
  );
});

test('login throttling cannot be evaded by spoofing X-Forwarded-For on an untrusted direct connection', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await f.request('/api/auth/login', {
          method: 'POST',
          body: { username: 'owner', password: 'bad' },
          headers: { 'X-Forwarded-For': `192.0.2.${i}` },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await f.request('/api/auth/login', {
        method: 'POST',
        body: { username: 'owner', password },
        headers: { 'X-Forwarded-For': '203.0.113.1' },
      })
    ).status,
    429,
  );
});

test('HTTPS deployments issue host-only Secure cookies and reject untrusted cleartext transport', async (t) => {
  const f = await fixture(t, {
    publicUrl: 'https://panel.example.test',
    trustProxy: true,
  });
  assert.equal(
    (
      await f.request('/api/auth/login', {
        method: 'POST',
        body: { username: 'owner', password },
      })
    ).status,
    403,
  );
  const session = await f.login('owner', password, {
    'X-Forwarded-Proto': 'https',
  });
  assert.match(session.header, /^__Host-mayplane_session=/);
  assert.match(session.header, /; Secure/);
  assert.ok(!session.header.includes('Domain='));
  const state = await f.request('/api/state', {
    cookie: session.cookie,
    headers: { 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(state.status, 200);
  assert.equal(
    state.headers.get('strict-transport-security'),
    'max-age=31536000',
  );
});

test('SSH console tickets require their owner cookie, and logout closes live consoles immediately', async (t) => {
  const f = await fixture(t),
    first = await f.login(),
    second = await f.login(),
    id = randomUUID();
  f.store.save(
    'servers',
    {
      id,
      name: 'test',
      host: '127.0.0.1',
      port: 22,
      username: 'test',
      status: 'online',
    },
    {},
  );
  const ticket = await (
    await f.request(`/api/servers/${id}/terminal-ticket`, {
      method: 'POST',
      body: {},
      cookie: first.cookie,
      csrf: first.data.csrf,
    })
  ).json();
  const connect = (cookie) => {
    const peer = new WebSocket(
      f.base.replace('http:', 'ws:') + `/api/servers/${id}/terminal`,
      ['mayplane-terminal', ticket.ticket],
      { headers: { Origin: f.origin, ...(cookie ? { Cookie: cookie } : {}) } },
    );
    f.peers.push(peer);
    peer.on('error', () => {});
    return peer;
  };
  for (const cookie of [null, second.cookie]) {
    const peer = connect(cookie),
      [, response] = await once(peer, 'unexpected-response');
    assert.ok([401, 403].includes(response.statusCode));
    response.resume();
    peer.terminate();
  }
  const peer = connect(first.cookie);
  await once(peer, 'open');
  const closed = once(peer, 'close');
  await f.request('/api/auth/logout', {
    method: 'POST',
    body: {},
    cookie: first.cookie,
    csrf: first.data.csrf,
  });
  await closed;
  assert.ok(f.sshClosed > 0);
  assert.equal(
    (await f.request('/api/state', { cookie: second.cookie })).status,
    200,
  );
});

test('the frontend child process receives runtime basics without panel, provider or cloud credentials', () => {
  assert.deepEqual(
    withoutPanelSecrets({
      PATH: '/bin',
      HOME: '/home/owner',
      MAYPLANE_ENCRYPTION_KEY: 'private',
      OPENAI_API_KEY: 'private',
      AWS_SECRET_ACCESS_KEY: 'private',
      TOKEN: 'private',
      NODE_OPTIONS: '--inspect=0.0.0.0',
    }),
    { PATH: '/bin', HOME: '/home/owner' },
  );
});
