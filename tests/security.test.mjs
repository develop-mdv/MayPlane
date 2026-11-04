import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  seal,
  unseal,
  envEntries,
  redact,
  projectInput,
  serverInput,
  validateMigrationConfig,
  q,
} from '../runner/security.mjs';
test('encrypted secrets round trip and tamper detection', () => {
  const key = randomBytes(32);
  const encrypted = seal('secret-root-password', key);
  assert.equal(unseal(encrypted, key), 'secret-root-password');
  assert.ok(!encrypted.includes('secret-root-password'));
  const damaged = Buffer.from(encrypted, 'base64');
  damaged[30] ^= 1;
  assert.throws(() => unseal(damaged.toString('base64'), key));
  assert.throws(() => unseal(encrypted, randomBytes(32)));
});
test('env parsing preserves equals and quoted hashes and rejects malformed input', () => {
  assert.deepEqual(
    envEntries('# note\nTOKEN="a=b#c"\nexport PORT=3000\nEMPTY=\n'),
    [
      ['TOKEN', 'a=b#c'],
      ['PORT', '3000'],
      ['EMPTY', ''],
    ],
  );
  assert.throws(() => envEntries('SECRET=one\nSECRET=two'));
  assert.throws(() => envEntries('TOKEN="line\nmore"'));
  assert.throws(() => envEntries('broken'));
  assert.throws(() => envEntries('X=' + 'x'.repeat(65536)));
});
test('redaction handles overlapping values and ANSI output', () => {
  assert.equal(
    redact('\x1b[31mabc-secret, abc\x1b[0m', ['abc', 'abc-secret']),
    '[REDACTED], [REDACTED]',
  );
});
const base = {
  name: 'my-project',
  repo: 'https://github.com/example/app.git',
  branch: 'main',
  composeFile: 'compose.yaml',
  kind: 'web',
  serverId: 's1',
};
test('project validation rejects credential-bearing URLs and path traversal', () => {
  assert.equal(projectInput(base).branch, 'main');
  for (const change of [
    { repo: 'https://token@github.com/u/r' },
    { repo: 'file:///etc/passwd' },
    { composeFile: '../../compose.yml' },
    { branch: 'main; rm -rf /' },
    { branch: 'a..b' },
    { name: '../../other' },
  ])
    assert.throws(() => projectInput({ ...base, ...change }));
});
test('SSH input and shell quoting resist injected commands', () => {
  assert.equal(
    serverInput({ name: 'prod', host: '127.0.0.1', username: 'root' }).port,
    22,
  );
  assert.throws(() =>
    serverInput({ name: 'prod', host: '1.1.1.1;whoami', username: 'root' }),
  );
  assert.equal(q("foo'bar"), "'foo'\\''bar'");
});
test('migration rejects data outside the project and external resources', () => {
  const root = '/opt/mayplane/p1';
  const safe = {
    services: {
      app: { volumes: [{ type: 'bind', source: root + '/repo/data' }] },
    },
    volumes: { db: {} },
  };
  assert.doesNotThrow(() => validateMigrationConfig(safe, root));
  for (const source of [
    '/var/lib/postgres',
    root + '/../other',
    root + '-other/data',
  ])
    assert.throws(() =>
      validateMigrationConfig(
        { services: { app: { volumes: [{ type: 'bind', source }] } } },
        root,
      ),
    );
  for (const volumes of [
    { db: { external: true } },
    { db: { driver: 'nfs' } },
    { db: { driver_opts: { device: '/secret' } } },
  ])
    assert.throws(() => validateMigrationConfig({ ...safe, volumes }, root));
  assert.throws(() =>
    validateMigrationConfig(
      { ...safe, networks: { external: { external: true } } },
      root,
    ),
  );
  assert.throws(() =>
    validateMigrationConfig(
      { services: { db: { volumes: [{ type: 'volume' }] } } },
      root,
    ),
  );
});
