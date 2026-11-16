import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  claudeAcpPackage,
  claudeAdapterEntry,
} from '../lib/claude-runtime.mjs';

// Windows/connector installation: no global npm prefix or administrator access.
const prefix = dirname(
  dirname(dirname(dirname(dirname(claudeAdapterEntry())))),
);
await mkdir(prefix, { recursive: true, mode: 0o700 });
const { join } = await import('node:path');
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const child = spawn(
  process.execPath,
  [
    npm,
    'install',
    '--prefix',
    prefix,
    '--no-save',
    '--ignore-scripts',
    '--include=optional',
    '--no-audit',
    '--no-fund',
    claudeAcpPackage,
  ],
  { stdio: 'inherit', windowsHide: true },
);
child.on('error', () => {
  console.error('Не удалось запустить npm для установки Claude Code.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
