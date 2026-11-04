import test from 'node:test';
import assert from 'node:assert/strict';
import { networkRates } from '../lib/network-metrics.mjs';
test('network graph derives real rates and skips unavailable samples and resets', () => {
  const at = (n) => new Date(n * 1000).toISOString();
  const rates = networkRates([
    { at: at(0), networkRx: 1024, networkTx: 0 },
    { at: at(10), networkRx: 11264, networkTx: 20480 },
    { at: at(20), networkRx: 0, networkTx: null },
    { at: at(20), networkRx: 5120, networkTx: 0 },
  ]);
  assert.deepEqual(rates, [
    { rx: 1, tx: 2 },
    { rx: null, tx: null },
    { rx: null, tx: null },
  ]);
  assert.deepEqual(
    networkRates([
      { at: at(0), uptime: 100, networkRx: 0, networkTx: 0 },
      { at: at(10), uptime: 5, networkRx: 5000000, networkTx: 1000000 },
    ]),
    [{ rx: null, tx: null }],
  );
});
