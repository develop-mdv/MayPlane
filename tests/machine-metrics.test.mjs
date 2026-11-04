import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resourceMetrics,
  metricSample,
  resourceSummary,
  formatBytes,
  formatRate,
} from '../lib/machine-metrics.mjs';
import { parseMetricsOutput } from '../runner/ssh.mjs';
import { localMetrics } from '../runner/machine-process.mjs';

test('SSH metrics retain byte capacities, availability and CPU cores; malformed or missing data stays unknown', () => {
  const m = parseMetricsOutput(
    'CPU:25\nCORES:4\nMEM_TOTAL:4294967296\nMEM_USED:1073741824\nMEM_AVAILABLE:3221225472\nDISK_TOTAL:107374182400\nDISK_USED:53687091200\nDISK_AVAILABLE:48318382080\nDOCKER:yes\nRX:1024\nTX:2048\nUPTIME:100\nIPV4:192.0.2.1\n',
  );
  assert.equal(m.cpuCores, 4);
  assert.equal(m.memory, 25);
  assert.equal(m.disk, 50);
  assert.equal(m.diskAvailableBytes, 48318382080); // Reserved blocks are not called available.
  assert.equal(m.status, 'online');
  assert.equal(resourceSummary(m, 'cpu'), '1 из 4 vCPU');
  assert.equal(resourceSummary(m, 'memory'), '1 из 4 ГиБ');
  const sample = metricSample(m);
  assert.equal(sample.memoryTotalBytes, m.memoryTotalBytes);
  assert.equal(sample.diskUsedBytes, m.diskUsedBytes);
  assert.equal(sample.cpuCores, m.cpuCores);
  assert.equal(sample.uptime, 100);
  const missing = parseMetricsOutput(
    'CPU:NaN\nCORES:-4\nMEM_TOTAL:0\nDISK_TOTAL:bad\n',
  );
  for (const name of [
    'cpu',
    'cpuCores',
    'memory',
    'disk',
    'memoryTotalBytes',
    'diskUsedBytes',
  ])
    assert.equal(missing[name], null, name);
});

test('legacy and untrusted connector measurements cannot invent capacities or exceed valid numeric ranges', () => {
  const old = resourceMetrics({
    cpu: 120,
    memory: -3,
    disk: Infinity,
    specs: '8 GB RAM',
  });
  assert.equal(old.cpu, 100);
  assert.equal(old.memory, 0);
  assert.equal(old.disk, null);
  assert.equal(old.memoryTotalBytes, null);
  assert.equal(old.memoryUsedBytes, null);
  const bad = resourceMetrics({
    cpuCores: 1.5,
    memoryTotalBytes: 10,
    memoryUsedBytes: 11,
    diskTotalBytes: '100',
    diskUsedBytes: 5,
  });
  assert.equal(bad.cpuCores, null);
  assert.equal(bad.memoryUsedBytes, null);
  assert.equal(bad.diskTotalBytes, null);
  assert.equal(bad.diskUsedBytes, null);
  assert.equal(formatBytes(0), '0 Б');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatRate(1024), '1 МиБ/с');
  assert.equal(formatRate(null), '—');
});

test('panel host measures real capacities and persists internally consistent available and used bytes', () => {
  const m = localMetrics();
  assert.ok(m.cpuCores > 0);
  assert.ok(m.memoryTotalBytes > 0);
  assert.equal(m.memoryUsedBytes + m.memoryAvailableBytes, m.memoryTotalBytes);
  assert.ok(m.memory >= 0 && m.memory <= 100);
  if (m.diskTotalBytes != null) {
    assert.ok(m.diskTotalBytes > 0);
    assert.ok(m.diskUsedBytes <= m.diskTotalBytes);
    assert.ok(m.diskAvailableBytes <= m.diskTotalBytes);
  }
});
