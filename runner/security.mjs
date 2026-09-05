import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';

export const q = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function assert(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
export function equal(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}
export function seal(text, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
}
export function unseal(text, key) {
  const bytes = Buffer.from(text, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString('utf8');
}
export function envEntries(text) {
  assert(
    typeof text === 'string' && Buffer.byteLength(text) < 65536,
    'Файл .env должен быть меньше 64 КБ',
  );
  const entries = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    assert(
      m,
      `Некорректная строка .env: ${index + 1}. Используйте KEY=value, без многострочных значений.`,
    );
    let v = m[2].trim();
    if (v.startsWith('"') || v.startsWith("'")) {
      assert(
        v.endsWith(v[0]) && v.length > 1,
        `Незакрытые кавычки в строке ${index + 1}`,
      );
      v = v.slice(1, -1);
    } else v = v.replace(/\s+#.*$/, '');
    assert(
      !entries.some((e) => e[0] === m[1]),
      `Повторяющаяся переменная: ${m[1]}`,
    );
    entries.push([m[1], v]);
  }
  return entries;
}
export function redact(text, secrets) {
  let clean = String(text);
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    clean = clean.split(secret).join('[REDACTED]');
  }
  // Strip ANSI color sequences from terminal output.
  // eslint-disable-next-line no-control-regex
  return clean.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
export function serverInput(body) {
  assert(
    typeof body.name === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/.test(body.name),
    'Укажите имя сервера, до 64 символов',
  );
  assert(
    typeof body.host === 'string' && isIP(body.host),
    'Укажите корректный IPv4 или IPv6 адрес',
  );
  const port = Number(body.port || 22);
  assert(
    Number.isInteger(port) && port > 0 && port <= 65535,
    'Некорректный SSH-порт',
  );
  assert(
    body.username === 'root',
    'В первой версии подключение выполняется под root',
  );
  return {
    name: body.name,
    host: body.host,
    port,
    username: 'root',
    region: String(body.region || 'Свой сервер').slice(0, 80),
  };
}
export function projectInput(body) {
  assert(
    typeof body.name === 'string' && /^[a-z][a-z0-9-]{1,47}$/.test(body.name),
    'Имя проекта: 2–48 символов, a–z, цифры и дефис',
  );
  let url;
  try {
    url = new URL(body.repo);
  } catch {
    throw new Error('Укажите HTTPS URL репозитория');
  }
  assert(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.length > 1,
    'Репозиторий должен иметь HTTPS URL без токенов и параметров',
  );
  assert(
    typeof body.branch === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/.test(body.branch) &&
      !body.branch.includes('..') &&
      !body.branch.endsWith('/'),
    'Некорректная ветка',
  );
  const composeFile = body.composeFile || 'compose.yaml';
  assert(
    /^[A-Za-z0-9][A-Za-z0-9_./-]*\.ya?ml$/.test(composeFile) &&
      !composeFile.includes('..'),
    'Укажите относительный путь к Compose-файлу',
  );
  assert(['web', 'bot', 'service'].includes(body.kind), 'Выберите тип проекта');
  envEntries(body.env || '');
  return {
    name: body.name,
    repo: url.href,
    branch: body.branch,
    composeFile,
    kind: body.kind,
    domain: String(body.domain || '').slice(0, 253),
    serverId: body.serverId,
    autoDeploy: !!body.autoDeploy,
  };
}
export function validateMigrationConfig(config, root) {
  assert(
    Object.keys(config.services || {}).length > 0,
    'В Compose нет сервисов',
  );
  for (const v of Object.values(config.volumes || {}))
    assert(
      !v.external &&
        (!v.driver || v.driver === 'local') &&
        !Object.keys(v.driver_opts || {}).length,
      'Перенос внешних томов и нестандартных драйверов не поддерживается',
    );
  for (const n of Object.values(config.networks || {}))
    assert(!n.external, 'Внешние сети требуют ручного переноса');
  assert(
    !Object.keys(config.secrets || {}).length &&
      !Object.keys(config.configs || {}).length,
    'Compose secrets/configs требуют отдельного переноса',
  );
  for (const service of Object.values(config.services))
    for (const v of service.volumes || []) {
      assert(typeof v === 'object', 'Не удалось разобрать том Compose');
      if (v.type === 'bind')
        assert(
          v.source.startsWith(root + '/') &&
            !v.source.split('/').includes('..'),
          'Bind mounts должны находиться внутри каталога проекта',
        );
      else
        assert(
          v.type === 'volume' && v.source,
          'Анонимные и нестандартные тома требуют ручного переноса',
        );
    }
}
