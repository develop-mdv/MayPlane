import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { certificateStatus } from '../runner/tls-status.mjs';
import { withoutPanelSecrets } from '../runner/config.mjs';
import { openStore } from '../runner/store.mjs';

const bash =
  process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const hasBash = process.platform !== 'win32' || existsSync(bash);
test('setup cannot replace a missing database key or initialize owner credentials using a wrong key', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mayplane-missing-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'data'),
    envFile = join(directory, 'panel.env'),
    key = randomBytes(32);
  const store = openStore(data, key);
  store.save(
    'servers',
    { id: 'existing', name: 'Existing machine' },
    { password: 'encrypted existing secret' },
  );
  store.close();
  const args = [
    fileURLToPath(new URL('../runner/setup.mjs', import.meta.url)),
    '--password-stdin',
  ];
  const env = {
    ...withoutPanelSecrets(),
    MAYPLANE_ENV_FILE: envFile,
    MAYPLANE_DATA_DIR: data,
  };
  const absent = spawnSync(process.execPath, args, {
    env,
    input: 'setup test passphrase 12345\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /новый ключ не создан/);
  assert.equal(existsSync(envFile), false);
  const wrong = spawnSync(process.execPath, args, {
    env: { ...env, MAYPLANE_ENCRYPTION_KEY: randomBytes(32).toString('hex') },
    input: 'setup test passphrase 12345\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Ключ шифрования не подходит/);
  assert.equal(existsSync(envFile), false);
  const reopened = openStore(data, key);
  assert.equal(
    reopened.get('servers', 'existing').secret.password,
    'encrypted existing secret',
  );
  assert.equal(
    reopened.db
      .prepare("SELECT name FROM sqlite_master WHERE name='owner_credentials'")
      .get(),
    undefined,
  );
  reopened.close();
});
const install = (...args) =>
  execFileSync(bash, ['scripts/install.sh', ...args], {
    encoding: 'utf8',
    timeout: 10000,
  });
test(
  'installer plans are read-only, loopback-bound, with automatic TLS only for public modes',
  { skip: !hasBash },
  () => {
    execFileSync(bash, ['-n', 'scripts/install.sh']);
    for (const [mode, address, url, tls] of [
      ['local', '', 'http://127.0.0.1:8788', false],
      ['ip', '83.217.221.18', 'https://83.217.221.18', true],
      ['ip', '2a03:6f00:a::160c', 'https://[2a03:6f00:a::160c]', true],
      ['domain', 'panel.example.com', 'https://panel.example.com', true],
    ]) {
      const plan = JSON.parse(
        install(
          '--mode',
          mode,
          ...(address ? ['--address', address] : []),
          '--plan',
        ),
      );
      assert.equal(plan.mode, mode);
      assert.equal(plan.url, url);
      assert.equal(plan.automaticTls, tls);
      assert.equal(plan.bind, '127.0.0.1');
    }
    const ip = install(
      '--mode',
      'ip',
      '--address',
      '83.217.221.18',
      '--print-caddy',
    );
    assert.match(ip, /default_sni 83\.217\.221\.18/);
    assert.match(ip, /issuer acme/);
    assert.match(ip, /profile shortlived/);
    assert.match(ip, /https:\/\/acme-v02\.api\.letsencrypt\.org\/directory/);
    assert.doesNotMatch(ip, /internal|insecure/);
    const domain = install(
      '--mode',
      'domain',
      '--address',
      'panel.example.com',
      '--email',
      'owner@example.com',
      '--print-caddy',
    );
    assert.match(domain, /https:\/\/panel\.example\.com/);
    assert.match(domain, /email owner@example\.com/);
    assert.doesNotMatch(domain, /shortlived|tls internal/);
    assert.equal(install('--mode', 'local', '--print-caddy'), '');
  },
);
test(
  'installer rejects command/config injection before its read-only preview',
  { skip: !hasBash },
  () => {
    for (const args of [
      ['--mode', 'bad'],
      ['--mode', 'ip', '--address', '1.2.3.4;id'],
      ['--mode', 'domain', '--address', 'example.com\n{tls internal}'],
      ['--username', 'a b'],
      ['--mode', 'domain', '--address', 'https://example.com'],
      ['--email', 'evil@example.com\nadmin off'],
    ]) {
      const result = spawnSync(
        bash,
        ['scripts/install.sh', ...args, '--plan'],
        { encoding: 'utf8', timeout: 10000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /MayPlane:/);
    }
  },
);

function probe({
  managed = true,
  url = 'https://panel.example.com',
  expiry = Date.now() + 5 * 86400000,
  error = false,
  timeout = false,
} = {}) {
  let options,
    destroyed = false;
  const promise = certificateStatus(url, {
    managed,
    connect(value) {
      options = value;
      const socket = new EventEmitter();
      socket.destroy = () => {
        destroyed = true;
      };
      socket.setTimeout = (_ms, callback) => {
        if (timeout) setImmediate(() => callback());
      };
      socket.getPeerCertificate = () => ({
        valid_to: new Date(expiry).toUTCString(),
        issuer: { CN: 'Test issuer' },
      });
      if (!timeout)
        setImmediate(() =>
          socket.emit(
            error ? 'error' : 'secureConnect',
            new Error('test failure'),
          ),
        );
      return socket;
    },
  });
  return {
    promise,
    get options() {
      return options;
    },
    get destroyed() {
      return destroyed;
    },
  };
}
test('TLS status validates the requested hostname even when connecting to the local Caddy', async () => {
  const p = probe(),
    status = await p.promise;
  assert.equal(status.state, 'valid');
  assert.equal(status.managed, true);
  assert.equal(p.options.host, '127.0.0.1');
  assert.equal(p.options.servername, 'panel.example.com');
  assert.equal(p.options.rejectUnauthorized, true);
  assert.ok(p.destroyed);
  assert.ok(
    p.options.checkServerIdentity('127.0.0.1', {
      subjectaltname: 'DNS:wrong.example.com',
    }),
  );
  assert.equal(
    p.options.checkServerIdentity('127.0.0.1', {
      subjectaltname: 'DNS:panel.example.com',
    }),
    undefined,
  );
  const ip = probe({ url: 'https://83.217.221.18' });
  await ip.promise;
  assert.equal(ip.options.servername, undefined);
  assert.equal(
    ip.options.checkServerIdentity('127.0.0.1', {
      subjectaltname: 'IP Address:83.217.221.18',
    }),
    undefined,
  );
  assert.ok(
    ip.options.checkServerIdentity('127.0.0.1', {
      subjectaltname: 'IP Address:127.0.0.1',
    }),
  );
});
test('TLS status distinguishes local access, near expiry, failed validation and unresponsive proxies', async () => {
  assert.deepEqual(await certificateStatus('http://127.0.0.1:8788'), {
    enabled: false,
    managed: false,
    state: 'local',
  });
  assert.equal(
    (await probe({ expiry: Date.now() + 3600000 }).promise).state,
    'expiring',
  );
  for (const options of [{ error: true }, { timeout: true }]) {
    const p = probe(options);
    assert.equal((await p.promise).state, 'unavailable');
    assert.ok(p.destroyed);
  }
  const external = probe({
    managed: false,
    url: 'https://external.example.com:8443',
  });
  await external.promise;
  assert.equal(external.options.host, 'external.example.com');
  assert.equal(external.options.port, 8443);
});
