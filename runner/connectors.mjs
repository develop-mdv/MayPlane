import { randomBytes, randomUUID } from 'node:crypto';
import { resourceMetrics, metricSample } from '../lib/machine-metrics.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { assert, equal } from './security.mjs';
import { projectPath } from './machine-process.mjs';

export function attachConnectors(server, store) {
  const peers = new Map(),
    pairing = new Map(),
    tickets = new Map();
  let closed = false;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  const send = (socket, data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  };
  const upgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/api/connector')
      return;
    const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const pair = pairing.get(key);
    const machine =
      pair && pair.expires > Date.now()
        ? null
        : store
            .list('servers')
            .filter((s) => s.transport === 'connector')
            .find((s) =>
              equal(store.get('servers', s.id)?.secret.connectorToken, key),
            );
    if (
      key.length < 24 ||
      req.headers.origin ||
      (!machine && (!pair || pair.expires <= Date.now()))
    ) {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    if (pair) pairing.delete(key);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = machine?.id || randomUUID();
      const token = machine ? null : randomBytes(32).toString('base64url');
      const peer = { ws, streams: new Map(), alive: true, id };
      const previous = peers.get(id);
      if (previous) {
        for (const stream of previous.streams.values())
          stream.events.emit(
            'error',
            new Error('Подключение заменено другим коннектором'),
          );
        previous.streams.clear();
        previous.ws.close(4009, 'Подключение заменено');
      }
      peers.set(id, peer);
      if (!machine)
        store.save(
          'servers',
          {
            id,
            name: pair.name,
            transport: 'connector',
            host: '',
            port: 0,
            username: '',
            region: 'Личный компьютер',
            status: 'offline',
            platform: 'unknown',
            cpu: null,
            memory: null,
            disk: null,
            specs: 'Ожидаем сведения',
          },
          { connectorToken: token },
        );
      send(ws, { type: 'paired', machineId: id, ...(token ? { token } : {}) });
      if (pair) {
        pair.status = 'paired';
        pair.machineId = id;
      }
      ws.on('pong', () => {
        peer.alive = true;
      });
      ws.on('message', (raw) => {
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          ws.close(1008);
          return;
        }
        if (closed) return;
        if (
          data.type === 'metrics' &&
          data.metrics &&
          typeof data.metrics === 'object'
        ) {
          const s = store.get('servers', id);
          if (!s) return ws.close();
          const m = data.metrics;
          Object.assign(s, {
            ...resourceMetrics(m),
            status: 'online',
            platform: ['linux', 'darwin', 'win32'].includes(m.platform)
              ? m.platform
              : 'unknown',
            specs: String(m.specs || '').slice(0, 200),
            ipv4: String(m.ipv4 || '').slice(0, 64),
            ipv6: String(m.ipv6 || '').slice(0, 64),
            uptime: Number.isFinite(m.uptime) ? m.uptime : null,
            networkRx:
              Number.isFinite(m.networkRx) && m.networkRx >= 0
                ? m.networkRx
                : null,
            networkTx:
              Number.isFinite(m.networkTx) && m.networkTx >= 0
                ? m.networkTx
                : null,
            checkedAt: new Date().toISOString(),
            hostname: String(m.hostname || '').slice(0, 200),
            username: String(m.username || '').slice(0, 200),
          });
          if (typeof m.homePath === 'string') {
            try {
              s.homePath = projectPath(m.homePath, s.platform);
            } catch {
              /* Ignore invalid connector metadata. */
            }
          }
          s.history = [...(s.history || []), metricSample(s)].slice(-120);
          store.save('servers', s);
        }
        const stream = peer.streams.get(data.id);
        if (!stream) return;
        if (data.type === 'stdout' || data.type === 'stderr')
          stream[data.type].write(
            Buffer.from(String(data.data || ''), 'base64'),
          );
        if (data.type === 'exit') {
          stream.events.emit('close', data.code);
          stream.stdout.end();
          stream.stderr.end();
          peer.streams.delete(data.id);
        }
        if (data.type === 'process-error') {
          stream.events.emit(
            'error',
            new Error('Не удалось запустить агент на компьютере'),
          );
          peer.streams.delete(data.id);
        }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        if (closed || peers.get(id) !== peer) return;
        peers.delete(id);
        const s = store.get('servers', id);
        if (s) {
          s.status = 'offline';
          store.save('servers', s);
        }
        for (const stream of peer.streams.values())
          stream.events.emit('error', new Error('Компьютер отключился'));
        peer.streams.clear();
      });
    });
  };
  server.on('upgrade', upgrade);
  const timer = setInterval(() => {
    for (const [key, p] of pairing)
      if (p.expires < Date.now()) pairing.delete(key);
    for (const [id, p] of tickets)
      if (p.expires + 300000 < Date.now()) tickets.delete(id);
    for (const peer of peers.values()) {
      if (!peer.alive) peer.ws.terminate();
      else {
        peer.alive = false;
        peer.ws.ping();
      }
    }
  }, 15000);
  timer.unref();
  return {
    pair(name) {
      assert(pairing.size < 16, 'Слишком много кодов подключения', 429);
      assert(
        typeof name === 'string' && name.trim() && name.length <= 64,
        'Укажите имя компьютера',
      );
      const code = randomBytes(24).toString('base64url');
      const ticket = {
        id: randomUUID(),
        name: name.trim(),
        expires: Date.now() + 300000,
        status: 'pending',
      };
      pairing.set(code, ticket);
      tickets.set(ticket.id, ticket);
      return {
        code,
        expiresIn: 300,
        pairingId: ticket.id,
        expiresAt: ticket.expires,
      };
    },
    pairStatus(id, cancel = false) {
      const ticket = tickets.get(id);
      assert(ticket, 'Подключение не найдено или истекло', 404);
      if (
        ticket.status === 'pending' &&
        (cancel || ticket.expires <= Date.now())
      ) {
        ticket.status = cancel ? 'cancelled' : 'expired';
        for (const [key, value] of pairing)
          if (value === ticket) pairing.delete(key);
      }
      return {
        status: ticket.status,
        machineId: ticket.machineId || null,
        expiresAt: ticket.expires,
      };
    },
    connected: (id) => peers.has(id),
    revoke(id) {
      peers.get(id)?.ws.close(1000, 'Доступ отозван');
    },
    async open(id, options) {
      const peer = peers.get(id);
      assert(peer, 'Компьютер отключён. Запустите коннектор.', 409);
      assert(
        peer.streams.size < 12,
        'Достигнут лимит процессов на компьютере',
        429,
      );
      const processId = randomUUID();
      const stream = {
        input: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        events: new EventEmitter(),
        close: () => {
          send(peer.ws, { type: 'kill', id: processId });
          peer.streams.delete(processId);
        },
      };
      stream.input.on('data', (chunk) =>
        send(peer.ws, {
          type: 'stdin',
          id: processId,
          data: chunk.toString('base64'),
        }),
      );
      peer.streams.set(processId, stream);
      send(peer.ws, { type: 'spawn', id: processId, ...options });
      return stream;
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      server.off('upgrade', upgrade);
      for (const p of peers.values()) p.ws.terminate();
      peers.clear();
      wss.close();
    },
  };
}
