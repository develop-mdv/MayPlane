import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test(
  'Linux migration worker preserves real data, metadata and SQLite integrity',
  { timeout: 120000 },
  () => {
    const path = fileURLToPath(
      new URL('./migration_host_test.py', import.meta.url),
    );
    let output;
    if (process.platform === 'win32') {
      const linuxPath = execFileSync(
        'wsl.exe',
        ['-d', 'Ubuntu', '--exec', 'wslpath', '-a', path.replaceAll('\\', '/')],
        { encoding: 'utf8' },
      ).trim();
      output = execFileSync(
        'wsl.exe',
        ['-d', 'Ubuntu', '--exec', 'python3', '-B', linuxPath],
        {
          encoding: 'utf8',
          timeout: 110000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } else {
      output = execFileSync('python3', ['-B', path], {
        encoding: 'utf8',
        timeout: 110000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    assert.equal(output.trim(), '');
  },
);
