import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import { createEngine } from '../runner/engine.mjs';

for (const scenario of [
  'success',
  'target_start_failed',
  'target_stop_unknown',
  'external_mount',
])
  test(`migration transaction: ${scenario}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ezdeploy-migration-'));
    const store = openStore(dir, randomBytes(32));
    const sid = randomUUID(),
      tid = randomUUID(),
      pid = randomUUID();
    const commands = [];
    const copies = [];
    t.after(() => {
      store.close();
      assert.ok(
        resolve(dir).startsWith(resolve(tmpdir()) + '\\') ||
          resolve(dir).startsWith(resolve(tmpdir()) + '/'),
      );
      rmSync(dir, { recursive: true, force: true });
    });
    for (const id of [sid, tid])
      store.save(
        'servers',
        { id, name: id, status: 'online' },
        { password: 'example-secret' },
      );
    store.save(
      'projects',
      {
        id: pid,
        name: 'sample',
        serverId: sid,
        status: 'running',
        composeFile: 'compose.yaml',
        updatedAt: new Date().toISOString(),
      },
      { env: 'TOKEN=secret-value' },
    );
    const engine = createEngine(store, {
      connect: async (s) => ({ id: s.id, end() {} }),
      copyFile: async (a, b, path) => copies.push(path),
      run: async (c, script) => {
        commands.push({ server: c.id, script });
        if (script === 'uname -m') return 'x86_64\n';
        if (script.includes('config --format json'))
          return JSON.stringify({
            services: {
              app: {
                volumes:
                  scenario === 'external_mount'
                    ? [{ type: 'bind', source: '/var/lib/external' }]
                    : [],
              },
            },
          });
        if (script.includes('ps -aq')) return 'container-123\n';
        if (script.startsWith('docker inspect'))
          return JSON.stringify([
            { Config: { Image: `ez_${pid}-app:latest` } },
          ]);
        if (
          c.id === tid &&
          script.includes('up -d --no-build') &&
          scenario !== 'success'
        )
          throw new Error('Target unhealthy');
        if (
          c.id === tid &&
          script.includes('stop --timeout') &&
          scenario === 'target_stop_unknown'
        )
          throw new Error('Connection lost');
        return '';
      },
    });
    const job = engine.enqueue('migration', { projectId: pid, target: tid });
    assert.throws(
      () => engine.enqueue('deploy', { projectId: pid }),
      /уже выполняется/,
    );
    await engine.drain();
    const p = store.get('projects', pid);
    const result = store.get('jobs', job.id);
    const restarted = commands.some(
      (c) => c.server === sid && c.script.includes('up -d --no-build'),
    );
    if (scenario === 'success') {
      assert.equal(p.serverId, tid);
      assert.equal(p.status, 'running');
      assert.equal(result.status, 'success');
      assert.equal(restarted, false);
      assert.equal(copies.length, 2);
      assert.ok(
        commands.some(
          (c) =>
            c.script.includes('docker image save') &&
            c.script.includes(`ez_${pid}-app:latest`),
        ),
      );
    } else if (scenario === 'target_start_failed') {
      assert.equal(p.serverId, sid);
      assert.equal(p.status, 'running');
      assert.equal(result.status, 'failed');
      assert.ok(restarted);
    } else if (scenario === 'target_stop_unknown') {
      assert.equal(p.serverId, sid);
      assert.equal(p.status, 'stopped');
      assert.equal(restarted, false);
      assert.match(result.logs.join('\n'), /Автовозврат отключён/);
    } else {
      assert.equal(result.status, 'failed');
      assert.equal(p.status, 'running');
      assert.equal(copies.length, 0);
      assert.ok(!commands.some((c) => c.script.includes('stop --timeout')));
    }
  });
