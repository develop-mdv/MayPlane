import { createServer } from 'node:http';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openStore } from './store.mjs';
import {
  assert,
  equal,
  envEntries,
  projectInput,
  serverInput,
  redact,
} from './security.mjs';
import { connect, fingerprint, run, compose } from './ssh.mjs';
import { createEngine } from './engine.mjs';

export function createApp({
  store,
  token,
  origins = [],
  publicUrl = '',
  engine = createEngine(store),
}) {
  const failures = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) {
      res.writeHead(403);
      return res.end(
        JSON.stringify({
          error: 'Этот адрес панели не разрешён в ALLOWED_ORIGINS',
        }),
      );
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type',
      );
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, OPTIONS',
      );
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const send = (obj, status = 200) => {
      res.writeHead(status);
      res.end(JSON.stringify(obj));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const webhook = path.match(/^\/api\/webhooks\/github\/([a-f0-9-]+)$/);
      if (!webhook) {
        const ip = req.socket.remoteAddress;
        const failure = failures.get(ip);
        if (failure && failure.until < Date.now()) failures.delete(ip);
        assert(
          !failures.get(ip) || failures.get(ip).count < 20,
          'Слишком много попыток. Повторите через минуту.',
          429,
        );
        if (!equal(req.headers.authorization || '', `Bearer ${token}`)) {
          const f = failures.get(ip) || { count: 0, until: Date.now() + 60000 };
          f.count++;
          failures.set(ip, f);
          throw Object.assign(new Error('Неверный ключ доступа'), {
            status: 401,
          });
        }
        failures.delete(ip);
      }
      let raw = Buffer.alloc(0);
      for await (const chunk of req) {
        assert(
          raw.length + chunk.length <= 131072,
          'Слишком большой запрос',
          413,
        );
        raw = Buffer.concat([raw, chunk]);
      }
      let body = {};
      if (raw.length) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw Object.assign(new Error('Некорректный JSON'), { status: 400 });
        }
      }
      if (webhook) {
        assert(req.method === 'POST', 'Метод не поддерживается', 405);
        const p = store.get('projects', webhook[1]);
        assert(p, 'Проект не найден', 404);
        const signature =
          'sha256=' +
          createHmac('sha256', p.secret.webhookSecret)
            .update(raw)
            .digest('hex');
        assert(
          equal(signature, req.headers['x-hub-signature-256'] || ''),
          'Неверная подпись',
          401,
        );
        if (req.headers['x-github-event'] === 'ping') return send({ ok: true });
        const normalize = (url) =>
          String(url || '')
            .replace(/\.git\/?$/, '')
            .replace(/\/$/, '');
        if (
          !p.autoDeploy ||
          req.headers['x-github-event'] !== 'push' ||
          body.deleted ||
          body.ref !== `refs/heads/${p.branch}` ||
          normalize(body.repository?.clone_url) !== normalize(p.repo)
        )
          return send({ ignored: true });
        const delivery = req.headers['x-github-delivery'];
        assert(
          typeof delivery === 'string' && delivery.length < 128,
          'Отсутствует идентификатор доставки',
        );
        const id = p.id + ':' + delivery;
        if (store.db.prepare('SELECT id FROM deliveries WHERE id=?').get(id))
          return send({ duplicate: true });
        const job = engine.enqueue('deploy', {
          projectId: p.id,
          source: 'Git push',
        });
        store.db
          .prepare('INSERT INTO deliveries VALUES(?,?)')
          .run(id, new Date().toISOString());
        return send(job, 202);
      }
      if (req.method === 'GET' && path === '/api/state')
        return send(store.snapshot());
      if (req.method === 'POST' && path === '/api/servers/fingerprint') {
        const input = serverInput(body);
        return send({ fingerprint: await fingerprint(input) });
      }
      if (req.method === 'POST' && path === '/api/servers') {
        const input = serverInput(body);
        assert(
          /^SHA256:[A-Za-z0-9+/]{43}$/.test(body.fingerprint || ''),
          'Подтвердите отпечаток SSH-ключа',
        );
        assert(
          body.password || body.privateKey,
          'Укажите SSH-пароль или приватный ключ',
        );
        const s = {
          ...input,
          id: randomUUID(),
          fingerprint: body.fingerprint,
          status: 'offline',
          cpu: null,
          memory: null,
          disk: null,
          specs: 'Не проверен',
          secret: body.privateKey
            ? { privateKey: body.privateKey }
            : { password: body.password },
        };
        assert(
          !store
            .list('servers')
            .some((x) => x.host === s.host && x.port === s.port),
          'Этот сервер уже подключён',
          409,
        );
        await engine.refresh(s);
        return send(store.snapshot(), 201);
      }
      const sm = path.match(
        /^\/api\/servers\/([a-f0-9-]+)\/(refresh|provision)$/,
      );
      if (req.method === 'POST' && sm) {
        const s = store.get('servers', sm[1]);
        assert(s, 'Сервер не найден', 404);
        if (sm[2] === 'provision')
          return send(engine.enqueue('provision', { serverId: s.id }), 202);
        try {
          await engine.refresh(s);
        } catch {
          Object.assign(s, {
            status: 'offline',
            cpu: null,
            memory: null,
            disk: null,
            checkedAt: new Date().toISOString(),
          });
          store.save('servers', s);
          throw new Error('Сервер недоступен. Проверьте SSH-соединение.');
        }
        return send(store.snapshot());
      }
      if (req.method === 'POST' && path === '/api/projects') {
        const input = projectInput(body);
        assert(store.get('servers', input.serverId), 'Выберите сервер');
        assert(
          !store.list('projects').some((p) => p.name === input.name),
          'Такое имя уже занято',
          409,
        );
        const p = {
          ...input,
          id: randomUUID(),
          status: 'stopped',
          color: ['mint', 'blue', 'purple', 'orange'][
            store.list('projects').length % 4
          ],
          updatedAt: new Date().toISOString(),
          commit: '—',
          envKeys: envEntries(body.env || '').map((e) => e[0]),
        };
        store.save('projects', p, {
          env: body.env || '',
          webhookSecret: randomBytes(32).toString('hex'),
        });
        return send(p, 201);
      }
      const pm = path.match(
        /^\/api\/projects\/([a-f0-9-]+)(?:\/(deploy|restart|stop|migrate|logs|webhook))?$/,
      );
      if (pm) {
        const p = store.get('projects', pm[1]);
        assert(p, 'Проект не найден', 404);
        if (req.method === 'PATCH' && !pm[2]) {
          assert(
            !store
              .list('jobs')
              .some(
                (j) =>
                  j.projectId === p.id &&
                  ['pending', 'deploying'].includes(j.status),
              ),
            'Дождитесь завершения текущей операции',
            409,
          );
          if (body.env !== undefined) {
            p.envKeys = envEntries(body.env).map((e) => e[0]);
            p.secret.env = body.env;
          }
          if (body.autoDeploy !== undefined) p.autoDeploy = !!body.autoDeploy;
          store.save('projects', p);
          return send({ ok: true });
        }
        if (req.method === 'POST' && pm[2] === 'webhook') {
          p.secret.webhookSecret = randomBytes(32).toString('hex');
          store.save('projects', p);
          return send({
            url: `${publicUrl}/api/webhooks/github/${p.id}`,
            secret: p.secret.webhookSecret,
          });
        }
        if (req.method === 'GET' && pm[2] === 'logs') {
          const s = store.get('servers', p.serverId);
          const client = await connect(s);
          try {
            const output = await run(
              client,
              `${compose(p)} logs --no-color --tail 200`,
              { timeout: 20000 },
            );
            return send({
              logs: redact(
                output,
                envEntries(p.secret.env).map((e) => e[1]),
              ).split('\n'),
            });
          } finally {
            client.end();
          }
        }
        if (
          req.method === 'POST' &&
          ['deploy', 'restart', 'stop', 'migrate'].includes(pm[2])
        ) {
          if (pm[2] === 'migrate')
            assert(
              body.confirmDowntime === true,
              'Подтвердите остановку проекта на время переноса',
            );
          return send(
            engine.enqueue(pm[2] === 'migrate' ? 'migration' : pm[2], {
              projectId: p.id,
              target: body.target,
            }),
            202,
          );
        }
      }
      send({ error: 'Маршрут не найден' }, 404);
    } catch (e) {
      send(
        {
          error: e.status
            ? e.message
            : 'Операция не выполнена. Проверьте настройки сервера и репозитория.',
        },
        e.status || 500,
      );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, engine };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.loadEnvFile('.env.runner');
  } catch {}
  const token = process.env.EZDEPLOY_TOKEN;
  const key = process.env.EZDEPLOY_ENCRYPTION_KEY;
  assert(token?.length >= 32, 'Выполните npm run runner:setup');
  assert(
    /^[a-f0-9]{64}$/i.test(key || ''),
    'Задайте EZDEPLOY_ENCRYPTION_KEY: 32 байта в hex',
  );
  const store = openStore(
    process.env.EZDEPLOY_DATA_DIR || '.runner-data',
    Buffer.from(key, 'hex'),
  );
  const { server, engine } = createApp({
    store,
    token,
    origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim()),
    publicUrl: process.env.EZDEPLOY_PUBLIC_URL || '',
  });
  server.listen(
    Number(process.env.PORT || 8788),
    process.env.HOST || '127.0.0.1',
    () =>
      console.log(
        `ezdeploy runner: ${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8788}`,
      ),
  );
  async function shutdown() {
    server.close();
    await engine.drain();
    store.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
