// Run after the production build; uses a disposable database, never the owner's data.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { withoutPanelSecrets } from '../runner/config.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mayplane-production-'));
const freePort = async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
};
const port = await freePort(),
  webPort = await freePort(),
  base = `http://127.0.0.1:${port}`;
const config = join(directory, 'panel.env'),
  key = randomBytes(32).toString('hex');
const env = {
  ...withoutPanelSecrets(),
  MAYPLANE_ENV_FILE: config,
  HOST: '127.0.0.1',
  PORT: String(port),
};
await writeFile(
  config,
  `MAYPLANE_ENCRYPTION_KEY=${key}\nMAYPLANE_DATA_DIR=${join(directory, 'data').replaceAll('\\', '/')}\nHOST=127.0.0.1\nPORT=${port}\nMAYPLANE_WEB_PORT=${webPort}\nMAYPLANE_PUBLIC_URL=${base}\n`,
  { mode: 0o600 },
);
const initial = 'production test passphrase 12345',
  next = 'replacement test passphrase 12345';
let app,
  output = '';
function capture(child) {
  child.stdout.on('data', (b) => {
    output = (output + b).slice(-16000);
  });
  child.stderr.on('data', (b) => {
    output = (output + b).slice(-16000);
  });
  return child;
}
async function setup(reset = false) {
  const child = capture(
    spawn(
      process.execPath,
      [
        'runner/setup.mjs',
        '--username',
        'smoke-owner',
        '--password-stdin',
        ...(reset ? ['--reset'] : []),
      ],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    ),
  );
  child.stdin.end(initial + '\n');
  assert.equal((await once(child, 'exit'))[0], 0);
}
async function request(path, { body, cookie, csrf } = {}) {
  return fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Origin: base,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-MayPlane-CSRF': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
}
const pause = () => new Promise((r) => setTimeout(r, 100));
async function ready(path, check = () => Promise.resolve(true)) {
  for (let n = 0; n < 200; n++) {
    if (app.exitCode !== null) throw new Error('Production process exited');
    try {
      const response = await request(path);
      if (response.ok && (await check(response))) return;
    } catch {}
    await pause();
  }
  throw new Error('Production readiness timed out');
}
try {
  await setup();
  // IPC exists only in this test wrapper, allowing clean Windows shutdown of the supervised children.
  app = capture(
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "await import('./runner/start.mjs');process.on('message',value=>{if(value==='stop')process.emit('SIGTERM')});",
      ],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    ),
  );
  await ready('/healthz');
  await ready('/', async (response) =>
    (await response.text()).includes('MayPlane'),
  );
  const page = await request('/');
  assert.match(
    page.headers.get('content-security-policy'),
    /frame-ancestors 'none'/,
  );
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await request('/api/hub')).status, 401);
  const login = await request('/api/auth/login', {
    body: { username: 'smoke-owner', password: initial },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0],
    session = await login.json();
  assert.equal((await request('/api/hub', { cookie })).status, 200);
  assert.equal(
    (await request('/api/auth/logout', { cookie, body: {} })).status,
    403,
  );
  const credentials = await request('/api/auth/credentials', {
    cookie,
    csrf: session.csrf,
    body: {
      username: 'changed-owner',
      currentPassword: initial,
      newPassword: next,
    },
  });
  assert.equal(credentials.status, 200);
  const currentCookie = credentials.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/hub', { cookie })).status, 401);
  assert.equal(
    (await request('/api/hub', { cookie: currentCookie })).status,
    200,
  );
  await setup(); // Re-running setup must not reset the changed password.
  assert.equal(
    (
      await request('/api/auth/login', {
        body: { username: 'changed-owner', password: next },
      })
    ).status,
    200,
  );
  await setup(true); // Recovery must invalidate already issued sessions without a restart.
  assert.equal(
    (await request('/api/hub', { cookie: currentCookie })).status,
    401,
  );
  assert.equal(
    (
      await request('/api/auth/login', {
        body: { username: 'smoke-owner', password: initial },
      })
    ).status,
    200,
  );
  assert.match(await readFile(config, 'utf8'), new RegExp(key));
  console.log(
    'Production smoke passed: standalone rendering, protected API, login, credential changes, idempotent setup, CLI recovery.',
  );
} catch (error) {
  console.error(
    output
      .replaceAll(initial, '[password]')
      .replaceAll(next, '[password]')
      .replaceAll(key, '[key]'),
  );
  throw error;
} finally {
  if (app && app.exitCode === null) {
    const exited = once(app, 'exit');
    app.send('stop');
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
