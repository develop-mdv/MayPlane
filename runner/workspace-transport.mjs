import { posix } from 'node:path';
import { connect } from './ssh.mjs';
import { assert, q } from './security.mjs';
import {
  gitEnvSet,
  gitEnvUnset,
  inspectWorkspace,
  workspaceSnapshotTimeout,
  workspaceTimeout,
  workspaceTimeoutError,
} from './workspace-files.mjs';

const invoke = (object, method, ...args) =>
  new Promise((resolve, reject) => {
    object[method](...args, (error, value) =>
      error ? reject(error) : resolve(value),
    );
  });

function sshGit(client, args, limit, signal) {
  const env = [
    ...gitEnvUnset.flatMap((name) => ['-u', name]),
    ...Object.entries(gitEnvSet).map(([key, value]) => `${key}=${value}`),
  ];
  const command =
    'exec timeout -k 2s 9s env ' + [...env, 'git', ...args].map(q).join(' ');
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0,
        stderr = '';
      const abort = () => {
        stream.close();
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      stream.on('data', (chunk) => {
        chunks.push(chunk.subarray(0, Math.max(0, limit - size)));
        size += chunk.length;
        if (size > limit) {
          resolve({
            buffer: Buffer.concat(chunks, limit),
            clipped: true,
            code: 0,
            stderr,
          });
          stream.close();
        }
      });
      stream.stderr.on('data', (chunk) => {
        if (stderr.length < 4096)
          stderr += chunk.toString().slice(0, 4096 - stderr.length);
      });
      stream.once('error', reject);
      stream.once('close', (code) => {
        signal.removeEventListener('abort', abort);
        resolve({ buffer: Buffer.concat(chunks), code, stderr });
      });
    });
  });
}

function remoteIO(client) {
  let channel;
  const sftp = () =>
    (channel ??= invoke(client, 'sftp').catch(() => {
      assert(
        false,
        'Для просмотра файлов на этом сервере нужен доступ по SFTP.',
        502,
      );
    }));
  const call = async (method, ...args) => invoke(await sftp(), method, ...args);
  return {
    p: posix,
    home: () => call('realpath', '.'),
    realpath: (path) => call('realpath', path),
    stat: (path) => call('stat', path),
    lstat: (path) => call('lstat', path),
    async *entries(path) {
      const handle = await call('opendir', path);
      try {
        for (;;) {
          const batch = await call('readdir', handle).catch((error) => {
            if (error.code === 1) return null; // SSH_FX_EOF
            throw error;
          });
          if (!batch?.length) break;
          for (const { filename, attrs } of batch)
            yield {
              name: filename,
              size: attrs.size,
              mtimeMs: attrs.mtime * 1000,
              isDirectory: () => attrs.isDirectory(),
              isFile: () => attrs.isFile(),
            };
        }
      } finally {
        await call('close', handle).catch(() => {});
      }
    },
    async read(path, limit) {
      const handle = await call('open', path, 'r');
      try {
        const info = await call('fstat', handle);
        assert(info.isFile(), 'Предпросмотр доступен для обычных файлов.');
        const buffer = Buffer.alloc(Math.min(limit, info.size));
        let count = 0;
        while (count < buffer.length) {
          const bytes = await call(
            'read',
            handle,
            buffer,
            count,
            buffer.length - count,
            count,
          );
          if (!bytes) break;
          count += bytes;
        }
        return { buffer: buffer.subarray(0, count), size: info.size };
      } finally {
        await call('close', handle).catch(() => {});
      }
    },
    git: (args, limit, signal) => sshGit(client, args, limit, signal),
  };
}

export function createWorkspaceInspector(connectors) {
  const active = new Map();
  return async (machine, operation, options) => {
    const { id } = machine;
    assert(
      (active.get(id) || 0) < 8,
      'На машине уже выполняются запросы. Повторите через несколько секунд.',
      429,
    );
    active.set(id, (active.get(id) || 0) + 1);
    let client;
    const signal = AbortSignal.timeout(
      operation === 'snapshot' ? workspaceSnapshotTimeout : workspaceTimeout,
    );
    let abort;
    try {
      if (machine.transport === 'connector')
        return await connectors.inspect(id, operation, options, signal);
      const expired = new Promise((_, reject) => {
        abort = () => reject(workspaceTimeoutError());
        signal.addEventListener('abort', abort, { once: true });
      });
      const result = async () => {
        if (machine.transport === 'local')
          return inspectWorkspace(operation, options, undefined, signal);
        try {
          client = await connect(machine, { signal });
        } catch {
          assert(false, 'Не удалось подключиться к машине по SSH.', 502);
        }
        return inspectWorkspace(operation, options, remoteIO(client), signal);
      };
      return await Promise.race([result(), expired]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      client?.destroy();
      const remaining = active.get(id) - 1;
      if (remaining) active.set(id, remaining);
      else active.delete(id);
    }
  };
}
