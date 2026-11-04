import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { assert } from './security.mjs';
import { certificateStatus } from './tls-status.mjs';

const derive = promisify(scrypt);
const parameters = { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 };
const hashToken = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export const loopback = (value) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);

export function ownerTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_credentials (
    id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL,
    csrf_key TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_sessions (id TEXT PRIMARY KEY, version INTEGER NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS owner_sessions_expiry ON owner_sessions(expires_at);`);
}
export function ownerUsername(value) {
  assert(
    typeof value === 'string' && /^[a-zA-Z0-9_.@-]{3,64}$/.test(value),
    'Логин: от 3 до 64 латинских букв, цифр и символов . _ @ -',
  );
  return value;
}
export async function passwordHash(password) {
  assert(
    typeof password === 'string' &&
      Array.from(password).length >= 15 &&
      Buffer.byteLength(password) <= 1024,
    'Пароль: не менее 15 символов, не более 1024 байт. Можно использовать длинную фразу.',
  );
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 32, parameters);
  return `scrypt$65536$8$2$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024)
    return false;
  const parts = encoded.split('$');
  if (
    parts.length !== 6 ||
    parts.slice(0, 4).join('$') !== 'scrypt$65536$8$2' ||
    !/^[a-f0-9]{32}$/.test(parts[4]) ||
    !/^[a-f0-9]{64}$/.test(parts[5])
  )
    return false;
  const actual = await derive(password, parts[4], 32, parameters);
  return timingSafeEqual(actual, Buffer.from(parts[5], 'hex'));
}
export async function initializeOwner(
  db,
  {
    username = 'admin',
    password = randomBytes(24).toString('base64url'),
    reset = false,
  } = {},
) {
  ownerTables(db);
  const previous = db
    .prepare('SELECT version FROM owner_credentials WHERE id=1')
    .get();
  if (previous && !reset) return null;
  const name = ownerUsername(username),
    hash = await passwordHash(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db
      .prepare('SELECT version FROM owner_credentials WHERE id=1')
      .get();
    if (current && !reset) {
      db.exec('ROLLBACK');
      return null;
    }
    db.prepare(
      'INSERT OR REPLACE INTO owner_credentials VALUES(1,?,?,?,?,?)',
    ).run(
      name,
      hash,
      randomBytes(32).toString('hex'),
      (current?.version || 0) + 1,
      Date.now(),
    );
    db.exec('DELETE FROM owner_sessions; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { username: name, password };
}

export function createOwnerAuth(
  db,
  {
    origins,
    publicUrl = '',
    trustProxy = false,
    managedTls = false,
    onRevoke = () => {},
    onRevokeAll = () => {},
    now = Date.now,
    sessionTtl = 12 * 60 * 60 * 1000,
  } = {},
) {
  ownerTables(db);
  const secure = publicUrl.startsWith('https://');
  const cookieName = secure ? '__Host-mayplane_session' : 'mayplane_session';
  const failures = new Map();
  let hashing = false;
  let tlsCache;
  const owner = () =>
    db.prepare('SELECT * FROM owner_credentials WHERE id=1').get();
  function cookie(req) {
    const found = String(req.headers.cookie || '')
      .split(';')
      .map((p) => p.trim())
      .filter((p) => p.startsWith(cookieName + '='));
    if (found.length !== 1) return null;
    const value = found[0].slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  function csrf(raw, record) {
    return createHmac('sha256', record.csrf_key)
      .update(raw)
      .digest('base64url');
  }
  function identify(req) {
    const raw = cookie(req);
    if (!raw) return null;
    const id = hashToken(raw),
      record = owner();
    const session = db
      .prepare('SELECT * FROM owner_sessions WHERE id=?')
      .get(id);
    if (
      !record ||
      !session ||
      session.version !== record.version ||
      session.expires_at <= now()
    )
      return null;
    return {
      id,
      username: record.username,
      expiresAt: session.expires_at,
      csrf: csrf(raw, record),
      version: record.version,
    };
  }
  function transport(req) {
    if (secure)
      assert(
        req.socket.encrypted ||
          (trustProxy &&
            loopback(req.socket.remoteAddress) &&
            req.headers['x-forwarded-proto'] === 'https'),
        'Для входа используйте HTTPS-адрес панели.',
        403,
      );
    else
      assert(
        loopback(req.socket.remoteAddress) &&
          ['localhost', '127.0.0.1', '::1'].includes(
            new URL('http://' + req.headers.host).hostname.replace(
              /^\[|\]$/g,
              '',
            ),
          ),
        'Обычный HTTP разрешён только на локальном компьютере.',
        403,
      );
  }
  function mutation(req, session) {
    transport(req);
    assert(
      origins.includes(req.headers.origin) &&
        req.headers['sec-fetch-site'] !== 'cross-site',
      'Запрос выполнен не из этой панели. Обновите страницу.',
      403,
    );
    assert(
      String(req.headers['content-type'] || '').split(';')[0] ===
        'application/json',
      'Требуется application/json',
      415,
    );
    if (session)
      assert(
        equal(req.headers['x-mayplane-csrf'], session.csrf),
        'Сессия обновилась. Обновите страницу и повторите действие.',
        403,
      );
  }
  function requireOwner(
    req,
    write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  ) {
    transport(req);
    assert(
      req.headers['sec-fetch-site'] !== 'cross-site',
      'Недопустимый источник запроса',
      403,
    );
    const session = identify(req);
    assert(session, 'Войдите в MayPlane', 401);
    if (write) mutation(req, session);
    return session;
  }
  function setCookie(res, value, age) {
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`,
    );
  }
  function begin(res) {
    const record = owner(),
      raw = randomBytes(32).toString('base64url'),
      at = now();
    db.prepare('DELETE FROM owner_sessions WHERE expires_at<=?').run(at);
    const oldest = db
      .prepare(
        'SELECT id FROM owner_sessions ORDER BY created_at DESC LIMIT -1 OFFSET 9',
      )
      .all();
    for (const old of oldest) {
      db.prepare('DELETE FROM owner_sessions WHERE id=?').run(old.id);
      onRevoke(old.id);
    }
    db.prepare('INSERT INTO owner_sessions VALUES(?,?,?,?)').run(
      hashToken(raw),
      record.version,
      at,
      at + sessionTtl,
    );
    setCookie(res, raw, Math.floor(sessionTtl / 1000));
    return {
      authenticated: true,
      user: { username: record.username },
      csrf: csrf(raw, record),
      expiresAt: new Date(at + sessionTtl).toISOString(),
    };
  }
  function client(req) {
    const forwarded =
      trustProxy && loopback(req.socket.remoteAddress)
        ? req.headers['x-forwarded-for']
        : '';
    return typeof forwarded === 'string' && isIP(forwarded.trim())
      ? forwarded.trim()
      : req.socket.remoteAddress;
  }
  function limit(req) {
    const at = now();
    for (const [key, entry] of failures)
      if (entry.until <= at) failures.delete(key);
    assert(
      failures.size < 4096,
      'Слишком много попыток входа. Повторите позже.',
      429,
    );
    const ip = client(req),
      entry = failures.get(ip) || { count: 0, until: at + 15 * 60000 };
    assert(
      entry.count < 10,
      'Слишком много попыток входа. Повторите через 15 минут.',
      429,
    );
    entry.count++;
    failures.set(ip, entry);
    assert(
      !hashing,
      'Проверка входа уже выполняется. Повторите через несколько секунд.',
      429,
    );
    return ip;
  }
  async function handle(path, req, res, body, send) {
    if (!path.startsWith('/api/auth/')) return false;
    if (path === '/api/auth/session' && req.method === 'GET') {
      transport(req);
      const session = identify(req);
      send(
        session
          ? {
              authenticated: true,
              configured: true,
              user: { username: session.username },
              csrf: session.csrf,
              expiresAt: new Date(session.expiresAt).toISOString(),
              publicUrl,
              secure,
            }
          : { authenticated: false, configured: !!owner() },
      );
      return true;
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      mutation(req);
      const ip = limit(req),
        record = owner();
      assert(
        record,
        'Сначала выполните npm run runner:setup на машине панели.',
        503,
      );
      assert(
        typeof body.username === 'string' && body.username.length <= 64,
        'Неверный логин или пароль',
        401,
      );
      hashing = true;
      let valid;
      try {
        valid = await verifyPassword(body.password, record.password_hash);
      } finally {
        hashing = false;
      }
      assert(
        valid &&
          equal(body.username.toLowerCase(), record.username.toLowerCase()),
        'Неверный логин или пароль',
        401,
      );
      assert(
        owner()?.version === record.version,
        'Учётные данные изменились. Повторите вход.',
        401,
      );
      failures.delete(ip);
      send(begin(res));
      return true;
    }
    const session = requireOwner(req);
    if (path === '/api/auth/deployment' && req.method === 'GET') {
      if (!tlsCache || tlsCache.until <= now())
        tlsCache = {
          until: now() + 60000,
          pending: certificateStatus(publicUrl, { managed: managedTls }),
        };
      send(await tlsCache.pending);
      return true;
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      db.prepare('DELETE FROM owner_sessions WHERE id=?').run(session.id);
      onRevoke(session.id);
      setCookie(res, '', 0);
      send({ ok: true });
      return true;
    }
    if (path === '/api/auth/credentials' && req.method === 'POST') {
      const ip = limit(req),
        record = owner();
      hashing = true;
      let valid, hash;
      try {
        valid = await verifyPassword(
          body.currentPassword,
          record.password_hash,
        );
        assert(valid, 'Текущий пароль указан неверно.', 403);
        ownerUsername(body.username);
        hash = body.newPassword
          ? await passwordHash(body.newPassword)
          : record.password_hash;
      } finally {
        hashing = false;
      }
      assert(
        owner()?.version === session.version,
        'Учётные данные изменились. Войдите снова.',
        401,
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          'UPDATE owner_credentials SET username=?,password_hash=?,csrf_key=?,version=version+1,updated_at=? WHERE id=1',
        ).run(body.username, hash, randomBytes(32).toString('hex'), now());
        db.exec('DELETE FROM owner_sessions; COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      onRevokeAll();
      failures.delete(ip);
      send(begin(res));
      return true;
    }
    send({ error: 'Маршрут не найден' }, 404);
    return true;
  }
  return {
    handle,
    requireOwner,
    identify,
    configured: () => !!owner(),
    active(id) {
      const row = db
        .prepare('SELECT version,expires_at FROM owner_sessions WHERE id=?')
        .get(id);
      return (
        !!row && row.expires_at > now() && row.version === owner()?.version
      );
    },
  };
}
