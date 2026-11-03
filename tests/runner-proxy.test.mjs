import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { reserveRunnerUpgrades } from '../lib/runner-proxy.mjs';

test('runner WebSockets bypass the Worker catch-all while other upgrades still reach it', async () => {
  const http = createServer();
  let workerCalls = 0;
  http.on('upgrade', (_req, socket) => {
    workerCalls++;
    socket.destroy();
  });
  reserveRunnerUpgrades(http);
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/api/'))
      wss.handleUpgrade(req, socket, head, (ws) =>
        ws.on('message', (data) => ws.send(data)),
      );
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${http.address().port}`;
  let client;
  try {
    client = new WebSocket(base + '/api/servers/id/terminal');
    await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('open', () => client.send('terminal-data'));
      client.on('message', (data) => {
        assert.equal(data.toString(), 'terminal-data');
        resolve();
      });
    });
    assert.equal(workerCalls, 0);
    await new Promise((resolve) => {
      client.once('close', resolve);
      client.close();
    });
    client = new WebSocket(base + '/worker-stream');
    await new Promise((resolve) => client.once('error', resolve));
    assert.equal(workerCalls, 1);
  } finally {
    client?.terminate();
    wss.close();
    await new Promise((r) => http.close(r));
  }
});
