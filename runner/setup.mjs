import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openStore } from './store.mjs';
import { initializeOwner } from './owner-auth.mjs';
import { runtimeConfig } from './config.mjs';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (
    args[i] === '--username' &&
    args[i + 1] &&
    !args[i + 1].startsWith('--')
  ) {
    i++;
    continue;
  }
  if (['--reset', '--password-stdin'].includes(args[i])) continue;
  throw new Error('Параметры: --username LOGIN, --password-stdin, --reset');
}
const envPath = process.env.MAYPLANE_ENV_FILE || '.env.runner';
if (!existsSync(envPath)) {
  const directory = process.env.MAYPLANE_DATA_DIR || '.runner-data';
  const priorDatabase =
    existsSync(directory) &&
    readdirSync(directory).some((name) =>
      /\.sqlite(?:3)?(?:-wal|-shm)?$/i.test(name),
    );
  if (priorDatabase && !process.env.MAYPLANE_ENCRYPTION_KEY)
    throw new Error(
      'Найдена существующая база без конфигурации ключа. Восстановите прежний MAYPLANE_ENCRYPTION_KEY; новый ключ не создан.',
    );
  const key =
    process.env.MAYPLANE_ENCRYPTION_KEY || randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error('Некорректный MAYPLANE_ENCRYPTION_KEY');
  if (priorDatabase) openStore(directory, Buffer.from(key, 'hex')).close();
  if (/[\r\n]/.test(directory)) throw new Error('Некорректный каталог данных');
  writeFileSync(
    envPath,
    `MAYPLANE_ENCRYPTION_KEY=${key}\nMAYPLANE_DATA_DIR=${directory.replaceAll('\\', '/')}\nHOST=127.0.0.1\nPORT=8788\nMAYPLANE_WEB_PORT=8789\nALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000\nMAYPLANE_PUBLIC_URL=\nMAYPLANE_ACCESS_MODE=local\n`,
    { mode: 0o600, flag: 'wx' },
  );
}
const config = runtimeConfig(),
  store = openStore(config.dataDir, config.key);
try {
  let password;
  if (args.includes('--password-stdin')) {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 1026) throw new Error('Пароль слишком длинный');
      chunks.push(chunk);
    }
    password = Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  const index = args.indexOf('--username');
  const prior = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='owner_credentials'",
    )
    .get();
  const username =
    index >= 0
      ? args[index + 1]
      : prior
        ? store.db
            .prepare('SELECT username FROM owner_credentials WHERE id=1')
            .get()?.username || 'admin'
        : 'admin';
  const credentials = await initializeOwner(store.db, {
    username,
    password,
    reset: args.includes('--reset'),
  });
  if (credentials)
    console.log(
      `\nMayPlane — данные для входа (показываются один раз)\nЛогин: ${credentials.username}\nПароль: ${credentials.password}\nАдрес: ${config.publicUrl || `http://127.0.0.1:${config.port}`}\nСохраните пароль в менеджере паролей. Изменить его можно в настройках.\n`,
    );
  else
    console.log(
      'Учётная запись и ключ существующей базы сохранены. Для восстановления входа: npm run auth:reset',
    );
} finally {
  store.close();
}
