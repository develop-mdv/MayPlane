import ssh2 from 'ssh2';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { q, assert } from './security.mjs';
const { Client } = ssh2;
export const rootOf = (p) => `/opt/ezdeploy/${p.id}`;
export const compose = (p) =>
  `cd ${q(rootOf(p) + '/repo')}\ndocker compose --project-name ${q('ez_' + p.id)} --env-file .env -f ${q(p.composeFile)}`;
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
      username: 'root',
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
export async function connect(server) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', reject);
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
  });
}
export function run(
  client,
  script,
  { log = () => {}, timeout = 20 * 60 * 1000, limit = 2 * 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    client.exec('bash -se', (err, stream) => {
      if (err) return reject(err);
      let output = '',
        line = '';
      let done = false;
      const finish = (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (line) log(line);
        if (e) reject(e);
        else resolve(output);
      };
      const timer = setTimeout(() => {
        client.destroy();
        finish(
          new Error('Превышено время операции. Проверьте состояние сервера.'),
        );
      }, timeout);
      const read = (chunk) => {
        const text = chunk.toString();
        if (output.length + text.length > limit) {
          client.destroy();
          return finish(new Error('Превышен лимит вывода команды'));
        }
        output += text;
        line += text;
        let idx;
        while ((idx = line.indexOf('\n')) >= 0) {
          log(line.slice(0, idx));
          line = line.slice(idx + 1);
        }
      };
      stream.on('data', read);
      stream.stderr.on('data', read);
      stream.on('error', finish);
      stream.on('close', (code) =>
        finish(
          code === 0 ? null : new Error(`Команда завершилась с кодом ${code}`),
        ),
      );
      stream.end('set -euo pipefail\n' + script + '\n');
    });
  });
}
export async function put(client, path, text) {
  const sftp = await new Promise((resolve, reject) =>
    client.sftp((e, s) => (e ? reject(e) : resolve(s))),
  );
  try {
    await new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(path, { mode: 0o600 });
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(text);
    });
  } finally {
    sftp.end();
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
  assert(sourceSum === targetSum, 'Контрольные суммы копии не совпали');
}
export async function metrics(client) {
  const output = await run(
    client,
    `read _ u n s idle rest < /proc/stat; total=$(awk '/^cpu /{for(i=2;i<=NF;i++) s+=$i;print s}' /proc/stat); idle=$((idle)); sleep 1; read _ u2 n2 s2 idle2 rest2 < /proc/stat; total2=$(awk '/^cpu /{for(i=2;i<=NF;i++) s+=$i;print s}' /proc/stat); echo "CPU:$((100*(total2-total-idle2+idle)/(total2-total)))"; free -m | awk '/Mem:/{printf "MEM:%.0f\\nRAM:%s\\n",100*($2-$7)/$2,$2}'; df -P / | awk 'NR==2 {gsub("%","",$5); print "DISK:"$5}'; echo "CORES:$(nproc)"; if docker compose version >/dev/null 2>&1; then echo 'DOCKER:yes'; else echo 'DOCKER:no'; fi`,
    { timeout: 20000 },
  );
  const m = Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((l) => l.split(':')),
  );
  return {
    cpu: Number(m.CPU),
    memory: Number(m.MEM),
    disk: Number(m.DISK),
    status: m.DOCKER === 'yes' ? 'online' : 'needs_setup',
    specs: `${m.CORES} vCPU · ${Math.round(Number(m.RAM) / 1024)} GB RAM · Linux`,
    checkedAt: new Date().toISOString(),
  };
}
