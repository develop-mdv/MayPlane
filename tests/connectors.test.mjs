import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';

test('outbound connector pairs once, authenticates reconnect, clamps metrics, isolates processes and revokes access', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ezdeploy-connectors-')),
    store = openStore(directory, randomBytes(32)),
    token = randomBytes(32).toString('hex');
  const { server, hub } = createApp({ store, token, engine: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`,
    url = base.replace('http:', 'ws:') + '/api/connector';
  const peers = [];
  t.after(async () => {
    for (const p of peers) p.terminate();
    hub.close();
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, body) =>
    fetch(base + '/api/hub' + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const pair = await (await request('/pair', { name: 'Home PC' })).json();
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${pair.code}` },
  });
  peers.push(ws);
  const [message] = await once(ws, 'message'),
    paired = JSON.parse(message.toString());
  assert.equal(paired.type, 'paired');
  assert.ok(paired.token);
  assert.ok(!JSON.stringify(store.snapshot()).includes(paired.token));
  ws.send(
    JSON.stringify({
      type: 'metrics',
      metrics: {
        platform: 'win32',
        cpu: 200,
        memory: -3,
        disk: 42,
        specs: '8 CPU · Windows',
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 40));
  const m = store.get('servers', paired.machineId);
  assert.equal(m.cpu, 100);
  assert.equal(m.memory, 0);
  assert.equal(m.status, 'online');
  async function rejected(key, origin) {
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        ...(origin ? { Origin: origin } : {}),
      },
    });
    peers.push(socket);
    socket.on('error', () => {});
    const [req, response] = await once(socket, 'unexpected-response');
    assert.equal(response.statusCode, 403);
    response.resume();
    socket.terminate();
  }
  await rejected(pair.code);
  await rejected(paired.token, 'https://evil.example');
  const process = await hub.connectors.open(paired.machineId, {
    provider: 'codex',
    operation: 'agent',
    cwd: 'D:\\project',
  });
  process.events.on('error', () => {});
  const [spawn] = await once(ws, 'message'),
    instruction = JSON.parse(spawn.toString());
  assert.equal(instruction.type, 'spawn');
  assert.equal(instruction.provider, 'codex');
  assert.equal(instruction.cwd, 'D:\\project');
  const output = once(process.stdout, 'data');
  ws.send(
    JSON.stringify({
      type: 'stdout',
      id: instruction.id,
      data: Buffer.from('hello').toString('base64'),
    }),
  );
  assert.equal((await output)[0].toString(), 'hello');
  ws.close();
  await once(ws, 'close');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.get('servers', paired.machineId).status, 'offline');
  const again = new WebSocket(url, {
    headers: { Authorization: `Bearer ${paired.token}` },
  });
  peers.push(again);
  const [reconnected] = await once(again, 'message');
  assert.equal(JSON.parse(reconnected.toString()).machineId, paired.machineId);
  assert.equal(
    (await request(`/machines/${paired.machineId}/revoke`, {})).status,
    200,
  );
  await once(again, 'close');
  await rejected(paired.token);
});
