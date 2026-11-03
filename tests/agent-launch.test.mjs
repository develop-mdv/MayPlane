import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { posixAgentCommand } from '../runner/agent-launch.mjs';

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
  'non-interactive native install is found without npm or sourcing a profile; reinstall is idempotent',
  { skip: !existsSync(bash) },
  (t) => {
    const home = mkdtempSync(join(tmpdir(), 'ez-agent-path-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, '.opencode', 'bin'), { recursive: true });
    const executable = join(home, '.opencode', 'bin', 'opencode');
    const original = '#!/bin/sh\nprintf "1.19.5\\n"\n';
    writeFileSync(executable, original, { mode: 0o755 });
    writeFileSync(join(home, '.bashrc'), 'touch "$HOME/profile-was-sourced"\n');
    const invoke = (operation, cwd) =>
      spawnSync(
        bash,
        [
          '--noprofile',
          '--norc',
          '-c',
          posixAgentCommand('opencode', operation, ['--version'], cwd),
        ],
        {
          env: {
            ...process.env,
            HOME: home.replaceAll('\\', '/'),
            PATH: '/usr/bin:/bin',
          },
          encoding: 'utf8',
        },
      );
    const version = invoke('version');
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), '1.19.5');
    const install = invoke('install');
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /уже установлен/);
    assert.equal(readFileSync(executable, 'utf8'), original);
    assert.equal(existsSync(join(home, 'profile-was-sourced')), false);
    const missing = invoke(
      'agent',
      '/ezdeploy-definitely-missing-test-directory',
    );
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, '');
  },
);

test(
  'Codex native installer needs no npm, repairs a Node shim and resolves version, login and app-server from a clean PATH',
  { skip: !existsSync(bash) },
  (t) => {
    const home = mkdtempSync(join(tmpdir(), 'ez codex native '));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, 'fake-bin'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'bin', 'codex'),
      '#!/usr/bin/env missing-node-for-test\n',
      { mode: 0o755 },
    );
    writeFileSync(join(home, '.bashrc'), 'touch "$HOME/profile-was-sourced"\n');
    writeFileSync(
      join(home, 'fake-bin', 'curl'),
      `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/curl-args"
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; cp "$HOME/mock-installer" "$1"; exit; fi
  shift
done
exit 1
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(home, 'mock-installer'),
      `#!/bin/sh
set -eu
test "$CODEX_NON_INTERACTIVE" = 1
test "$CODEX_INSTALL_DIR" = "$HOME/.local/bin"
mkdir -p "$CODEX_INSTALL_DIR"
printf '#!/bin/sh\\nif [ "$1" = "--version" ]; then echo "codex-cli fixture"; else printf "%%s\\\\n" "$*"; fi\\n' > "$CODEX_INSTALL_DIR/codex"
chmod +x "$CODEX_INSTALL_DIR/codex"
`,
    );
    const invoke = (operation, args = []) =>
      spawnSync(
        bash,
        [
          '--noprofile',
          '--norc',
          '-c',
          'export PATH="$HOME/fake-bin:$PATH"\n' +
            posixAgentCommand('codex', operation, args),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home.replaceAll('\\', '/'),
            PATH: '/usr/bin:/bin',
          },
        },
      );
    assert.notEqual(invoke('version', ['--version']).status, 0);
    for (let i = 0; i < 2; i++) {
      const installed = invoke('install');
      assert.equal(installed.status, 0, installed.stderr);
      assert.match(installed.stdout, /codex-cli fixture/);
    }
    assert.match(invoke('version', ['--version']).stdout, /codex-cli fixture/);
    assert.match(
      invoke('login', ['login', '--device-auth']).stdout,
      /login --device-auth/,
    );
    assert.match(
      invoke('agent', ['app-server', '--listen', 'stdio://']).stdout,
      /app-server --listen stdio:\/\//,
    );
    assert.match(
      readFileSync(join(home, 'curl-args'), 'utf8'),
      /https:\/\/chatgpt.com\/codex\/install.sh/,
    );
    assert.equal(existsSync(join(home, 'profile-was-sourced')), false);
  },
);
