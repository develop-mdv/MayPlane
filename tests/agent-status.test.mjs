import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { agentVersion } from '../runner/agent-status.mjs';

function processFixture(onStart) {
  const p = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    events: new EventEmitter(),
    closed: false,
    close() {
      this.closed = true;
    },
  };
  setImmediate(() => onStart(p));
  return p;
}
test('version probe detects native agents, reports missing executables, redacts diagnostics and closes timed out processes', async () => {
  const machine = { secret: { password: 'private-test-value' } };
  const valid = processFixture((p) => {
    p.stdout.write('codex-cli 0.166.0\n');
    p.events.emit('close', 0);
  });
  assert.deepEqual(
    await agentVersion(machine, 'codex', async () => valid, null),
    { installed: true, version: 'codex-cli 0.166.0' },
  );
  assert.ok(valid.closed);
  const missing = processFixture((p) => {
    p.stderr.write('codex: not found private-test-value');
    p.events.emit('close', 127);
  });
  const absent = await agentVersion(
    machine,
    'codex',
    async () => missing,
    null,
  );
  assert.equal(absent.missing, true);
  assert.ok(!absent.error.includes('private-test-value'));
  const broken = processFixture((p) => {
    p.stderr.write('Bad executable format');
    p.events.emit('close', 126);
  });
  const failure = await agentVersion(
    machine,
    'codex',
    async () => broken,
    null,
  );
  assert.equal(failure.missing, false);
  assert.match(failure.error, /Bad executable/);
  const dependency = processFixture((p) => {
    p.stderr.write("env: 'node': No such file or directory");
    p.events.emit('close', 127);
  });
  assert.equal(
    (await agentVersion(machine, 'codex', async () => dependency, null))
      .missing,
    false,
  );
  const offline = await agentVersion(
    machine,
    'codex',
    async () => {
      throw new Error('SSH unavailable');
    },
    null,
  );
  assert.equal(offline.missing, false);
  assert.match(offline.error, /SSH unavailable/);
  const stalled = processFixture(() => {});
  const timeout = await agentVersion(
    machine,
    'codex',
    async () => stalled,
    null,
    20,
  );
  assert.equal(timeout.installed, false);
  assert.match(timeout.error, /не ответил/);
  assert.ok(stalled.closed);
});
