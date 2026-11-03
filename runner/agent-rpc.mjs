import { EventEmitter } from 'node:events';

// Both Codex app-server and ACP use newline-delimited JSON-RPC over stdio.
export class AgentRpc extends EventEmitter {
  constructor(process, { timeout = 30000 } = {}) {
    super();
    this.process = process;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.timeout = timeout;
    this.dead = false;
    process.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 8 * 1024 * 1024)
        return this.close(new Error('Превышен размер события агента'));
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && !message.method) {
          const request = this.pending.get(message.id);
          if (!request) continue;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          message.error
            ? request.reject(
                new Error(message.error.message || 'Ошибка агента'),
              )
            : request.resolve(message.result);
        } else this.emit('message', message);
      }
    });
    process.events.on('error', (error) => this.close(error));
    process.events.on('close', () =>
      this.close(new Error('Соединение с агентом закрыто')),
    );
    process.input.on('error', (error) => this.close(error));
    process.stderr.on('data', () => {}); // Never log arbitrary agent stderr or tokens.
  }
  send(message) {
    if (this.dead) throw new Error('Агент отключён');
    this.process.input.write(
      JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n',
    );
  }
  request(method, params = {}, timeout = this.timeout) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Агент не ответил: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method, params = {}) {
    this.send({ method, params });
  }
  respond(id, result) {
    this.send({ id, result });
  }
  reject(id) {
    this.send({
      id,
      error: { code: -32601, message: 'Client method not supported' },
    });
  }
  close(error = new Error('Агент отключён')) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.process.close();
    this.emit('disconnected', error);
  }
}
