import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  claudeLoginUrl,
  claudeAdapterEntry,
  localClaudeCommand,
} from '../lib/claude-runtime.mjs';
import { processSpec } from '../runner/machine-process.mjs';
import { claudeStatus } from '../runner/agent-status.mjs';
import { posixAgentCommand } from '../runner/agent-launch.mjs';

test('Claude login only links complete official OAuth URLs, including terminal hyperlinks', () => {
  const url =
    'https://claude.com/cai/oauth/authorize?client_id=fixture&code_challenge=challenge&state=state';
  assert.equal(claudeLoginUrl(url), null, 'wait for the final URL bytes');
  assert.equal(claudeLoginUrl(`Open ${url}\r\n`), url);
  assert.equal(
    claudeLoginUrl(`\x1b]8;;${url}\x1b\\sign in\x1b]8;;\x1b\\`),
    url,
  );
  for (const invalid of [
    url.replace('claude.com', 'claude.com.attacker.test'),
    url.replace('https:', 'http:'),
    url.replace('client_id=', 'other='),
    url.replace('/oauth/authorize', '/redirect'),
  ])
    assert.equal(claudeLoginUrl(invalid + '\n'), null);
});

test('Claude operations resolve the installed SDK CLI and keep fixed commands separate from arbitrary shell input', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mayplane-claude-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const entry = claudeAdapterEntry(home);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '');
  const options = { home, platform: 'win32', node: '/node' };
  assert.deepEqual(localClaudeCommand('agent', [], options).args, [entry]);
  assert.deepEqual(
    localClaudeCommand('login', ['auth', 'login'], options).args,
    [entry, '--cli', 'auth', 'login'],
  );
  assert.deepEqual(processSpec('claude', 'logout', 'linux').args, [
    'auth',
    'logout',
  ]);
  assert.equal(
    processSpec('claude', 'agent', 'win32').executable,
    'claude-agent-acp',
  );
  assert.match(
    processSpec('claude', 'install', 'win32').args[0],
    /claude-install\.mjs$/,
  );
  assert.throws(() => processSpec('claude', 'exec arbitrary'));
  assert.throws(() => processSpec('opencode', 'auth-status'));
  assert.deepEqual(processSpec('claude', 'login', 'linux').args, [
    'auth',
    'login',
    '--claudeai',
  ]);
  const login = posixAgentCommand('claude', 'login', ['auth', 'login']);
  assert.match(login, /env BROWSER=true 'claude' 'auth' 'login'/);
  assert.doesNotMatch(login, /skip-permissions|bypassPermissions/);
});

test('Claude status distinguishes native CLI, ACP installation and selected authentication without returning tokens', async () => {
  const calls = [];
  let adapter = false,
    loggedIn = false;
  const openProcess = async (_machine, { operation }) => {
    calls.push(operation);
    const events = new EventEmitter(),
      stdout = new PassThrough(),
      stderr = new PassThrough();
    setImmediate(() => {
      stdout.write(
        operation === 'version'
          ? 'Claude Code fixture'
          : operation === 'adapter-version'
            ? 'ACP fixture'
            : JSON.stringify({
                loggedIn,
                authMethod: 'claude.ai',
                email: 'owner@example.test',
                accessToken: 'never-return-this',
              }),
      );
      events.emit('close', operation === 'adapter-version' && !adapter ? 1 : 0);
    });
    return { events, stdout, stderr, close() {} };
  };
  const missing = await claudeStatus({}, openProcess);
  assert.equal(missing.installed, true);
  assert.equal(missing.ready, false);
  assert.match(missing.error, /адаптер/);
  adapter = true;
  const unsigned = await claudeStatus({}, openProcess);
  assert.equal(unsigned.ready, false);
  loggedIn = true;
  const native = await claudeStatus({}, openProcess);
  assert.equal(native.ready, true);
  assert.equal(native.account.email, 'owner@example.test');
  assert.ok(!JSON.stringify(native).includes('never-return-this'));
  calls.length = 0;
  const api = await claudeStatus({}, openProcess, null, { id: 'api-account' });
  assert.equal(api.ready, true);
  assert.equal(api.account.type, 'api_key');
  assert.ok(!calls.includes('auth-status'));
});

const bash =
  process.platform === 'win32'
    ? join(
        process.env.ProgramFiles || 'C:\\Program Files',
        'Git',
        'bin',
        'bash.exe',
      )
    : '/bin/bash';
test(
  'Claude POSIX installer provisions a checksum-verified private runtime without modifying native login or sourcing shell profiles',
  { skip: !existsSync(bash) },
  (t) => {
    const home = mkdtempSync(join(tmpdir(), 'mayplane claude install '));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    for (const dir of ['fake-bin', '.local/bin', 'payload/bin'])
      mkdirSync(join(home, dir), { recursive: true });
    const file = (path, body) =>
      writeFileSync(join(home, path), body, { mode: 0o755 });
    file('.local/bin/claude', '#!/bin/sh\necho "Claude native fixture"\n');
    file('.bashrc', 'touch "$HOME/profile-was-sourced"\n');
    file('fake-bin/node', '#!/bin/sh\nexit 1\n');
    file(
      'fake-bin/uname',
      '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
    );
    file('payload/bin/node', '#!/bin/sh\necho "Claude ACP fixture"\n');
    file(
      'payload/bin/npm',
      `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$HOME/npm-args"
test "$1" = install && test "$2" = --prefix
mkdir -p "$3/node_modules/@agentclientprotocol/claude-agent-acp/dist"
touch "$3/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
`,
    );
    file(
      'fake-bin/curl',
      `#!/bin/sh
set -eu
for arg in "$@"; do case "$arg" in https://*) url="$arg";; esac; done
while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; output="$1"; break; fi; shift; done
case "$url" in */SHASUMS256.txt) cp "$HOME/sums" "$output";; */node-v24.1.2-linux-x64.tar.gz) cp "$HOME/archive" "$output";; *) exit 91;; esac
`,
    );
    const invoke = (script) =>
      spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home.replaceAll('\\', '/'),
          PATH: '/usr/bin:/bin',
        },
      });
    const packed = invoke(
      'cd "$HOME" && tar -czf archive payload && hash=$(sha256sum archive | cut -d" " -f1) && printf "%s  node-v24.1.2-linux-x64.tar.gz\\n" "$hash" > sums',
    );
    assert.equal(packed.status, 0, packed.stderr);
    const install = invoke(
      'export PATH="$HOME/fake-bin:$PATH"\n' +
        posixAgentCommand('claude', 'install', []),
    );
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /Claude ACP fixture/);
    assert.match(
      readFileSync(join(home, 'npm-args'), 'utf8'),
      /--ignore-scripts/,
    );
    assert.equal(existsSync(join(home, 'profile-was-sourced')), false);
    assert.equal(
      readFileSync(join(home, '.local/bin/claude'), 'utf8'),
      '#!/bin/sh\necho "Claude native fixture"\n',
    );
    file('archive', 'tampered archive');
    const tampered = invoke(
      'export PATH="$HOME/fake-bin:$PATH"\n' +
        posixAgentCommand('claude', 'install', []),
    );
    assert.notEqual(
      tampered.status,
      0,
      'checksum failure must abort installation',
    );
  },
);
