import { deleteProjectCard } from './project-delete.mjs';
import { migrationLocked } from './migration.mjs';
import { createAdoption } from './adoption.mjs';
import {
  getEnvDefinitions,
  refreshEnvState,
} from '../lib/env-requirements.mjs';
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
  projectMetadata,
  serverInput,
  redact,
  requestPath,
} from './security.mjs';
import { connect, fingerprint, run, compose } from './ssh.mjs';
import { createEngine } from './engine.mjs';
import { readChat, operatorSecrets } from './operator.mjs';
import { createWorkflowRunner, saveWorkflow } from './workflows.mjs';
import { attachTerminals } from './terminal.mjs';
import { createServerEditor, serverCredentials } from './server-editor.mjs';
import { createGithub } from './github.mjs';
import {
  llmPublic,
  llmInput,
  chatJson,
  saveLlmModel,
  deleteLlmModel,
  resolveLlmModel,
} from './llm.mjs';
import { domainName } from './managed-deploy.mjs';
import { createHub } from './hub.mjs';
import { createOwnerAuth } from './owner-auth.mjs';
import { proxyFrontend, browserSecurityHeaders } from './web-proxy.mjs';
import { runtimeConfig } from './config.mjs';

export function createApp({
  store,
  token,
  origins = [],
  publicUrl = '',
  engine = createEngine(store),
  terminalOptions = {},
  github = createGithub(),
  llmChat = chatJson,
  hubOptions = {},
  legacyApi = false,
  ownerAuth = false,
  trustProxy = false,
  managedTls = false,
  frontendUrl = '',
}) {
  assert(
    ownerAuth || (typeof token === 'string' && token.length > 0),
    'Требуется настроенная авторизация владельца',
  );
  const auth = ownerAuth
    ? createOwnerAuth(store.db, {
        origins,
        publicUrl,
        trustProxy,
        managedTls,
        onRevoke: (id) => terminals.revokeOwner(id),
        onRevokeAll: () => {
          terminals.revokeOwner();
          hub.connectors.cancelPairings();
        },
      })
    : null;
  const failures = new Map();
  const server = createServer(async (req, res) => {
    browserSecurityHeaders(res, { publicUrl, development: !frontendUrl });
    let path;
    try {
      assert(
        req.url?.startsWith('/') && !req.url.startsWith('//'),
        'Некорректный адрес',
        400,
      );
      path = new URL(req.url, 'http://localhost').pathname;
    } catch {
      res.writeHead(400);
      return res.end('Некорректный адрес');
    }
    if (path === '/healthz' && req.method === 'GET') {
      res.writeHead(auth && !auth.configured() ? 503 : 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({ ok: !auth || auth.configured() }));
    }
    if (!path.startsWith('/api/') && frontendUrl)
      return proxyFrontend(req, res, frontendUrl);
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
        'Authorization, Content-Type, X-MayPlane-CSRF',
      );
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, DELETE, OPTIONS',
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
      const webhook = path.match(/^\/api\/webhooks\/github\/([a-f0-9-]+)$/);
      let ownerSession;
      const authRoute = auth && path.startsWith('/api/auth/');
      if (!webhook && !authRoute && auth) ownerSession = auth.requireOwner(req);
      if (!webhook && !authRoute && !auth) {
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
          raw.length + chunk.length <= (authRoute ? 8192 : 131072),
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
      if (authRoute && (await auth.handle(path, req, res, body, send))) return;
      if (
        path.startsWith('/api/hub') &&
        (await hub.handle(path, req.method, body, send))
      )
        return;
      if (
        !legacyApi &&
        path !== '/api/state' &&
        path !== '/api/servers/fingerprint' &&
        path !== '/api/servers' &&
        !/^\/api\/servers\/[a-f0-9-]+(?:\/terminal-ticket)?$/.test(path)
      ) {
        return send(
          {
            error:
              'Прежние операции деплоя отключены. Используйте проекты и диалоги рабочего пространства.',
          },
          410,
        );
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
      if (req.method === 'GET' && path === '/api/state') {
        const snapshot = store.snapshot();
        snapshot.projects = snapshot.projects.map((record) => {
          const p = store.get('projects', record.id);
          refreshEnvState(p);

          return {
            ...record,
            envDefinitions: getEnvDefinitions(p),
            filledEnvKeys: p.filledEnvKeys,
            requiredEnvKeys: p.requiredEnvKeys,
            missingEnvKeys: p.missingEnvKeys,
          };
        });
        return send({ ...snapshot, llm: llmPublic(store) });
      }
      if (path === '/api/llm/settings' && req.method === 'POST') {
        const input = llmInput(body, store.get('settings', 'llm'));
        store.save('settings', input);
        return send(llmPublic(store));
      }
      if (path === '/api/llm/models' && req.method === 'POST') {
        const input = saveLlmModel(store.get('settings', 'llm'), body);
        store.save('settings', input);
        return send(llmPublic(store), 201);
      }
      const llmModelRequest = path.match(/^\/api\/llm\/models\/([a-f0-9-]+)$/);
      if (llmModelRequest && ['PATCH', 'DELETE'].includes(req.method)) {
        const current = store.get('settings', 'llm');
        const input =
          req.method === 'DELETE'
            ? deleteLlmModel(current, llmModelRequest[1])
            : saveLlmModel(current, body, llmModelRequest[1]);
        store.save('settings', input);
        return send(llmPublic(store));
      }
      const chatRequest = path.match(
        /^\/api\/(projects|servers)\/([a-f0-9-]+)\/chat$/,
      );
      if (chatRequest) {
        const [, table, id] = chatRequest;
        assert(store.get(table, id), 'Объект не найден', 404);
        if (req.method === 'GET') return send(readChat(store, table, id));
        if (req.method === 'POST') {
          assert(
            typeof body.message === 'string' &&
              body.message.trim() &&
              body.message.length <= 8000,
            'Введите сообщение, до 8000 символов',
          );
          return send(
            engine.enqueue('chat', {
              ...(table === 'projects' ? { projectId: id } : { serverId: id }),
              intent: body.message,
              modelId: resolveLlmModel(
                store.get('settings', 'llm'),
                body.modelId,
              ).id,
            }),
            202,
          );
        }
      }
      const cancelRequest = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/cancel$/);
      if (cancelRequest && req.method === 'POST')
        return send(engine.cancel(cancelRequest[1]));
      if (path === '/api/llm/test' && req.method === 'POST') {
        const config = resolveLlmModel(
          store.get('settings', 'llm'),
          body.modelId,
        );
        assert(config.enabled, 'Эта модель отключена');
        const result = await llmChat(
          config,
          [
            { role: 'system', content: 'Return only JSON: {"ok":true}' },
            { role: 'user', content: 'Connection test' },
          ],
          { maxTokens: 1024, timeout: 20000 },
        );
        assert(
          result.data.ok === true,
          'Модель ответила не в ожидаемом формате',
        );
        return send({ ok: true, model: config.model, usage: result.usage });
      }
      if (req.method === 'POST' && path === '/api/git/connections') {
        const user = await github.user(body.token);
        const existing = store
          .list('git_connections')
          .find((c) => c.login === user.login);
        const connection = {
          id: existing?.id || randomUUID(),
          login: user.login,
          name: user.name || user.login,
          createdAt: existing?.createdAt || new Date().toISOString(),
        };
        store.save('git_connections', connection, { token: body.token });
        return send(connection, 201);
      }
      const gm = path.match(/^\/api\/git\/connections\/([a-f0-9-]+)\/repos$/);
      if (req.method === 'GET' && gm) {
        const connection = store.get('git_connections', gm[1]);
        assert(connection, 'GitHub-подключение не найдено', 404);
        return send(
          await github.repos(
            connection.secret.token,
            Number(
              new URL(req.url, 'http://localhost').searchParams.get('page') ||
                1,
            ),
          ),
        );
      }
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
        const secret = serverCredentials(body);
        const s = {
          ...input,
          id: randomUUID(),
          fingerprint: body.fingerprint,
          status: 'offline',
          cpu: null,
          memory: null,
          disk: null,
          specs: 'Не проверен',
          secret,
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
      const editRequest = path.match(/^\/api\/servers\/([a-f0-9-]+)$/);
      if (req.method === 'PATCH' && editRequest)
        return send(await editServer(editRequest[1], body));
      const terminalRequest = path.match(
        /^\/api\/servers\/([a-f0-9-]+)\/terminal-ticket$/,
      );
      if (req.method === 'POST' && terminalRequest)
        return send(
          terminals.issue(terminalRequest[1], origin, ownerSession),
          201,
        );
      const sm = path.match(
        /^\/api\/servers\/([a-f0-9-]+)\/(refresh|provision)$/,
      );
      if (req.method === 'POST' && sm) {
        const s = store.get('servers', sm[1]);
        assert(s, 'Сервер не найден', 404);
        if (sm[2] === 'provision')
          return send(engine.enqueue('provision', { serverId: s.id }), 202);
        const before = JSON.stringify(s);
        try {
          await engine.refresh(s);
        } catch (error) {
          assert(
            JSON.stringify(store.get('servers', s.id)) === before,
            'Настройки сервера изменились. Повторите проверку.',
            409,
          );
          if (error.status === 409) throw error;
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
        const input = projectInput({ ...body, branch: body.branch || 'main' });
        if ((body.resolveDefaultBranch || body.assisted) && !body.branch) {
          const token = body.gitConnectionId
            ? store.get('git_connections', body.gitConnectionId)?.secret.token
            : undefined;
          const info = await github.repo(input.repo, token);
          input.branch = projectInput({
            ...body,
            branch: info.default_branch,
          }).branch;
        }
        assert(store.get('servers', input.serverId), 'Выберите сервер');
        if (input.gitConnectionId) {
          const connection = store.get(
            'git_connections',
            input.gitConnectionId,
          );
          assert(connection, 'Выберите GitHub-подключение');
          await github.repo(input.repo, connection.secret.token);
        }
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
          missingEnvKeys: input.requiredEnvKeys.filter(
            (k) => !new Map(envEntries(body.env || '')).get(k)?.trim(),
          ),
        };
        store.save('projects', p, {
          env: body.env || '',
          webhookSecret: randomBytes(32).toString('hex'),
        });
        return send(p, 201);
      }
      const pm = path.match(
        /^\/api\/projects\/([a-f0-9-]+)(?:\/(deploy|build|restart|stop|migrate|logs|webhook|env|analyze|auto-deploy|apply-plan|diagnose|assistant|domain|workflow|remove|discover|adopt|discovery|adoption-snapshot|unlink|check|migration-choice|migration-plan|migration-recover|migration-repair-plan))?$/,
      );
      if (pm) {
        const p = store.get('projects', pm[1]);
        assert(p, 'Проект не найден', 404);
        assert(
          req.method === 'GET' ||
            ['migration-recover', 'migration-repair-plan'].includes(pm[2]) ||
            !migrationLocked(p),
          'Сначала завершите восстановление переноса проекта',
          409,
        );
        if (req.method === 'DELETE' && !pm[2])
          return send(deleteProjectCard(store, p.id, body.confirmPanelOnly));
        refreshEnvState(p);
        if (req.method === 'POST' && pm[2] === 'migration-choice') {
          const plan = p.migrationPlan;
          assert(
            plan && plan.id === body.planId && plan.sourceId === p.serverId,
            'План изменился. Откройте актуальный перенос.',
            409,
          );
          assert(body.choice === 'manual', 'Некорректный вариант подготовки');
          p.migrationDraft = {
            sourceId: plan.sourceId,
            targetId: plan.targetId,
            jobId: plan.jobId,
            mode: plan.mode || 'standard',
            updatedAt: new Date().toISOString(),
            conflictPolicy: 'ask',
            choice: 'manual',
          };
          store.save('projects', p);
          return send({ saved: true });
        }
        if (
          req.method === 'POST' &&
          [
            'migration-plan',
            'migration-recover',
            'migration-repair-plan',
          ].includes(pm[2])
        ) {
          if (pm[2] === 'migration-recover' && body.repairPlanId)
            assert(
              body.confirmLlmCommands === true,
              'Подтвердите команды LLM для восстановления',
            );
          return send(
            engine.enqueue(pm[2], {
              projectId: p.id,
              repairPlanId: body.repairPlanId,
              savedPlanId: body.savedPlanId,
              target: body.target,
              migrationOptions: body.options,
            }),
            202,
          );
        }
        if (pm[2] === 'discovery' && req.method === 'GET')
          return send({ discovery: p.secret.discovery || null });
        if (pm[2] === 'adoption-snapshot' && req.method === 'GET') {
          assert(p.secret.adopted, 'Нет снимка привязки', 404);
          return send(p.secret.adopted);
        }
        if (['discover', 'adopt'].includes(pm[2]) && req.method === 'POST') {
          if (pm[2] === 'adopt')
            assert(
              body.confirmAdopt === true,
              'Подтвердите выбранное приложение',
            );
          return send(
            engine.enqueue(pm[2], {
              projectId: p.id,
              directory: body.directory,
              scanId: body.scanId,
              candidateId: body.candidateId,
            }),
            202,
          );
        }
        if (pm[2] === 'unlink' && req.method === 'POST') {
          assert(p.adoption, 'Проект не привязан');
          assert(
            !store
              .list('jobs')
              .some(
                (j) =>
                  ['pending', 'deploying'].includes(j.status) &&
                  (j.serverId === p.serverId || j.target === p.serverId),
              ),
            'Дождитесь завершения операции',
            409,
          );
          for (const key of ['adoption', 'workflow', 'assistant', 'discovery'])
            delete p[key];
          for (const key of [
            'adopted',
            'workflow',
            'workflowDraft',
            'assistantPlan',
            'discovery',
          ])
            delete p.secret[key];
          p.status = 'stopped';
          p.autoDeploy = false;
          store.save('projects', p);
          return send({ ok: true });
        }
        if (req.method === 'POST' && pm[2] === 'domain') {
          assert(
            !p.secret.workflow && !p.adoption,
            'Для своего сценария настройте домен через чат проекта.',
          );
          const domain = domainName(body.domain);
          assert(
            !body.domain || domain,
            'Укажите домен, например app.example.com',
          );
          assert(
            p.kind === 'web' && p.status === 'running',
            'Сначала разверните сайт',
          );
          return send(
            engine.enqueue('domain', { projectId: p.id, domain }),
            202,
          );
        }
        if (req.method === 'GET' && pm[2] === 'assistant')
          return send({
            plan: p.assistant || null,
            files:
              p.assistant?.runtime === 'commands'
                ? p.secret.workflowDraft?.files || {}
                : p.secret.assistantPlan?.files || {},
            diagnosis: p.diagnosis || null,
          });
        if (
          req.method === 'POST' &&
          ['analyze', 'auto-deploy', 'apply-plan', 'diagnose'].includes(pm[2])
        )
          return send(
            engine.enqueue(pm[2], {
              projectId: p.id,
              intent: body.intent,
              useLlm: body.useLlm !== false,
              planId: body.planId,
            }),
            202,
          );
        if (pm[2] === 'workflow') {
          if (req.method === 'GET')
            return send({
              workflow: p.secret.workflow || null,
              draft: p.secret.workflowDraft || null,
            });
          if (req.method === 'PATCH') {
            assert(
              !store
                .list('jobs')
                .some(
                  (job) =>
                    (job.projectId === p.id ||
                      job.serverId === p.serverId ||
                      job.target === p.serverId) &&
                    ['pending', 'deploying'].includes(job.status),
                ),
              'Дождитесь завершения операции',
              409,
            );
            saveWorkflow(store, p.id, body, 'Вручную');
            return send({ ok: true });
          }
        }
        if (req.method === 'GET' && pm[2] === 'env')
          return send({ env: p.secret.env });
        if (req.method === 'PATCH' && !pm[2]) {
          assert(
            !store
              .list('jobs')
              .some(
                (j) =>
                  (j.projectId === p.id ||
                    j.serverId === p.serverId ||
                    j.target === p.serverId) &&
                  ['pending', 'deploying'].includes(j.status),
              ),
            'Дождитесь завершения текущей операции',
            409,
          );
          const metadata = projectMetadata({
            name: body.name === undefined ? p.name : body.name,
            kind: body.kind === undefined ? p.kind : body.kind,
          });
          if (metadata.kind !== p.kind) {
            delete p.assistant;
            delete p.secret.assistantPlan;
            delete p.secret.workflowDraft;
            if (p.workflow) p.workflow.stale = true;
            delete p.diagnosis;
          }
          Object.assign(p, metadata);
          if (body.env !== undefined) {
            assert(
              !p.adoption,
              'Для привязанного приложения это снимок окружения. Изменяйте исходную конфигурацию через чат или SSH.',
            );
            p.secret.env = body.env;
            refreshEnvState(p);
          }
          if (body.autoDeploy !== undefined) {
            assert(
              !body.autoDeploy || !p.adoption || p.secret.workflow,
              'Для автодеплоя привязанного приложения сначала сохраните сценарий обновления в чате.',
            );
            p.autoDeploy = !!body.autoDeploy;
          }
          p.updatedAt = new Date().toISOString();
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
            const output = p.secret.workflow
              ? await createWorkflowRunner(store).execute(
                  client,
                  p,
                  s,
                  'logs',
                  () => {},
                )
              : p.adoption
                ? await createAdoption(store).execute(client, p, 'logs')
                : await run(
                    client,
                    `${compose(p)} logs --no-color --tail 200`,
                    {
                      timeout: 20000,
                    },
                  );
            return send({
              logs: redact(output, operatorSecrets(store)).split('\n'),
            });
          } finally {
            client.end();
          }
        }
        if (
          req.method === 'POST' &&
          [
            'deploy',
            'build',
            'restart',
            'stop',
            'remove',
            'migrate',
            'check',
          ].includes(pm[2])
        ) {
          if (pm[2] === 'deploy' && !p.adoption) {
            const values = new Map(envEntries(p.secret.env));
            const missing = (p.requiredEnvKeys || []).filter(
              (k) => !values.get(k)?.trim(),
            );
            assert(
              !missing.length,
              'Заполните переменные в карточке проекта: ' + missing.join(', '),
            );
          }
          if (pm[2] === 'remove')
            assert(
              body.confirmRemove === true,
              'Подтвердите удаление развёртывания',
            );
          if (pm[2] === 'migrate')
            assert(
              body.confirmDowntime === true && body.confirmManifest === true,
              'Подтвердите состав данных и остановку проекта на время переноса',
            );
          if (
            pm[2] === 'migrate' &&
            p.secret.migrationPlan?.options.mode === 'llm'
          )
            assert(
              body.confirmLlmCommands === true,
              'Подтвердите команды LLM из плана переноса',
            );
          if (
            pm[2] === 'migrate' &&
            p.secret.migrationPlan?.conflictResolution?.selected
          )
            assert(
              body.confirmConflictArchive === true,
              'Подтвердите архивирование перечисленных конфликтующих ресурсов',
            );
          if (
            pm[2] === 'migrate' &&
            p.secret.migrationPlan?.conflictResolution?.selected &&
            p.secret.migrationPlan.conflictResolution.requiresStop
          )
            assert(
              body.confirmConflictStop === true,
              'Подтвердите остановку перечисленных ресурсов на целевом сервере',
            );
          return send(
            engine.enqueue(pm[2] === 'migrate' ? 'migration' : pm[2], {
              projectId: p.id,
              target: body.target,
              planId: body.planId,
              deleteProject: body.deleteProject === true,
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
  const terminals = attachTerminals(server, {
    ...terminalOptions,
    store,
    origins,
    authorizeOwner: auth ? (req) => auth.requireOwner(req, false) : undefined,
    ownerActive: auth ? (id) => auth.active(id) : undefined,
  });
  const editServer = createServerEditor(store, engine, terminals);
  const hub = createHub(server, store, { publicUrl, ...hubOptions });
  server.once('close', () => hub.close());
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('upgrade', (req, socket) => {
    const path = requestPath(req.url) || '';
    if (
      path !== '/api/connector' &&
      !/^\/api\/servers\/[a-f0-9-]+\/terminal$/.test(path)
    )
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });
  return { server, engine, terminals, hub, auth };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const config = runtimeConfig();
  const store = openStore(config.dataDir, config.key);
  const { server, engine, terminals, hub } = createApp({
    store,
    ownerAuth: true,
    origins: config.origins,
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    managedTls: process.env.MAYPLANE_TLS_MANAGED === 'true',
    legacyApi: config.legacyApi,
  });
  assert(
    store.db.prepare('SELECT id FROM owner_credentials WHERE id=1').get(),
    'Сначала выполните npm run runner:setup для создания логина владельца.',
  );
  server.listen(config.port, config.host, () =>
    console.log(
      `MayPlane runner: ${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8788}`,
    ),
  );
  async function shutdown() {
    hub.close();
    terminals.close();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      engine.drain(),
    ]);
    store.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
