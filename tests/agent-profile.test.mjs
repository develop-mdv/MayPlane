import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { credentialBundle, authLink } from '../runner/account-brokers.mjs';
import {
  profileId,
  profilePaths,
  profileTransfer,
} from '../runner/agent-profile.mjs';

test('credential conversion retains native OAuth method and account metadata when a legacy server rotates tokens', () => {
  const original = credentialBundle('openai', [
    {
      id: 'cred_portable',
      integrationID: 'openai',
      active: true,
      value: {
        type: 'oauth',
        methodID: 'chatgpt-headless',
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 100,
        metadata: {
          accountId: 'work-account',
          enterpriseUrl: 'https://enterprise.example',
        },
      },
    },
  ]);
  const rotated = credentialBundle(
    'openai',
    {
      openai: {
        ...original.legacy.openai,
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 200,
      },
    },
    original,
  );
  assert.equal(rotated.native2[0].id, 'cred_portable');
  assert.equal(rotated.native2[0].value.methodID, 'chatgpt-headless');
  assert.equal(rotated.native2[0].value.refresh, 'new-refresh');
  assert.equal(rotated.native2[0].value.metadata.accountId, 'work-account');
  assert.equal(
    rotated.native2[0].value.metadata.enterpriseUrl,
    'https://enterprise.example',
  );
  assert.throws(() =>
    credentialBundle('openai', [
      { integrationID: 'openai', value: { type: 'external' } },
    ]),
  );
  assert.throws(() => credentialBundle('openai', {}));
});

test('account profiles cannot traverse directories and provider login links require secure credential-free URLs', () => {
  const id = randomUUID();
  assert.equal(profileId(id), id);
  assert.ok(profilePaths('codex', id).auth.endsWith('auth.json'));
  for (const path of ['../auth.json', '../../' + id, id + '/..', '', null])
    assert.throws(() => profileId(path));
  assert.throws(() => profilePaths('../opencode', id));
  assert.equal(
    authLink('https://auth.openai.com/codex/device'),
    'https://auth.openai.com/codex/device',
  );
  for (const url of [
    'javascript:alert(1)',
    'http://auth.example/',
    'https://user:secret@auth.example/',
  ])
    assert.throws(() => authLink(url));
});

test('profile transfer uses stdin only and a closed input stream returns a private recoverable error', async () => {
  const input = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough(),
    events = new EventEmitter();
  let options,
    closed = 0,
    received = '';
  input.on('data', (chunk) => {
    received += chunk;
    setImmediate(() => input.emit('error', new Error('private-test-key')));
  });
  await assert.rejects(
    profileTransfer(
      async (_m, opts) => {
        options = opts;
        return {
          input,
          stdout,
          stderr,
          events,
          close() {
            closed++;
          },
        };
      },
      { id: 'test' },
      'codex',
      randomUUID(),
      'profile-write',
      null,
      { OPENAI_API_KEY: 'private-test-key' },
    ),
    (error) => {
      assert.ok(!error.message.includes('private-test-key'));
      return true;
    },
  );
  assert.equal(JSON.parse(received).OPENAI_API_KEY, 'private-test-key');
  assert.ok(!JSON.stringify(options).includes('private-test-key'));
  assert.equal(closed, 1);
});
