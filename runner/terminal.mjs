import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { connect } from './ssh.mjs';
import { assert } from './security.mjs';

export function attachTerminals(
  server,
  {
    store,
    origins,
    openSsh = connect,
    now = Date.now,
    ticketTtl = 30000,
    idleMs = 30 * 60 * 1000,
    maxSessions = 8,
  },
) {
  const tickets = new Map();
  const sessions = new Set();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
    handleProtocols: () => 'mayplane-terminal',
  });
  const prune = () => {
    for (const [key, value] of tickets)
      if (value.expiresAt <= now()) tickets.delete(key);
  };
  function issue(serverId, origin) {
    prune();
    assert(
      origin && origins.includes(origin),
      'Откройте консоль из разрешённой веб-панели',
      403,
    );
    assert(store.get('servers', serverId), 'Сервер не найден', 404);
    assert(
      tickets.size < 32 && sessions.size < maxSessions,
      'Слишком много сеансов консоли. Закройте лишние вкладки.',
      429,
    );
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { serverId, origin, expiresAt: now() + ticketTtl });
    return { ticket, expiresIn: ticketTtl / 1000 };
  }
  const upgrade = (req, socket, head) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const match = path.match(/^\/api\/servers\/([a-f0-9-]+)\/terminal$/);
    const reject = (status) => {
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    if (!match) return;
    const protocols = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((v) => v.trim());
    const credential =
      protocols.length === 2 && protocols[0] === 'mayplane-terminal'
        ? protocols[1]
        : '';
    const entry = tickets.get(credential);
    if (
      !entry ||
      entry.expiresAt <= now() ||
      entry.serverId !== match[1] ||
      entry.origin !== req.headers.origin ||
      !origins.includes(req.headers.origin)
    )
      return reject('403 Forbidden');
    if (sessions.size >= maxSessions) return reject('429 Too Many Requests');
    const target = store.get('servers', entry.serverId);
    if (!target) return reject('404 Not Found');
    tickets.delete(credential);
    wss.handleUpgrade(req, socket, head, (ws) => start(ws, target));
  };
  function start(ws, target) {
    let client,
      channel,
      ended = false,
      lastInput = now(),
      alive = true,
      ptyStarted = false;
    const session = {
      serverId: target.id,
      close: (reason = 'Исполнитель остановлен') => close(1001, reason),
    };
    sessions.add(session);
    const control = (type, extra = {}) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type, ...extra }));
    };
    const cleanup = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      clearTimeout(deadline);
      channel?.destroy();
      client?.destroy();
      sessions.delete(session);
    };
    const close = (code = 1000, reason = 'Сеанс завершён') => {
      cleanup();
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
    };
    const fail = (message) => {
      control('error', { message });
      close(1011, 'Ошибка SSH');
    };
    const output = (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024)
        return fail('Вывод не успевает передаваться. Подключитесь повторно.');
      ws.send(data, { binary: true });
    };
    const timer = setInterval(
      () => {
        if (!alive) {
          cleanup();
          ws.terminate();
          return;
        }
        if (now() - lastInput > idleMs) {
          control('error', {
            message: 'Сеанс закрыт после 30 минут без ввода.',
          });
          close();
          return;
        }
        alive = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      },
      Math.min(15000, idleMs),
    );
    timer.unref();
    const deadline = setTimeout(
      () => {
        control('error', {
          message: 'Достигнут предел сеанса — 6 часов. Подключитесь снова.',
        });
        close();
      },
      6 * 60 * 60 * 1000,
    );
    deadline.unref();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    ws.on('message', (bytes, binary) => {
      if (ended) return;
      lastInput = now();
      if (binary) {
        if (channel && !channel.write(bytes))
          fail('Слишком быстрый ввод. Подключитесь повторно.');
        return;
      }
      let message;
      try {
        message = JSON.parse(bytes.toString());
      } catch {
        close(1008, 'Некорректное сообщение');
        return;
      }
      if (!message || typeof message !== 'object') {
        close(1008, 'Некорректное сообщение');
        return;
      }
      if (message.type === 'input' && typeof message.data === 'string') {
        if (channel && !channel.write(message.data))
          fail('Слишком быстрый ввод. Подключитесь повторно.');
      } else if (
        message.type === 'resize' &&
        Number.isInteger(message.cols) &&
        Number.isInteger(message.rows) &&
        message.cols >= 2 &&
        message.cols <= 500 &&
        message.rows >= 2 &&
        message.rows <= 200
      ) {
        if (channel) channel.setWindow(message.rows, message.cols, 0, 0);
        else if (client && !ptyStarted) {
          ptyStarted = true;
          client.shell(
            { term: 'xterm-256color', cols: message.cols, rows: message.rows },
            (err, stream) => {
              if (ended) {
                stream?.destroy();
                return;
              }
              if (err) {
                fail('Не удалось открыть оболочку на сервере.');
                return;
              }
              channel = stream;
              channel.on('data', output);
              channel.stderr.on('data', output);
              channel.on('error', () => fail('SSH-канал прерван.'));
              channel.on('close', (code) => {
                control('exit', { code: code ?? null });
                close();
              });
              control('ready');
            },
          );
        }
      } else close(1008, 'Некорректное сообщение');
    });
    void openSsh(target)
      .then((connection) => {
        if (ended) {
          connection.destroy();
          return;
        }
        client = connection;
        client.on('error', () => fail('SSH-соединение прервано.'));
        client.on('close', () => {
          control('exit', { code: null });
          close();
        });
        control('connected');
      })
      .catch(() =>
        fail(
          'Не удалось подключиться по SSH. Проверьте доступы и ключ сервера.',
        ),
      );
  }
  server.on('upgrade', upgrade);
  const janitor = setInterval(prune, 30000);
  janitor.unref();
  let disposed = false;
  function close() {
    if (disposed) return;
    disposed = true;
    clearInterval(janitor);
    tickets.clear();
    for (const session of sessions) session.close();
    server.off('upgrade', upgrade);
    wss.close();
  }
  server.on('close', close);
  function invalidate(serverId) {
    for (const [key, ticket] of tickets)
      if (ticket.serverId === serverId) tickets.delete(key);
    for (const session of sessions)
      if (session.serverId === serverId)
        session.close('Настройки SSH изменились. Подключитесь снова.');
  }
  return { issue, close, invalidate };
}
