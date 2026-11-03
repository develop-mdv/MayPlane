import {
  operationSignal,
  checkCancellation,
  cancellationError,
  currentOperation,
} from './cancellation.mjs';
import ssh2 from 'ssh2';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { q, assert } from './security.mjs';
const { Client } = ssh2;
export const rootOf = (p) => `/opt/ezdeploy/${p.id}`;
export const workspaceOf = (p) =>
  posix.join(rootOf(p), 'repo', posix.dirname(p.composeFile));
export const compose = (p) =>
  `cd ${q(workspaceOf(p))}\ndocker compose --project-name ${q('ez_' + p.id)} --env-file .env -f ${q(posix.basename(p.composeFile))}`;
export async function fingerprint(server) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let found = false;
    client.on('error', (e) => {
      if (!found) reject(e);
    });
    client.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 10000,
      hostVerifier: (key) => {
        found = true;
        resolve(
          'SHA256:' +
            createHash('sha256')
              .update(key)
              .digest('base64')
              .replace(/=+$/, ''),
        );
        setImmediate(() => client.end());
        return false;
      },
    });
  });
}
export async function connect(server, { signal = operationSignal() } = {}) {
  if (signal?.aborted) throw cancellationError();
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(client);
    };
    const abort = () => {
      finish(cancellationError());
      client.destroy();
    };
    client.on('ready', () => finish());
    client.on('error', (error) =>
      finish(signal?.aborted ? cancellationError() : error),
    );
    client.on('close', () =>
      finish(
        signal?.aborted
          ? cancellationError()
          : new Error('SSH-соединение закрыто'),
      ),
    );
    signal?.addEventListener('abort', abort, { once: true });
    client.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      ...server.secret,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      hostVerifier: (key) =>
        'SHA256:' +
          createHash('sha256')
            .update(key)
            .digest('base64')
            .replace(/=+$/, '') ===
        server.fingerprint,
    });
    if (signal?.aborted) abort();
  });
}
export async function run(
  client,
  script,
  {
    log = () => {},
    timeout = 20 * 60 * 1000,
    limit = 2 * 1024 * 1024,
    signal = operationSignal(),
    cancellationGrace = 3000,
  } = {},
) {
  if (signal?.aborted) throw cancellationError();
  assert(!script.includes('\0'), 'Команда содержит недопустимый нулевой байт');
  const operation = currentOperation();
  return new Promise((resolve, reject) => {
    // Keep timeout as the SSH session leader so SSH signals reach its process group.
    client.exec(
      `exec timeout --signal=TERM --kill-after=10s ${Math.max(1, Math.ceil(timeout / 1000))} bash -c ${q('IFS= read -r -d "" __ezdeploy_script && eval "$__ezdeploy_script" </dev/null')}`,
      (err, stream) => {
        if (err) return reject(signal?.aborted ? cancellationError() : err);
        let output = '',
          line = '',
          done = false,
          terminating = false;
        let killTimer, confirmationTimer;
        const finish = (error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          clearTimeout(confirmationTimer);
          signal?.removeEventListener('abort', abort);
          client.removeListener?.('close', disconnected);
          if (line) log(line);
          if (error) reject(error);
          else resolve(output);
        };
        const disconnected = () => {
          if (signal?.aborted && operation) operation.unconfirmed = true;
          finish(
            signal?.aborted
              ? cancellationError(true)
              : new Error('SSH-соединение прервано'),
          );
        };
        const sendSignal = (name) => {
          try {
            stream.signal(name);
          } catch {
            /* The confirmation timeout reports unsupported signals. */
          }
        };
        const abort = () => {
          if (done || terminating) return;
          terminating = true;
          clearTimeout(timer);
          log('Прерываем текущую SSH-команду…');
          sendSignal('TERM');
          killTimer = setTimeout(() => sendSignal('KILL'), cancellationGrace);
          confirmationTimer = setTimeout(() => {
            if (operation) operation.unconfirmed = true;
            finish(cancellationError(true));
            client.destroy();
          }, cancellationGrace + 7000);
        };
        const timer = setTimeout(() => {
          finish(
            new Error('Превышено время операции. Проверьте состояние сервера.'),
          );
          client.destroy();
        }, timeout + 15000);
        const read = (chunk) => {
          const text = chunk.toString();
          if (output.length + text.length > limit) {
            finish(new Error('Превышен лимит вывода команды'));
            client.destroy();
            return;
          }
          output += text;
          line += text;
          let index;
          while ((index = line.indexOf('\n')) >= 0) {
            log(line.slice(0, index));
            line = line.slice(index + 1);
          }
        };
        stream.on('data', read);
        stream.stderr.on('data', read);
        stream.on('error', (error) => {
          if (signal?.aborted && operation) operation.unconfirmed = true;
          finish(signal?.aborted ? cancellationError(true) : error);
        });
        stream.on('close', (code, exitSignal) => {
          const unconfirmed =
            signal?.aborted && !Number.isInteger(code) && !exitSignal;
          if (unconfirmed && operation) operation.unconfirmed = true;
          finish(
            signal?.aborted
              ? cancellationError(!!unconfirmed)
              : code === 0
                ? null
                : new Error(`Команда завершилась с кодом ${code}`),
          );
        });
        client.once?.('close', disconnected);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          abort();
          stream.end();
        } else {
          // ssh2 cannot send channel signals after EOF. Frame stdin with NUL instead,
          // then evaluate with /dev/null so commands still receive EOF on stdin.
          stream.write('set -euo pipefail\n' + script + '\n\0');
        }
      },
    );
  });
}
export async function put(client, path, text, { preserveMode = false } = {}) {
  checkCancellation();
  const signal = operationSignal();
  let sftp, stream;
  const cancelled = Promise.withResolvers();
  const abort = () => {
    stream?.destroy(cancellationError());
    sftp?.end();
    cancelled.reject(cancellationError());
  };
  signal?.addEventListener('abort', abort, { once: true });
  async function upload() {
    sftp = await new Promise((resolve, reject) =>
      client.sftp((error, session) => {
        if (signal?.aborted) {
          session?.end();
          reject(cancellationError());
        } else if (error) reject(error);
        else resolve(session);
      }),
    );
    checkCancellation();
    const mode = preserveMode
      ? await new Promise((resolve, reject) =>
          sftp.stat(path, (error, attrs) => {
            if (error && error.code !== 2) reject(error);
            else resolve(attrs ? attrs.mode & 0o777 : 0o600);
          }),
        )
      : 0o600;
    checkCancellation();
    await new Promise((resolve, reject) => {
      stream = sftp.createWriteStream(path, { mode });
      stream.on('error', reject);
      stream.on('close', () => {
        if (signal?.aborted) reject(cancellationError());
        else sftp.chmod(path, mode, (e) => (e ? reject(e) : resolve()));
      });
      stream.end(text);
    });
  }
  try {
    await Promise.race([upload(), cancelled.promise]);
    checkCancellation();
  } finally {
    signal?.removeEventListener('abort', abort);
    sftp?.end();
  }
}
export async function copyFile(source, target, path) {
  const a = await new Promise((r, j) =>
    source.sftp((e, s) => (e ? j(e) : r(s))),
  );
  const b = await new Promise((r, j) =>
    target.sftp((e, s) => (e ? j(e) : r(s))),
  );
  const timer = setTimeout(
    () => {
      source.destroy();
      target.destroy();
    },
    60 * 60 * 1000,
  );
  try {
    await pipeline(
      a.createReadStream(path),
      b.createWriteStream(path, { mode: 0o600 }),
    );
  } finally {
    clearTimeout(timer);
    a.end();
    b.end();
  }
  const sourceSum = (await run(source, `sha256sum ${q(path)}`)).split(/\s/)[0];
  const targetSum = (await run(target, `sha256sum ${q(path)}`)).split(/\s/)[0];
  assert(
    /^[a-f0-9]{64}$/.test(sourceSum) && sourceSum === targetSum,
    'Контрольные суммы копии не совпали',
  );
}
export async function metrics(client) {
  let output = await run(
    client,
    `read _ u n s idle rest < /proc/stat; total=$(awk '/^cpu /{for(i=2;i<=NF;i++) s+=$i;print s}' /proc/stat); idle=$((idle)); sleep 1; read _ u2 n2 s2 idle2 rest2 < /proc/stat; total2=$(awk '/^cpu /{for(i=2;i<=NF;i++) s+=$i;print s}' /proc/stat); echo "CPU:$((100*(total2-total-idle2+idle)/(total2-total)))"; free -m | awk '/Mem:/{printf "MEM:%.0f\\nRAM:%s\\n",100*($2-$7)/$2,$2}'; df -P / | awk 'NR==2 {gsub("%","",$5); print "DISK:"$5}'; echo "CORES:$(nproc)"; if docker compose version >/dev/null 2>&1; then echo 'DOCKER:yes'; else echo 'DOCKER:no'; fi`,
    { timeout: 20000 },
  );
  output += await run(
    client,
    `printf 'UPTIME:'; cut -d ' ' -f 1 /proc/uptime
ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1 {split($4,a,"/"); print "IPV4:"a[1]}'
ip -6 -o addr show scope global 2>/dev/null | awk 'NR==1 {split($4,a,"/"); print "IPV6:"a[1]}'
awk -F '[: ]+' 'NR>2 && $2!="lo" {rx+=$3;tx+=$11} END {printf "RX:%.0f\\nTX:%.0f\\n",rx,tx}' /proc/net/dev`,
    { timeout: 10000 },
  );
  const m = Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((l) => {
        const index = l.indexOf(':');
        return [l.slice(0, index), l.slice(index + 1)];
      }),
  );
  return {
    cpu: Number(m.CPU),
    memory: Number(m.MEM),
    disk: Number(m.DISK),
    platform: 'linux',
    ipv4: m.IPV4 || '',
    ipv6: m.IPV6 || '',
    uptime: Number(m.UPTIME) || null,
    networkRx: m.RX === undefined ? null : Number(m.RX),
    networkTx: m.TX === undefined ? null : Number(m.TX),
    status: m.DOCKER === 'yes' ? 'online' : 'needs_setup',
    specs: `${m.CORES} vCPU · ${Math.round(Number(m.RAM) / 1024)} GB RAM · Linux`,
    checkedAt: new Date().toISOString(),
  };
}
