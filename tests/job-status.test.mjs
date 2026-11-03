import test from 'node:test';
import assert from 'node:assert/strict';
import { jobStatus } from '../lib/job-actions.mjs';
test('log status distinguishes ongoing work from terminal outcomes', () => {
  for (const status of ['pending', 'deploying'])
    assert.equal(jobStatus({ status }).active, true);
  assert.equal(
    jobStatus({ status: 'deploying', cancelRequested: true }).label,
    'Прерывается',
  );
  assert.deepEqual(jobStatus({ status: 'success' }), {
    label: 'Завершено',
    active: false,
  });
  assert.deepEqual(jobStatus({ status: 'failed' }), {
    label: 'Завершено с ошибкой',
    active: false,
  });
  assert.deepEqual(jobStatus({ status: 'failed', outcome: 'cancelled' }), {
    label: 'Прервано',
    active: false,
  });
  assert.deepEqual(jobStatus({ status: 'needs_setup', outcome: 'limit' }), {
    label: 'Завершено · нужно продолжение',
    active: false,
  });
});
