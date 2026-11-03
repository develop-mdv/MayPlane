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
