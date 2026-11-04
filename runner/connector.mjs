import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { WebSocket } from 'ws';
import { localMetrics, localProcess, projectPath } from './machine-process.mjs';
import { assert } from './security.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const directory =
  arg('--data-dir') || join(os.homedir(), '.ezdeploy-connector');
const configPath = join(directory, 'connection.json');
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {}
const url = new URL(
  arg('--url') || config?.url || 'ws://127.0.0.1:8788/api/connector',
);
assert(
  url.protocol === 'wss:' ||
    (url.protocol === 'ws:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)),
  'Для удалённой панели нужен wss://',
);
assert(
  !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === '/api/connector',
  'Используйте адрес wss://панель/api/connector',
);
let token = config?.url === url.href ? config.token : '';
if (process.argv.includes('--pair')) token = '';
if (!token) {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  token = (await prompt.question('Одноразовый код из панели: ')).trim();
  prompt.close();
}
let stopped = false,
  socket,
  retry;
const processes = new Map();
function connect() {
  socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    maxPayload: 1024 * 1024,
  });
  const send = (data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  };
  let interval;
  socket.on('open', () => {
    console.log('ezdeploy: защищённое соединение с панелью открыто');
    send({ type: 'metrics', metrics: localMetrics() });
    interval = setInterval(
      () => send({ type: 'metrics', metrics: localMetrics() }),
      10000,
    );
  });
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === 'paired') {
      if (message.token) {
        token = message.token;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(configPath, JSON.stringify({ url: url.href, token }), {
          mode: 0o600,
        });
      }
      console.log('Компьютер подключён. Для отключения нажмите Ctrl+C.');
      return;
    }
    const child = processes.get(message.id);
    if (message.type === 'stdin')
      child?.input.write(Buffer.from(String(message.data || ''), 'base64'));
    if (message.type === 'kill') {
      child?.close();
      processes.delete(message.id);
    }
    if (message.type === 'spawn') {
      if (processes.size >= 12)
        return send({ type: 'process-error', id: message.id });
      try {
        if (message.cwd) projectPath(message.cwd, process.platform);
        const childProcess = localProcess({
          provider: message.provider,
          operation: message.operation,
          cwd: message.cwd,
          profileId: message.profileId,
          profileFormat: message.profileFormat,
          profileVendor: message.profileVendor,
          profileCredential: message.profileCredential,
        });
        processes.set(message.id, childProcess);
        for (const type of ['stdout', 'stderr'])
          childProcess[type].on('data', (chunk) => {
            if (socket.bufferedAmount > 8 * 1024 * 1024)
              return childProcess.close();
            send({ type, id: message.id, data: chunk.toString('base64') });
          });
        childProcess.events.on('error', () => {
          send({ type: 'process-error', id: message.id });
          processes.delete(message.id);
        });
        childProcess.events.on('close', (code) => {
          send({ type: 'exit', id: message.id, code });
          processes.delete(message.id);
        });
      } catch {
        send({ type: 'process-error', id: message.id });
      }
    }
  });
  socket.on('unexpected-response', (_req, response) => {
    if ([401, 403].includes(response.statusCode)) {
      stopped = true;
      console.error(
        'Код истёк или доступ отозван. Создайте новое подключение в панели.',
      );
      socket.terminate();
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    clearInterval(interval);
    for (const p of processes.values()) p.close();
    processes.clear();
    if (!stopped) {
      console.log('Связь прервана. Повторное подключение через 5 секунд…');
      retry = setTimeout(connect, 5000);
    }
  });
}
function stop() {
  stopped = true;
  clearTimeout(retry);
  for (const p of processes.values()) p.close();
  socket?.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
connect();
