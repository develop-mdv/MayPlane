import {
  createMigration,
  migrationLocked,
  migrationOptions as normalizeMigrationOptions,
} from './migration.mjs';
import { cancellableJobs } from '../lib/job-actions.mjs';
import {
  currentOperation,
  checkCancellation,
  withCancellation,
  withoutCancellation,
} from './cancellation.mjs';
import { createAdoption, adoptionDirectory } from './adoption.mjs';
import { deploymentEnv, refreshEnvState } from '../lib/env-requirements.mjs';
import { randomUUID } from 'node:crypto';
import * as ssh from './ssh.mjs';
import { repositoryName } from './github.mjs';
import { createAssistant } from './assistant.mjs';
import { createOperator, operatorSecrets } from './operator.mjs';
import { scrub } from './repository-context.mjs';
import {
  prepareGeneratedFiles,
  validateAutomaticCompose,
  publishEndpoint,
} from './managed-deploy.mjs';
import { assert, q, envEntries, redact } from './security.mjs';
import { resolveLlmModel } from './llm.mjs';

export function createEngine(store, overrides = {}) {
  const transport = { ...ssh, ...overrides };
  const checked =
    (method) =>
    async (...args) => {
      checkCancellation();
      if (currentOperation() && ['run', 'put', 'copyFile'].includes(method))
        currentOperation().remoteStarted = true;
      const result = await transport[method](...args);
      if (method === 'connect' && currentOperation()?.controller.signal.aborted)
        result.end();
      checkCancellation();
      return result;
    };
  const dependencies = {
    ...transport,
    connect: checked('connect'),
    run: checked('run'),
    put: checked('put'),
    copyFile: checked('copyFile'),
  };
  const { connect, run, put, compose, rootOf, workspaceOf, metrics } =
    dependencies;
  const adoption = createAdoption(store, dependencies);
  const migration = createMigration(store, dependencies);
  const assistant = createAssistant(store, overrides.assistantOptions);
  const operator = createOperator(store, {
    ...dependencies,
    ...overrides.operatorOptions,
  });
  const operations = new Map();
  let queue = Promise.resolve();
  // Never replay an interrupted destructive operation automatically.
  for (const job of store.list('jobs'))
    if (['pending', 'deploying'].includes(job.status)) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.logs.push(
        'Исполнитель был перезапущен. Проверьте контейнеры на обоих серверах перед повтором.',
      );
      store.save('jobs', job);
      if (
        job.projectId &&
        ![
          'analyze',
          'migration-plan',
          'migration-repair-plan',
          'diagnose',
          'build',
          'domain',
          'chat',
          'discover',
          'adopt',
          'check',
        ].includes(job.type)
      ) {
        const p = store.get('projects', job.projectId);
        if (p) {
          p.status = migrationLocked(p) ? 'needs_setup' : 'failed';
          if (migrationLocked(p))
            Object.assign(p.migration, {
              needsRecovery: true,
              phase: 'recovery',
            });
          store.save('projects', p);
        }
      }
    }
  // Durable migration state survives rotation of the 100-job history window.
  for (const project of store.list('projects')) {
    if (!migrationLocked(project)) continue;
    const p = store.get('projects', project.id);
    p.status = 'needs_setup';
    p.autoDeploy = false;
    Object.assign(p.migration, { needsRecovery: true, phase: 'recovery' });
    store.save('projects', p);
  }
  async function inspect(server) {
    const client = await connect(server);
    try {
      return await metrics(client);
    } finally {
      client.end();
    }
  }
  async function refresh(server) {
    const before = JSON.stringify(store.get('servers', server.id));
    const measured = await inspect(server);
    assert(
      JSON.stringify(store.get('servers', server.id)) === before,
      'Настройки сервера изменились. Повторите проверку.',
      409,
    );
    Object.assign(server, measured);
    store.save('servers', server);
    return server;
  }
  async function execute(job) {
    let project = job.projectId ? store.get('projects', job.projectId) : null;
    if (project) refreshEnvState(project);
    const server = store.get('servers', job.serverId || project?.serverId);
    const gitConnection = project?.gitConnectionId
      ? store.get('git_connections', project.gitConnectionId)
      : null;
    const gitHeader = gitConnection
      ? 'Authorization: Basic ' +
        Buffer.from('x-access-token:' + gitConnection.secret.token).toString(
          'base64',
        )
      : '';
    const secrets = [
      gitConnection?.secret.token,
      gitHeader,
      gitHeader.replace('Authorization: Basic ', ''),
      server?.secret.password,
      server?.secret.privateKey,
      ...(project ? envEntries(project.secret.env).map((e) => e[1]) : []),
    ].filter(Boolean);
    const log = (line) => {
      job.cancelRequested ||= store.get('jobs', job.id)?.cancelRequested;
      job.logs.push(scrub(redact(line, secrets), operatorSecrets(store)));
      job.logs = job.logs.slice(-2000);
      store.save('jobs', job);
    };
    job.cancelRequested ||= store.get('jobs', job.id)?.cancelRequested;
    job.status = 'deploying';
    store.save('jobs', job);
    let client;
    try {
      checkCancellation();
      assert(server, 'Сервер не найден');
      if (
        [
          'migration-plan',
          'migration',
          'migration-recover',
          'migration-repair-plan',
        ].includes(job.type)
      ) {
        client = await connect(server);
        await migration[
          job.type === 'migration-repair-plan'
            ? 'repairPlan'
            : job.type === 'migration-plan'
              ? 'prepare'
              : job.type === 'migration-recover'
                ? 'recover'
                : 'execute'
        ](client, project, job, log);
        job.status = 'success';
        return;
      }
      if (['discover', 'adopt'].includes(job.type)) {
        client = await connect(server);
        if (job.type === 'discover')
          await adoption.discover(client, project, server, job.directory, log);
        else await adoption.attach(client, project, server, job, log);
        job.status = 'success';
        return;
      }
      if (
        project?.adoption &&
        !project.secret.workflow &&
        ['deploy', 'restart', 'stop', 'remove', 'check'].includes(job.type)
      ) {
        client = await connect(server);
        await adoption.execute(client, project, job.type, log);
        if (job.type === 'remove' && job.deleteProject)
          store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
        job.status = 'success';
        return;
      }
      const llmEnabled =
        job.useLlm !== false && store.get('settings', 'llm')?.enabled;
      if (job.type === 'chat' || (job.type === 'auto-deploy' && llmEnabled)) {
        client = await connect(server);
        const outcome = await operator.operate({
          project,
          server,
          client,
          job,
          log,
          intent:
            job.type === 'auto-deploy'
              ? 'Разверни этот проект. Изучи требования, сохрани воспроизводимые сценарии deploy/stop/remove/check/logs, выполни deploy и проверь результат. Если нужны ключи — запроси их через переменные проекта. Требования владельца: ' +
                job.intent
              : job.intent,
          cancelled: () => !!store.get('jobs', job.id)?.cancelRequested,
        });
        checkCancellation();
        job.outcome = outcome;
        job.status =
          outcome === 'cancelled'
            ? 'stopped'
            : outcome === 'failed'
              ? 'failed'
              : ['needs_input', 'limit'].includes(outcome)
                ? 'needs_setup'
                : 'success';
        log(
          {
            complete: 'Задача чата завершена.',
            cancelled: 'Выполнение остановлено пользователем.',
            failed: 'Помощник остановился после ошибки. Подробности — в чате.',
            needs_input:
              'Нужен ответ владельца или заполнение переменных. Продолжите в чате.',
            limit: 'Достигнут лимит шагов. Продолжение — в чате.',
          }[outcome] || 'Ход чата завершён.',
        );
        return;
      }
      if (job.type === 'analyze' && llmEnabled) {
        await operator.plan(project, server, job.intent, log);
        checkCancellation();
        job.status = 'success';
        return;
      }
      if (
        job.type === 'apply-plan' &&
        project.assistant?.runtime === 'commands'
      ) {
        operator.applyPlan(project, job.planId);
        project = store.get('projects', project.id);
      }
      if (
        project?.secret.workflow &&
        ['deploy', 'restart', 'stop', 'remove', 'check', 'apply-plan'].includes(
          job.type,
        )
      ) {
        client = await connect(server);
        await operator.workflows.execute(
          client,
          project,
          server,
          job.type === 'apply-plan' ? 'deploy' : job.type,
          log,
        );
        if (job.type === 'remove' && job.deleteProject)
          store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
        job.status = 'success';
        log('Операция выполнена по сохранённому сценарию без LLM.');
        return;
      }
      if (job.type === 'remove') {
        client = await connect(server);
        await operator.workflows.removeCompose(client, project, log);
        if (job.deleteProject)
          store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
        job.status = 'success';
        log('Развёртывание удалено. Данные и Docker volumes сохранены.');
        return;
      }
      if (job.type === 'diagnose') {
        await assistant.diagnose(project, log);
        job.status = 'success';
        return;
      }
      if (['analyze', 'auto-deploy'].includes(job.type)) {
        const plan = await assistant.prepare(project, {
          intent: job.intent,
          useLlm: job.useLlm,
          log,
        });
        checkCancellation();
        if (
          job.type === 'analyze' ||
          project.missingEnvKeys.length ||
          plan.blockers.length ||
          plan.runtime === 'manual'
        ) {
          job.status = 'success';
          log('План готов. Продолжение — в карточке проекта.');
          return;
        }
        assistant.apply(project, plan.id);
      }
      if (job.type === 'apply-plan') assistant.apply(project, job.planId);
      client = await connect(server);
      log('SSH: ключ сервера проверен, соединение установлено.');
      if (job.type === 'domain') {
        project.domain = job.domain;
        await publishEndpoint(client, project, {
          store,
          run,
          put,
          compose,
          log,
        });
        store.save('projects', project);
        job.status = 'success';
        return;
      }
      if (job.type === 'provision') {
        await run(
          client,
          `. /etc/os-release; test "$ID" = ubuntu && ( test "$VERSION_ID" = 24.04 || test "$VERSION_ID" = 26.04 ) || { echo 'Поддерживается Ubuntu 24.04 или 26.04'; exit 1; }; export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y docker.io docker-compose-v2 git ca-certificates tar; systemctl enable --now docker; install -d -m 700 /opt/ezdeploy /opt/ezdeploy-backups; docker compose version`,
          { log },
        );
        Object.assign(server, await metrics(client));
        store.save('servers', server);
      } else if (
        ['deploy', 'build', 'auto-deploy', 'apply-plan'].includes(job.type)
      ) {
        if (
          ['auto-deploy', 'apply-plan'].includes(job.type) &&
          server.status === 'needs_setup'
        ) {
          log('Готовим сервер: Docker, Compose и Git.');
          await run(
            client,
            `. /etc/os-release; test "$ID" = ubuntu && ( test "$VERSION_ID" = 24.04 || test "$VERSION_ID" = 26.04 ) || { echo 'Поддерживается Ubuntu 24.04 или 26.04'; exit 1; }; export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y docker.io docker-compose-v2 git ca-certificates tar; systemctl enable --now docker; install -d -m 700 /opt/ezdeploy /opt/ezdeploy-backups; docker compose version`,
            { log },
          );
          Object.assign(server, await metrics(client));
          store.save('servers', server);
        }
        const root = rootOf(project);
        if (job.type !== 'build') {
          const values = new Map(envEntries(project.secret.env));
          const missing = (project.requiredEnvKeys || []).filter(
            (k) => !values.get(k)?.trim(),
          );
          assert(
            !missing.length,
            'Заполните переменные в карточке проекта: ' + missing.join(', '),
          );
          project.status = 'deploying';
          store.save('projects', project);
        }
        assert(
          !project.gitConnectionId || gitConnection,
          'GitHub-подключение не найдено',
        );
        if (gitConnection) repositoryName(project.repo);
        const authPath = '/opt/ezdeploy/.auth/' + job.id;
        await run(
          client,
          `command -v git; docker compose version; install -d -m 700 ${q(root)} /opt/ezdeploy/.auth`,
          { log },
        );
        try {
          if (gitHeader) await put(client, authPath, gitHeader);
          const auth = gitHeader
            ? `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${q('http.' + project.repo + '.extraheader')}; export GIT_CONFIG_VALUE_0="$(cat ${q(authPath)})"; trap 'rm -f -- ${authPath}' EXIT;`
            : '';
          await run(
            client,
            `${auth}
export GIT_TERMINAL_PROMPT=0
if [ ! -d ${q(root + '/repo/.git')} ]; then git -c credential.helper= -c http.followRedirects=false clone --single-branch --branch ${q(project.branch)} -- ${q(project.repo)} ${q(root + '/repo')}; fi
cd ${q(root + '/repo')}
git remote set-url origin ${q(project.repo)}
git -c credential.helper= -c http.followRedirects=false fetch origin ${q(project.branch)}
${project.pendingPlanCommit ? `test "$(git rev-parse FETCH_HEAD)" = ${q(project.pendingPlanCommit)} || { echo 'Ветка обновилась. Повторите анализ перед применением плана.'; exit 1; }` : ''}
git reset --hard FETCH_HEAD
${project.secret.generatedFiles?.[project.composeFile] ? 'true' : `test -f ${q(project.composeFile)}`}
repo_root=$(pwd -P); actual=$(realpath ${q(workspaceOf(project))}); case "$actual/" in "$repo_root/"*) ;; *) echo 'Compose находится за пределами проекта'; exit 1 ;; esac
if git ls-files --error-unmatch ${q(project.composeFile.includes('/') ? project.composeFile.slice(0, project.composeFile.lastIndexOf('/') + 1) + '.env' : '.env')} >/dev/null 2>&1; then echo 'Удалите .env из Git: секреты загружаются отдельно'; exit 1; fi
test ! -L ${q(workspaceOf(project) + '/.env')}`,
            { log },
          );
        } finally {
          if (gitHeader)
            await withoutCancellation(() =>
              run(client, `rm -f -- ${q(authPath)}`, { timeout: 10000 }),
            );
        }
        if (project.managedDeployment)
          await prepareGeneratedFiles(client, project, {
            store,
            run,
            put,
            log,
          });
        await put(
          client,
          workspaceOf(project) + '/.env',
          deploymentEnv(project),
        );
        if (project.managedDeployment)
          await validateAutomaticCompose(client, project, { run, compose });
        log('.env записан с правами 0600. Значения скрыты.');
        await run(
          client,
          `${compose(project)} config -q
${compose(project)} ${job.type === 'build' ? 'build' : 'up -d --build --remove-orphans --wait --wait-timeout 120'}`,
          { log },
        );
        project.commit = (
          await run(
            client,
            `cd ${q(root + '/repo')}; git rev-parse --short HEAD`,
          )
        ).trim();
        if (job.type !== 'build') {
          project.status = 'running';
          store.save('projects', project);
        }
        delete project.pendingPlanCommit;
        if (project.managedDeployment && job.type !== 'build')
          await publishEndpoint(client, project, {
            store,
            run,
            put,
            compose,
            log,
          });
        project.updatedAt = new Date().toISOString();
        store.save('projects', project);
        if (job.type === 'build')
          log('Образ собран. Контейнеры не запускались.');
      } else {
        await run(
          client,
          `${compose(project)} ${job.type === 'stop' ? 'stop --timeout 60' : 'up -d --force-recreate --wait --wait-timeout 120'}`,
          { log },
        );
        project.status = job.type === 'stop' ? 'stopped' : 'running';
        project.updatedAt = new Date().toISOString();
        store.save('projects', project);
      }
      job.status = 'success';
      log('Операция завершена.');
    } catch (e) {
      if (currentOperation()?.controller.signal.aborted) {
        job.cancelRequested = true;
        const unconfirmed =
          currentOperation().unconfirmed || e.code === 'JOB_CANCEL_UNCONFIRMED';
        job.status = unconfirmed ? 'failed' : 'stopped';
        job.outcome = unconfirmed ? 'failed' : 'cancelled';
        log(
          unconfirmed
            ? 'Не удалось подтвердить остановку команды. Проверьте сервер перед повторным запуском.'
            : 'Операция прервана пользователем. Следующие шаги отменены. Выполненные изменения не откатывались.',
        );
        if (
          project &&
          currentOperation().remoteStarted &&
          !['build', 'analyze'].includes(job.type)
        ) {
          const fresh = store.get('projects', project.id);
          if (fresh) {
            fresh.status = 'needs_setup';
            store.save('projects', fresh);
          }
          log(
            'Проверьте состояние приложения: часть изменений могла быть применена.',
          );
        }
        return;
      }
      job.status = 'failed';
      log(
        `${job.outcome === 'needs_input' ? 'Нужно решение' : 'Ошибка'}: ${e.message}`,
      );
      if (project) {
        const fresh = store.get('projects', project.id);
        if (
          ![
            'migration',
            'migration-plan',
            'migration-repair-plan',
            'migration-recover',
            'discover',
            'adopt',
            'chat',
            'build',
            'analyze',
            'diagnose',
            'auto-deploy',
            'apply-plan',
            'domain',
          ].includes(job.type) ||
          project.status === 'deploying'
        ) {
          if (fresh) {
            fresh.status = 'failed';
            store.save('projects', fresh);
          }
        }
      }
    } finally {
      client?.end();
      job.cancelRequested ||= store.get('jobs', job.id)?.cancelRequested;
      job.finishedAt = new Date().toISOString();
      store.save('jobs', job);
    }
  }
  return {
    refresh,
    inspect,
    enqueue(
      type,
      {
        projectId,
        serverId,
        target,
        source = 'Вручную',
        intent = '',
        useLlm = true,
        planId = '',
        domain = '',
        deleteProject = false,
        directory = '',
        migrationOptions = {},
        repairPlanId = '',
        savedPlanId = '',
        scanId = '',
        candidateId = '',
        modelId = '',
      },
    ) {
      assert(
        [
          'deploy',
          'build',
          'restart',
          'stop',
          'migration',
          'migration-plan',
          'migration-repair-plan',
          'migration-recover',
          'provision',
          'discover',
          'adopt',
          'check',
          'chat',
          'remove',
          'analyze',
          'auto-deploy',
          'apply-plan',
          'diagnose',
          'domain',
        ].includes(type),
        'Неизвестная операция',
      );
      const p = projectId ? store.get('projects', projectId) : null;
      assert(!projectId || p, 'Проект не найден', 404);
      const sid = serverId || p?.serverId;
      assert(store.get('servers', sid), 'Сервер не найден', 404);
      if (['migration', 'migration-plan'].includes(type)) {
        assert(
          p && target !== sid && store.get('servers', target),
          'Выберите другой сервер',
        );
        assert(
          p.status === 'running',
          'Перенос доступен для работающего проекта',
        );
      }
      if (['migration-recover', 'migration-repair-plan'].includes(type)) {
        assert(
          p?.migration?.locked && p.migration.needsRecovery,
          'Нет переноса для восстановления',
          409,
        );
        target = p.migration.targetId;
      }
      assert(
        !store
          .list('projects')
          .some(
            (other) =>
              migrationLocked(other) &&
              !(
                ['migration-recover', 'migration-repair-plan'].includes(type) &&
                other.id === p?.id
              ) &&
              [other.migration.sourceId, other.migration.targetId].some(
                (id) => id === sid || id === target,
              ),
          ),
        'Сначала завершите восстановление переноса на этом сервере',
        409,
      );
      assert(
        !store
          .list('jobs')
          .some(
            (j) =>
              ['pending', 'deploying'].includes(j.status) &&
              ((projectId && j.projectId === projectId) ||
                j.serverId === sid ||
                j.target === sid ||
                (target && (j.serverId === target || j.target === target))),
          ),
        'Для этого сервера уже выполняется операция',
        409,
      );
      if (type === 'chat') {
        const selectedModel = resolveLlmModel(
          store.get('settings', 'llm'),
          modelId,
        );
        assert(
          selectedModel.enabled,
          'Выбранная модель отключена в настройках',
        );
        modelId = selectedModel.id;
      }
      if (type === 'build')
        assert(
          !p?.secret.workflow && !p?.adoption,
          'В сохранённом сценарии сборка выполняется вместе с развёртыванием',
        );
      if (p?.adoption && ['auto-deploy', 'analyze'].includes(type))
        assert(
          useLlm !== false && store.get('settings', 'llm')?.enabled,
          'Для настройки существующего приложения используйте чат с LLM или сохранённый сценарий.',
        );
      if (p?.adoption && type === 'apply-plan')
        assert(
          p.assistant?.runtime === 'commands',
          'Для привязанного приложения нужен план со своими командами.',
        );
      if (type === 'discover') {
        assert(p && !p.adoption, 'Проект уже привязан', 409);
        directory = adoptionDirectory(directory);
      }
      if (type === 'adopt')
        assert(
          p &&
            !p.adoption &&
            p.secret.discovery?.id === scanId &&
            p.secret.discovery.candidates.some((c) => c.id === candidateId),
          'Повторите поиск и выберите приложение',
          409,
        );
      if (type === 'check')
        assert(p?.adoption || p?.secret.workflow, 'Нет сценария проверки');
      if (type === 'migration-plan') {
        const saved = savedPlanId
          ? [p.secret.savedMigrationPlan, p.secret.migrationPlan].find(
              (plan) => plan?.id === savedPlanId,
            )
          : null;
        if (savedPlanId) {
          assert(
            saved && saved.targetId === target,
            'Сохранённый план не найден для выбранного сервера',
            409,
          );
        }
        p.secret.migrationOptions = normalizeMigrationOptions(
          saved
            ? {
                ...saved.options,
                ...(migrationOptions.conflictPolicy
                  ? { conflictPolicy: migrationOptions.conflictPolicy }
                  : {}),
              }
            : migrationOptions,
        );
        if (p.secret.migrationOptions.mode === 'llm' && !saved)
          assert(
            store.get('settings', 'llm')?.enabled,
            'Подключите LLM в настройках или выберите обычный перенос',
          );
        store.save('projects', p);
      }
      if (type === 'migration-repair-plan') {
        assert(
          store.get('settings', 'llm')?.enabled,
          'Подключите LLM в настройках',
        );
        p.secret.migrationRepairIntent =
          normalizeMigrationOptions(migrationOptions).intent;
        store.save('projects', p);
      }
      const job = {
        ...(repairPlanId ? { repairPlanId } : {}),
        ...(savedPlanId ? { savedPlanId } : {}),
        id: randomUUID(),
        type,
        ...(['analyze', 'auto-deploy', 'chat'].includes(type)
          ? {
              intent: scrub(
                String(intent).slice(0, 8000),
                operatorSecrets(store),
              ),
              useLlm: !!useLlm,
            }
          : {}),
        ...(type === 'discover' ? { directory } : {}),
        ...(type === 'adopt' ? { scanId, candidateId } : {}),
        ...(type === 'chat' ? { modelId } : {}),
        ...(planId ? { planId } : {}),
        ...(domain ? { domain } : {}),
        ...(type === 'remove' ? { deleteProject: !!deleteProject } : {}),
        projectId,
        serverId: sid,
        target,
        projectName: p?.name || store.get('servers', sid).name,
        status: 'pending',
        createdAt: new Date().toISOString(),
        source,
        logs: ['Операция поставлена в очередь.'],
      };
      if (type === 'migration-plan') {
        p.migrationDraft = {
          sourceId: p.serverId,
          targetId: target,
          jobId: job.id,
          mode: p.secret.migrationOptions.mode,
          updatedAt: job.createdAt,
          conflictPolicy: p.secret.migrationOptions.conflictPolicy,
        };
        store.save('projects', p);
      }
      store.save('jobs', job);
      const operation = {
        controller: new AbortController(),
        job,
        started: false,
        remoteStarted: false,
        unconfirmed: false,
      };
      operations.set(job.id, operation);
      queue = queue
        .then(() => {
          if (operation.controller.signal.aborted) return;
          operation.started = true;
          return withCancellation(operation, () => execute(job));
        })
        .catch(() => {})
        .finally(() => operations.delete(job.id));
      return job;
    },
    cancel(id) {
      const stored = store.get('jobs', id);
      assert(
        stored && cancellableJobs.includes(stored.type),
        'Эту операцию нельзя прервать',
        409,
      );
      if (
        stored.cancelRequested &&
        (['pending', 'deploying'].includes(stored.status) ||
          stored.outcome === 'cancelled')
      )
        return { ok: true };
      assert(
        ['pending', 'deploying'].includes(stored.status),
        'Операция уже завершена',
        409,
      );
      const operation = operations.get(id);
      assert(operation, 'Операция не выполняется этим исполнителем', 409);
      const job = operation.job;
      job.cancelRequested = true;
      job.logs.push(
        operation.started
          ? 'Запрошено прерывание текущей операции.'
          : 'Операция отменена до начала выполнения.',
      );
      if (!operation.started) {
        job.status = 'stopped';
        job.outcome = 'cancelled';
        job.finishedAt = new Date().toISOString();
      }
      store.save('jobs', job);
      operation.controller.abort();
      return { ok: true };
    },
    async drain() {
      await queue;
    },
  };
}
