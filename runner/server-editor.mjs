import { migrationLocked } from './migration.mjs';
import { assert, serverInput } from './security.mjs';

export function serverCredentials(body, existing) {
  const password = body.password;
  const privateKey = body.privateKey;
  assert(
    password === undefined ||
      (typeof password === 'string' && password.length <= 4096),
    'Некорректный SSH-пароль',
  );
  assert(
    privateKey === undefined ||
      (typeof privateKey === 'string' && privateKey.length <= 32768),
    'Некорректный SSH-ключ',
  );
  assert(
    !(password && privateKey),
    'Выберите один способ входа: пароль или SSH-ключ',
  );
  if (privateKey) return { privateKey };
  if (password) return { password };
  assert(existing, 'Укажите SSH-пароль или приватный ключ');
  return existing;
}

export function createServerEditor(store, engine, terminals) {
  const editing = new Set();
  function available(id, candidate) {
    const projects = store.list('projects').filter((p) => p.serverId === id);
    assert(
      !store
        .list('projects')
        .some(
          (p) =>
            migrationLocked(p) &&
            [p.migration.sourceId, p.migration.targetId].includes(id),
        ),
      'Сначала завершите восстановление переноса на сервере',
      409,
    );
    assert(
      !store
        .list('jobs')
        .some(
          (job) =>
            ['pending', 'deploying'].includes(job.status) &&
            (job.serverId === id ||
              job.target === id ||
              projects.some((p) => p.id === job.projectId)),
        ),
      'Дождитесь завершения операции на сервере',
      409,
    );
    assert(
      !store
        .list('servers')
        .some(
          (s) =>
            s.id !== id &&
            s.host === candidate.host &&
            s.port === candidate.port,
        ),
      'Этот адрес и SSH-порт уже используются другим сервером',
      409,
    );
    return projects;
  }
  return async (id, body) => {
    assert(!editing.has(id), 'Настройки сервера уже сохраняются', 409);
    const previous = store.get('servers', id);
    assert(previous, 'Сервер не найден', 404);
    const candidate = {
      ...previous,
      ...serverInput({
        name: body.name === undefined ? previous.name : body.name,
        host: body.host === undefined ? previous.host : body.host,
        port: body.port === undefined ? previous.port : body.port,
        username:
          body.username === undefined ? previous.username : body.username,
        region: body.region === undefined ? previous.region : body.region,
        consoleUrl:
          body.consoleUrl === undefined ? previous.consoleUrl : body.consoleUrl,
      }),
      secret: serverCredentials(body, previous.secret),
      fingerprint:
        body.fingerprint === undefined
          ? previous.fingerprint
          : body.fingerprint,
    };
    assert(
      /^SHA256:[A-Za-z0-9+/]{43}$/.test(candidate.fingerprint || ''),
      'Подтвердите отпечаток SSH-ключа',
    );
    const projects = available(id, candidate);
    assert(
      !projects.length || candidate.fingerprint === previous.fingerprint,
      'SSH-ключ отличается от сохранённого. Другой сервер подключите отдельно и перенесите проекты через «Перенос проектов».',
      409,
    );
    const connectionChanged =
      ['host', 'port', 'username', 'fingerprint'].some(
        (key) => previous[key] !== candidate[key],
      ) || JSON.stringify(candidate.secret) !== JSON.stringify(previous.secret);
    editing.add(id);
    try {
      if (connectionChanged) {
        try {
          Object.assign(candidate, await engine.inspect(candidate));
        } catch {
          throw Object.assign(
            new Error(
              'Не удалось подключиться с новыми параметрами SSH. Проверьте адрес, порт, пароль или ключ. Прежние настройки сохранены.',
            ),
            { status: 400 },
          );
        }
      }
      available(id, candidate);
      assert(
        JSON.stringify(store.get('servers', id)) === JSON.stringify(previous),
        'Сервер изменился во время проверки. Откройте настройки заново.',
        409,
      );
      candidate.updatedAt = new Date().toISOString();
      store.save('servers', candidate);
      if (connectionChanged) terminals.invalidate(id);
      return { ok: true };
    } finally {
      editing.delete(id);
    }
  };
}
