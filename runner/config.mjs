import { resolve } from 'node:path';
import { assert } from './security.mjs';

export function runtimeConfig() {
  try {
    process.loadEnvFile(process.env.MAYPLANE_ENV_FILE || '.env.runner');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const env = process.env;
  assert(
    /^[a-f0-9]{64}$/i.test(env.MAYPLANE_ENCRYPTION_KEY || ''),
    'Выполните npm run runner:setup. Не меняйте ключ существующей базы.',
  );
  const port = Number(env.PORT || 8788),
    webPort = Number(env.MAYPLANE_WEB_PORT || 8789);
  assert(
    [port, webPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535) &&
      port !== webPort,
    'Некорректные порты MayPlane',
  );
  const host = env.HOST || '127.0.0.1';
  assert(
    ['127.0.0.1', '::1', 'localhost'].includes(host),
    'MayPlane слушает только loopback. Для публикации используйте HTTPS-прокси из установщика.',
  );
  const publicUrl = env.MAYPLANE_PUBLIC_URL || '';
  if (publicUrl) {
    const url = new URL(publicUrl);
    assert(
      url.origin === publicUrl && !url.username && !url.password,
      'MAYPLANE_PUBLIC_URL должен содержать только origin',
    );
    assert(
      url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)),
      'Для сетевого доступа требуется HTTPS',
    );
  }
  const origins = publicUrl.startsWith('https:')
    ? [publicUrl]
    : [
        ...new Set([
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
          ...(
            env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000'
          )
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ]),
      ];
  return {
    host,
    port,
    webPort,
    publicUrl,
    origins,
    key: Buffer.from(env.MAYPLANE_ENCRYPTION_KEY, 'hex'),
    dataDir: resolve(env.MAYPLANE_DATA_DIR || '.runner-data'),
    trustProxy:
      publicUrl.startsWith('https:') && env.MAYPLANE_TRUST_PROXY === 'true',
    legacyApi: env.MAYPLANE_LEGACY_API === 'true',
  };
}

export function withoutPanelSecrets(environment = process.env) {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMP',
    'TEMP',
    'TMPDIR',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'XDG_CACHE_HOME',
    'NODE_ENV',
    'HOST',
    'PORT',
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => allowed.has(name)),
  );
}
