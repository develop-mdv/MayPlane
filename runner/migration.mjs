import { domainName } from './managed-deploy.mjs';
import {
  createMigrationAssistant,
  targetIssues,
  isResourceConflict,
  unresolvedMigrationQuestions,
  validateMigrationAssistant,
} from './migration-assistant.mjs';
import { envFromEntries } from './adoption.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { assert, q } from './security.mjs';
import * as ssh from './ssh.mjs';
const hostProgram = readFileSync(
  new URL('./migration-host.py', import.meta.url),
  'utf8',
);
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (s) => [s?.id, s?.host, s?.port, s?.username, s?.fingerprint];
const scope = (p, source, target) =>
  hash([
    p.id,
    p.serverId,
    p.repo,
    p.branch,
    p.composeFile,
    p.adoption?.id,
    p.workflow?.id,
    p.httpPort,
    p.domain,
    identity(source),
    identity(target),
  ]);
export const migrationLocked = (p) => !!p.migration?.locked;
export function migrationOptions(body = {}) {
  const list = (value, max) => {
    assert(
      Array.isArray(value || []) && (value || []).length <= max,
      'Слишком много параметров переноса',
    );
    return [
      ...new Set((value || []).map((x) => String(x).trim()).filter(Boolean)),
    ];
  };
  const paths = list(body.paths, 50),
    units = list(body.units, 20);
  assert(
    paths.every(
      (p) =>
        p.startsWith('/') &&
        p.length <= 500 &&
        Array.from(p).every((char) => char.charCodeAt(0) >= 32) &&
        !p.split('/').includes('..'),
    ),
    'Укажите абсолютные пути к данным приложения',
  );
  assert(
    units.every((u) => /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,180}\.service$/.test(u)),
    'Укажите имена служб .service',
  );
  const check = String(body.check || '').trim();
  assert(
    check.length <= 8000 && !check.includes('\0'),
    'Слишком длинная команда проверки',
  );
  const mode = body.mode || 'standard';
  assert(
    ['standard', 'llm'].includes(mode),
    'Выберите обычный перенос или перенос с LLM',
  );
  const conflictPolicy = body.conflictPolicy || 'ask';
  assert(
    ['ask', 'archive-stopped', 'stop-archive'].includes(conflictPolicy),
    'Некорректный способ разрешения конфликтов',
  );
  const intent = String(body.intent || '').trim();
  assert(
    intent.length <= 8000 && !intent.includes('\0'),
    'Слишком длинное описание переноса',
  );
  const directory = body.directory || '';
  assert(
    typeof directory === 'string' &&
      (!directory ||
        (directory.startsWith('/') &&
          directory.length <= 500 &&
          !directory.split('/').includes('..') &&
          Array.from(directory).every((c) => c.charCodeAt(0) >= 32))),
    'Некорректный каталог переноса',
  );
  const resources = list(body.resources, 50);
  assert(
    resources.every((id) => /^[a-f0-9]{64}$/.test(id)),
    'Некорректный ID контейнера',
  );
  const stopSignal = body.stopSignal || '';
  assert(
    ['', 'SIGTERM', 'SIGINT', 'SIGQUIT'].includes(stopSignal),
    'Выберите безопасный сигнал остановки контейнера',
  );
  return {
    paths,
    units,
    check,
    mode,
    intent,
    directory,
    resources,
    stopSignal,
    conflictPolicy,
  };
}
export function createMigration(store, overrides = {}) {
  const { connect, run, copyFile, rootOf } = { ...ssh, ...overrides };
  const assistant = createMigrationAssistant(store, overrides);
  const remote =
    overrides.migrationRemote ||
    (async (client, action, data) => {
      const delimiter = 'EZ_MIGRATION_' + randomUUID().replaceAll('-', '');
      let output;
      try {
        output = await run(
          client,
          `python3 -c ${q(hostProgram)} <<'${delimiter}'\n${JSON.stringify({ action, data })}\n${delimiter}`,
          {
            timeout: [
              'snapshot',
              'restore',
              'archive-conflicts',
              'stop-archive-conflicts',
              'conflict-plan',
            ].includes(action)
              ? 3600000
              : 180000,
            limit: 32 * 1024 * 1024,
          },
        );
      } catch {
        throw new Error(
          `Не выполнен этап переноса «${action}». Проверьте SSH, Python 3 и GNU tar на сервере.`,
        );
      }
      const result = JSON.parse(output.trim());
      assert(result.ok, result.error || 'Проверка переноса не выполнена');
      return result.data;
    });
  function inventoryRequest(p, options) {
    const a = p.adoption;
    const docker = a && ['docker', 'compose'].includes(a.runtime);
    const directory =
      a?.git?.root || a?.directory || options.directory || rootOf(p);
    return {
      runtime:
        docker || options.resources?.length
          ? 'docker'
          : a?.runtime === 'systemd'
            ? 'systemd'
            : 'auto',
      directory,
      composeProject: a?.runtime === 'compose' ? a.name : 'ez_' + p.id,
      resources: docker ? a.resources : options.resources || [],
      units: [
        ...new Set([
          ...(a?.runtime === 'systemd' ? a.units || [a.unit] : []),
          ...options.units,
        ]),
      ],
      configFiles: docker ? a.configFiles || [] : [],
      paths: options.paths,
      stopSignal: options.stopSignal,
    };
  }
  function savePlan(p, plan) {
    const fresh = store.get('projects', p.id);
    fresh.secret.migrationPlan = plan;
    fresh.migrationPlan = {
      id: plan.id,
      jobId: plan.jobId,
      savedPlanId: plan.savedPlanId || plan.id,
      sourceId: p.serverId,
      targetId: plan.targetId,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      runtime: plan.inventory?.runtime,
      bytes: plan.inventory?.bytes || 0,
      paths: (plan.inventory?.datasets || []).map((d) => ({
        path: d.source,
        volume: d.volume,
        bytes: d.bytes,
      })),
      resources:
        plan.inventory?.runtime === 'docker'
          ? plan.inventory.containers.map((c) => c.Name.replace(/^\//, ''))
          : Object.keys(plan.inventory?.units || {}),
      blockers: plan.blockers,
      warnings: plan.warnings,
      hasCustomCheck: !!plan.options.check,
      stopSignal: plan.options.stopSignal || '',
      mode: plan.options.mode,
      preparationIssues: plan.preparationIssues || [],
      conflictResolution: plan.conflictResolution
        ? {
            available: plan.conflictResolution.available,
            requiresStop: !!plan.conflictResolution.requiresStop,
            policy: plan.options.conflictPolicy,
            selected: plan.conflictResolution.selected,
            reason: plan.conflictResolution.reason,
            resources: plan.conflictResolution.resources,
            paths: plan.conflictResolution.paths,
            bytes: plan.conflictResolution.bytes,
          }
        : undefined,
      draftOptions: {
        intent: plan.options.intent,
        paths: plan.options.paths,
        units: plan.options.units,
        stopSignal: plan.options.stopSignal,
      },
      assistant:
        plan.assistant && !plan.invalidAssistant
          ? {
              summary: plan.assistant.summary,
              model: plan.assistant.model,
              prepare: plan.assistant.prepare,
              configure: plan.assistant.configure,
              questions: plan.assistant.questions,
              notes: plan.assistant.notes,
              check: plan.options.check,
            }
          : null,
    };
    if (
      plan.assistant &&
      plan.assistantValidated &&
      !plan.invalidAssistant &&
      (!plan.savedPlanId || !fresh.secret.savedMigrationPlan)
    ) {
      fresh.secret.savedMigrationPlan = structuredClone(plan);
      fresh.savedMigrationPlan = structuredClone(fresh.migrationPlan);
    }
    store.save('projects', fresh);
  }
  function owners(p, inv) {
    for (const other of store
      .list('projects')
      .filter((x) => x.id !== p.id && x.serverId === p.serverId)) {
      const base =
        other.adoption?.git?.root || other.adoption?.directory || rootOf(other);
      assert(
        !inv.datasets.some(
          (d) =>
            !d.volume &&
            (base === d.source ||
              base.startsWith(d.source + '/') ||
              d.source.startsWith(base + '/')),
        ),
        'Каталог пересекается с другим проектом: ' + other.name,
      );
      if (inv.runtime === 'docker')
        assert(
          !other.adoption?.resources?.some((id) =>
            inv.containers.some((c) => c.Id === id),
          ),
          'Контейнер привязан к другому проекту',
        );
      else
        assert(
          !(other.adoption?.units || [other.adoption?.unit]).some(
            (unit) => unit && inv.units[unit],
          ),
          'Служба привязана к другому проекту',
        );
    }
  }
  async function conflicts(target, p, inventory, report, options) {
    if (
      options.mode !== 'llm' ||
      !(report.blockers || []).some(isResourceConflict)
    )
      return null;
    try {
      const resolution = await remote(target, 'conflict-plan', {
        inventory,
        allowRunning: true,
      });
      owners({ ...p, serverId: p._targetId }, resolution.inventory);
      return {
        ...resolution,
        available: true,
        selected:
          options.conflictPolicy === 'stop-archive' ||
          (options.conflictPolicy === 'archive-stopped' &&
            !resolution.requiresStop),
      };
    } catch (e) {
      return {
        available: false,
        selected: false,
        reason: e.message,
        resources: [],
        paths: [],
      };
    }
  }
  async function prepare(source, p, job, log) {
    const destination = store.get('servers', job.target);
    const sourceServer = store.get('servers', p.serverId);
    assert(
      destination && destination.id !== p.serverId,
      'Выберите другой сервер',
    );
    const saved = job.savedPlanId
      ? [p.secret.savedMigrationPlan, p.secret.migrationPlan].find(
          (plan) => plan?.id === job.savedPlanId,
        )
      : null;
    if (job.savedPlanId) {
      assert(
        saved && saved.targetId === job.target,
        'Сохранённый план не найден',
        409,
      );
      if (saved.options.mode === 'llm')
        validateMigrationAssistant(saved.assistant);
      assert(
        saved.scope === scope(p, sourceServer, destination),
        'Проект или подключение к серверу изменились. Создайте новый план переноса.',
        409,
      );
    }
    const options = migrationOptions(
      saved
        ? {
            ...saved.options,
            conflictPolicy: p.secret.migrationOptions.conflictPolicy,
          }
        : p.secret.migrationOptions,
    );
    const plan = {
      id: randomUUID(),
      jobId: job.id,
      targetId: job.target,
      ...(saved ? { savedPlanId: saved.id } : {}),
      options,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      scope: scope(p, sourceServer, destination),
      blockers: [],
      warnings: [],
    };
    let target;
    try {
      log(
        'Проверяем состав приложения и его локальные хранилища. Приложение продолжает работать.',
      );
      if (saved)
        log(
          'Используем сохранённый план. Повторно проверяем серверы без запроса к LLM.',
        );
      let initialError = '',
        initialReport;
      try {
        plan.inventory = await remote(
          source,
          'inventory',
          inventoryRequest(p, options),
        );
        owners(p, plan.inventory);
      } catch (error) {
        if (options.mode !== 'llm') throw error;
        initialError = error.message;
      }
      target = await connect(destination);
      if (plan.inventory) {
        try {
          initialReport = await remote(target, 'preflight', {
            inventory: plan.inventory,
          });
        } catch (error) {
          initialReport = { blockers: [error.message], warnings: [] };
        }
      }
      if (plan.inventory && initialReport) {
        plan.conflictResolution = await conflicts(
          target,
          { ...p, _targetId: job.target },
          plan.inventory,
          initialReport,
          options,
        );
        initialReport.conflictResolution = plan.conflictResolution
          ? {
              available: plan.conflictResolution.available,
              requiresStop: !!plan.conflictResolution.requiresStop,
              policy: plan.options.conflictPolicy,
              selected: plan.conflictResolution.selected,
              reason: plan.conflictResolution.reason,
            }
          : null;
      }
      if (options.mode === 'llm') {
        plan.assistant = saved
          ? structuredClone(saved.assistant)
          : await assistant.plan({
              source,
              target,
              project: p,
              options,
              inventory: plan.inventory,
              error: initialError,
              report: initialReport,
              remote,
              log,
            });
        let proposal;
        try {
          proposal = validateMigrationAssistant(plan.assistant);
        } catch (e) {
          plan.invalidAssistant = true;
          throw e;
        }
        Object.assign(
          options,
          migrationOptions({
            ...options,
            paths: [...new Set([...options.paths, ...proposal.paths])],
            units: [...new Set([...options.units, ...proposal.units])],
            directory: p.adoption
              ? ''
              : proposal.directory || options.directory,
            resources:
              p.adoption && p.adoption.runtime !== 'directory'
                ? []
                : proposal.resources,
            check: options.check || proposal.check,
            stopSignal: options.stopSignal || proposal.stopSignal,
          }),
        );
        plan.options = options;
        plan.assistantValidated = true;
        plan.warnings.push(...proposal.notes);

        plan.inventory = await remote(
          source,
          'inventory',
          inventoryRequest(p, options),
        );
        owners(p, plan.inventory);
      }
      if (saved?.inventory)
        assert(
          plan.inventory.fingerprint === saved.inventory.fingerprint,
          'Состав приложения изменился после подготовки плана. Создайте новый план переноса.',
          409,
        );
      await remote(source, 'source-space', { bytes: plan.inventory.bytes });
      let report;
      try {
        report = await remote(target, 'preflight', {
          inventory: plan.inventory,
        });
      } catch (error) {
        report = { blockers: [error.message], warnings: [] };
      }
      plan.conflictResolution = await conflicts(
        target,
        { ...p, _targetId: job.target },
        plan.inventory,
        report,
        options,
      );
      const classification = targetIssues(
        report,
        plan.assistant,
        plan.conflictResolution,
      );
      plan.blockers.push(
        ...unresolvedMigrationQuestions(
          plan.assistant?.questions,
          plan.conflictResolution,
          report,
        ),
        ...classification.blockers,
      );
      plan.preparationIssues = classification.preparationIssues;
      plan.warnings.push(...(report.warnings || []));
      if (domainName(p.domain) || p.managedDomain)
        plan.warnings.push(
          'Домен и внешние прокси нужно переключить на новый сервер. DNS не изменяется автоматически.',
        );
      if (!options.check)
        plan.warnings.push(
          'Проверяются процессы и Docker healthcheck. Для проверки функций приложения добавьте свою команду проверки.',
        );
      if (p.workflow)
        plan.warnings.push(
          'После переноса кнопки управления будут работать с перенесёнными ресурсами. Прежний сценарий сохранится в резервной записи.',
        );
      if (plan.inventory.runtime === 'docker')
        plan.warnings.push(
          'Сохраняются также анонимные тома и изменения внутри контейнеров. Внешние БД и хранилища остаются внешними.',
        );
      savePlan(p, plan);
      if (plan.blockers.length && options.mode === 'llm')
        job.outcome = 'needs_input';
      assert(
        !plan.blockers.length,
        (options.mode === 'llm'
          ? 'Выберите решение или ответьте помощнику в форме переноса: '
          : 'Перенос пока недоступен: ') + plan.blockers.join('; '),
      );
      log(
        'Проверка завершена. Состав переноса доступен в разделе «Перенос проектов». Подтвердите его перед остановкой.',
      );
    } catch (error) {
      if (!plan.blockers.length) plan.blockers = [error.message];
      savePlan(p, plan);
      throw error;
    } finally {
      target?.end();
    }
  }
  function transition(p, migration, phase, extra = {}) {
    Object.assign(
      migration,
      { phase, updatedAt: new Date().toISOString() },
      extra,
    );
    const fresh = store.get('projects', p.id);
    fresh.migration = { ...migration };
    if (migration.locked) {
      fresh.autoDeploy = false;
      fresh.status = 'needs_setup';
    }
    store.save('projects', fresh);
  }
  function credentialsUnchanged(p, record) {
    const source = store.get('servers', record.sourceId),
      target = store.get('servers', record.targetId);
    assert(
      hash([identity(source), identity(target)]) === record.identities,
      'Адрес или SSH-ключ одного из серверов изменился; требуется проверка переноса.',
      409,
    );
    return { source, target };
  }
  async function applicationCheck(client, p, record, log) {
    if (record.options.check) {
      const directory =
        p.adoption?.directory || record.options.directory || rootOf(p);
      await run(client, `cd ${q(directory)}\n${record.options.check}`, {
        timeout: 120000,
      });
      log('Дополнительная проверка приложения пройдена.');
    }
    if (
      p.kind === 'web' &&
      Number.isInteger(p.httpPort) &&
      p.httpPort > 0 &&
      p.httpPort <= 65535
    ) {
      const domain = /^[A-Za-z0-9.-]+$/.test(p.domain || '')
        ? p.domain
        : 'localhost';
      const response = await run(
        client,
        `curl --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' -H ${q('Host: ' + domain)} ${q('http://127.0.0.1:' + p.httpPort + '/')}`,
        { timeout: 20000 },
      );
      assert(
        /^[234]\d\d$/.test(response.trim()),
        'HTTP-проверка новой копии не прошла',
      );
      log('HTTP-проверка новой копии пройдена.');
    }
  }
  async function finish(source, target, p, record, log) {
    const data = { inventory: record.inventory, job: record.jobId };
    const result = await remote(target, 'health', data);
    await applicationCheck(target, p, record, log);
    await remote(source, 'verify-source', data);
    await remote(target, 'enable', data);
    const fresh = store.get('projects', p.id);
    const sourceAdoption = fresh.adoption;
    const unit = Object.keys(record.inventory.units || {})[0];
    const directory =
      sourceAdoption?.directory || record.options.directory || rootOf(p);
    const migratedAdoption = {
      images: [],
      ports: [],
      mounts: [],
      configFiles: [],
      warnings: [],
      sourceFiles: [],
      envFile: '',
      environmentSource: 'panel',
      environmentConflicts: [],
      ...sourceAdoption,
      id: record.jobId,
      migrationId: record.jobId,
      runtime:
        record.inventory.runtime === 'docker'
          ? sourceAdoption?.runtime === 'compose' || !sourceAdoption
            ? 'compose'
            : 'docker'
          : 'systemd',
      name: sourceAdoption?.name || unit || 'ez_' + p.id,
      directory,
      resources: [...result.resources],
      status: 'running',
      linkedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      ...(unit
        ? {
            unit,
            units: Object.keys(record.inventory.units),
            unitFiles: Object.fromEntries(
              Object.entries(record.inventory.units).map(([name, u]) => [
                name,
                u.FragmentPath,
              ]),
            ),
            fragmentPath: record.inventory.units[unit].FragmentPath,
          }
        : {}),
    };
    if (record.inventory.runtime === 'docker') {
      migratedAdoption.images = record.inventory.containers.map(
        (_, i) => 'ezdeploy-migration-' + record.jobId + ':c' + i,
      );
      migratedAdoption.ports = [
        ...new Set(
          record.inventory.containers.flatMap((c) =>
            Object.entries(c.HostConfig.PortBindings || {}).flatMap(
              ([port, bindings]) =>
                (bindings || []).map(
                  (b) =>
                    (b.HostIp || '0.0.0.0') + ':' + b.HostPort + ' → ' + port,
                ),
            ),
          ),
        ),
      ];
      migratedAdoption.mounts = record.inventory.containers.flatMap((c) =>
        c.Mounts.map((m) => ({
          type: m.Type,
          source: m.Name || m.Source,
          target: m.Destination,
          name: m.Name || '',
          readOnly: !m.RW,
        })),
      );
    } else {
      migratedAdoption.ports = (record.inventory.ports || []).map(
        ([protocol, port]) => port + '/' + protocol,
      );
      migratedAdoption.configFiles = Object.keys(
        record.inventory.configHashes || {},
      );
    }
    fresh.secret.migrationRecord.previousWorkflow ||= fresh.secret.workflow;
    delete fresh.secret.workflow;
    delete fresh.workflow;
    delete fresh.assistant;
    delete fresh.secret.plan;
    fresh.adoption = migratedAdoption;
    fresh.secret.adopted ||= { sourceFiles: {}, envByService: [] };
    fresh.secret.adopted.binding = migratedAdoption;
    if (record.inventory.runtime === 'docker') {
      fresh.secret.adopted.envByService = record.inventory.containers.map(
        (c) => ({
          name:
            c.Config.Labels?.['com.docker.compose.service'] ||
            c.Name.replace(/^\//, ''),
          env: envFromEntries(c.Config.Env || []),
        }),
      );
    }
    fresh.secret.adopted.configuration =
      record.inventory.runtime === 'docker'
        ? {
            containers: record.inventory.containers.map((c, i) => ({
              ...c,
              Id: result.resources[i],
            })),
          }
        : { units: record.inventory.units };
    delete fresh.discovery;
    delete fresh.secret.discovery;
    delete fresh.secret.workflowDraft;
    delete fresh.secret.assistantPlan;
    delete fresh.secret.migrationRepairPlan;
    delete fresh.migrationRepairPlan;
    fresh.serverId = record.targetId;
    fresh.status = 'running';
    fresh.autoDeploy = false;
    fresh.updatedAt = new Date().toISOString();
    delete fresh.managedDomain;
    if (fresh.httpPort) {
      const s = store.get('servers', record.targetId);
      fresh.publicUrl = `http://${s.host.includes(':') ? '[' + s.host + ']' : s.host}:${fresh.httpPort}`;
    } else delete fresh.publicUrl;
    const steps =
      domainName(fresh.domain) || p.managedDomain
        ? [
            'Направьте DNS и reverse proxy домена на новый сервер. Затем проверьте HTTPS.',
          ]
        : [];
    fresh.deploymentChecks = {
      checkedAt: new Date().toISOString(),
      httpStatus: null,
      steps,
    };
    fresh.migration = {
      ...fresh.migration,
      phase: steps.length ? 'awaiting_dns' : 'complete',
      locked: false,
      needsRecovery: false,
      finishedAt: new Date().toISOString(),
    };
    store.save('projects', fresh);
    log(
      'Данные восстановлены и проверены. Новая копия работает. Исходная копия сохранена с отключённым автозапуском.',
    );
    if (steps.length) log(steps.join(' '));
  }
  async function execute(source, p, job, log) {
    const plan = p.secret.migrationPlan;
    const destination = store.get('servers', job.target);
    assert(
      plan &&
        plan.id === job.planId &&
        plan.targetId === job.target &&
        !plan.blockers.length,
      'Сначала выполните проверку переноса',
      409,
    );
    assert(
      Date.parse(plan.expiresAt) > Date.now(),
      'Проверка устарела. Выполните её заново.',
      409,
    );
    assert(
      plan.scope === scope(p, store.get('servers', p.serverId), destination),
      'Настройки изменились. Повторите проверку переноса.',
      409,
    );
    if (plan.assistant) validateMigrationAssistant(plan.assistant);
    const target = await connect(destination);
    let record, migration;
    try {
      let inventory = await remote(
        source,
        'inventory',
        inventoryRequest(p, plan.options),
      );
      owners(p, inventory);
      assert(
        inventory.fingerprint === plan.inventory.fingerprint,
        'Состав приложения изменился. Повторите проверку.',
        409,
      );
      await remote(source, 'source-space', { bytes: inventory.bytes });
      let report;
      try {
        report = await remote(target, 'preflight', { inventory });
      } catch (error) {
        report = { blockers: [error.message] };
      }
      const resolution = await conflicts(
        target,
        { ...p, _targetId: job.target },
        inventory,
        report,
        plan.options,
      );
      if (resolution?.selected)
        assert(
          plan.conflictResolution?.selected &&
            resolution.fingerprint === plan.conflictResolution.fingerprint,
          'Конфликтующие ресурсы изменились. Повторите проверку.',
          409,
        );
      const classification = targetIssues(report, plan.assistant, resolution);
      assert(
        !classification.blockers.length,
        classification.blockers.join('; '),
      );
      record = {
        jobId: job.id,
        sourceId: p.serverId,
        targetId: job.target,
        inventory,
        options: plan.options,
        assistant: plan.assistant,
        autoDeploy: p.autoDeploy,
        identities: hash([
          identity(store.get('servers', p.serverId)),
          identity(destination),
        ]),
      };
      migration = {
        jobId: job.id,
        sourceId: p.serverId,
        targetId: job.target,
        locked: true,
        needsRecovery: false,
        targetMayHaveWritten: false,
        sourceMayHaveStopped: false,
        backupPath: '/opt/ezdeploy-migrations/' + job.id,
      };
      const fresh = store.get('projects', p.id);
      fresh.secret.migrationRecord = record;
      store.save('projects', fresh);
      if (resolution?.selected && resolution.available) {
        transition(p, migration, 'preparing_target');
        const archiveId = randomUUID();
        log(
          'Сохраняем конфликтующую копию в /opt/ezdeploy-migrations/' +
            archiveId +
            '. Источник продолжает работать.',
        );
        const current = store.get('projects', p.id);
        current.migrationArchives = [
          ...(current.migrationArchives || []),
          {
            serverId: job.target,
            path: '/opt/ezdeploy-migrations/' + archiveId,
            createdAt: new Date().toISOString(),
            jobId: job.id,
            status: 'creating',
          },
        ];
        store.save('projects', current);
        try {
          await remote(
            target,
            resolution.requiresStop
              ? 'stop-archive-conflicts'
              : 'archive-conflicts',
            {
              inventory,
              resolution,
              job: archiveId,
            },
          );
          const fresh = store.get('projects', p.id);
          fresh.migrationArchives.find((a) =>
            a.path.endsWith(archiveId),
          ).status = 'complete';
          store.save('projects', fresh);
        } catch (e) {
          const fresh = store.get('projects', p.id);
          fresh.migrationArchives.find((a) =>
            a.path.endsWith(archiveId),
          ).status = 'failed';
          store.save('projects', fresh);
          throw e;
        }
        log(
          'Архив проверен; конфликтующие имена освобождены. Прежние данные сохранены.',
        );
      }
      if (record.assistant?.prepare?.length) {
        transition(p, migration, 'preparing_target');
        await assistant.execute(record.assistant.prepare, {
          client: target,
          project: p,
          record,
          sourceServer: store.get('servers', p.serverId),
          targetServer: destination,
          run,
          log,
        });
        const current = await remote(
          source,
          'inventory',
          inventoryRequest(p, plan.options),
        );
        assert(
          current.fingerprint === inventory.fingerprint,
          'Состав приложения изменился во время подготовки. Повторите проверку.',
        );
        owners(p, current);
        inventory = current;
        record.inventory = current;
        const updated = store.get('projects', p.id);
        updated.secret.migrationRecord = record;
        store.save('projects', updated);
        await remote(source, 'source-space', { bytes: inventory.bytes });
      }
      // Every target check must pass after preparation, before source downtime.
      const prepared = await remote(target, 'preflight', { inventory });
      assert(!prepared.blockers.length, prepared.blockers.join('; '));
      transition(p, migration, 'stopping', { sourceMayHaveStopped: true });
      log(
        'Отключаем автозапуск исходной копии и останавливаем запись данных.' +
          (record.options.stopSignal
            ? ' Сигнал: ' + record.options.stopSignal + '.'
            : ''),
      );
      await remote(source, 'stop', { inventory, job: job.id });
      transition(p, migration, 'snapshot');
      log(
        'Создаём копию файлов, прав доступа, томов и файловой системы контейнеров.',
      );
      const snapshot = await remote(source, 'snapshot', {
        inventory,
        job: job.id,
      });
      transition(p, migration, 'copying');
      await remote(target, 'reserve', { job: job.id });
      for (const file of snapshot.files) {
        assert(
          file.startsWith(migration.backupPath + '/') &&
            !file.split('/').includes('..'),
          'Некорректный файл копии',
        );
        log('Передаём ' + file.slice(file.lastIndexOf('/') + 1) + '…');
        await copyFile(source, target, file);
        log(
          file.slice(file.lastIndexOf('/') + 1) +
            ': передан, SHA-256 совпадает.',
        );
      }
      transition(p, migration, 'restoring');
      await remote(target, 'restore', { job: job.id });
      log(
        'Восстановленные файлы проверены: содержимое, владельцы, права и атрибуты совпадают.',
      );
      await remote(source, 'verify-source', { inventory, job: job.id });
      // Persist this before any target start, including a start that times out or loses SSH.
      transition(p, migration, 'starting', { targetMayHaveWritten: true });
      if (record.assistant?.configure?.length) {
        await assistant.execute(record.assistant.configure, {
          client: target,
          project: p,
          record,
          sourceServer: store.get('servers', p.serverId),
          targetServer: destination,
          run,
          log,
        });
        await remote(target, 'accept-config', { inventory, job: job.id });
      }
      await remote(target, 'start', { inventory, job: job.id });
      transition(p, migration, 'verifying');
      await finish(source, target, p, record, log);
    } catch (error) {
      if (record) {
        if (!migration.targetMayHaveWritten) {
          try {
            if (migration.sourceMayHaveStopped !== false)
              await remote(source, 'resume-source', {
                inventory: record.inventory,
                job: record.jobId,
              });
            transition(p, migration, 'rolled_back', {
              locked: false,
              needsRecovery: false,
            });
            const fresh = store.get('projects', p.id);
            fresh.status = 'running';
            fresh.autoDeploy = record.autoDeploy;
            store.save('projects', fresh);
            log(
              'Новая копия не запускалась. Исходное приложение снова работает; резервные копии сохранены.',
            );
          } catch {
            transition(p, migration, 'recovery', { needsRecovery: true });
            log(
              'Не удалось восстановить запуск источника. Используйте восстановление переноса.',
            );
          }
        } else {
          transition(p, migration, 'recovery', { needsRecovery: true });
          log(
            'Новая копия могла получить данные. Автоматический возврат к старой копии запрещён. Продолжите восстановление на новом сервере; обе копии сохранены.',
          );
        }
      }
      throw error;
    } finally {
      target.end();
    }
  }
  async function repairPlan(source, p, job, log) {
    const record = p.secret.migrationRecord;
    assert(
      record && p.migration?.needsRecovery && p.migration.targetMayHaveWritten,
      'Новая копия ещё не запускалась; восстановите исходное приложение',
    );
    const servers = credentialsUnchanged(p, record);
    const target = await connect(servers.target);
    try {
      const proposal = await assistant.plan({
        source,
        target,
        project: p,
        options: {
          ...record.options,
          intent:
            p.secret.migrationRepairIntent ||
            'Исправь ошибку переноса на новой копии, сохраняя её текущие данные.',
        },
        inventory: record.inventory,
        error: store
          .list('jobs')
          .filter((j) => j.projectId === p.id && j.status === 'failed')
          .slice(0, 2)
          .map((j) => j.logs.slice(-12))
          .flat()
          .join('\n'),
        remote,
        log,
        recovery: true,
      });
      assert(
        !proposal.prepare.length &&
          !proposal.paths.length &&
          !proposal.units.length &&
          !proposal.resources.length,
        'План восстановления не должен изменять состав данных или пересоздавать перенос',
      );
      const plan = {
        id: randomUUID(),
        jobId: job.id,
        recordJobId: record.jobId,
        identities: record.identities,
        expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
        assistant: proposal,
      };
      const fresh = store.get('projects', p.id);
      fresh.secret.migrationRepairPlan = plan;
      fresh.migrationRepairPlan = {
        id: plan.id,
        jobId: plan.jobId,
        expiresAt: plan.expiresAt,
        assistant: {
          summary: proposal.summary,
          model: proposal.model,
          configure: proposal.configure,
          check: proposal.check,
          questions: proposal.questions,
        },
      };
      store.save('projects', fresh);
      assert(!proposal.questions.length, proposal.questions.join('; '));
      log(
        'План восстановления готов. Проверьте команды и подтвердите их в форме переноса. Новые данные не копируются и не заменяются.',
      );
    } finally {
      target.end();
    }
  }
  async function recover(source, p, job, log) {
    const record = p.secret.migrationRecord;
    assert(
      record && p.migration?.locked && p.migration.needsRecovery,
      'Нет переноса для восстановления',
      409,
    );
    const servers = credentialsUnchanged(p, record);
    if (job.repairPlanId) {
      const plan = p.secret.migrationRepairPlan;
      assert(
        plan &&
          plan.id === job.repairPlanId &&
          plan.recordJobId === record.jobId &&
          plan.identities === record.identities &&
          Date.parse(plan.expiresAt) > Date.now() &&
          !plan.assistant.questions.length,
        'План восстановления устарел или требует ответа. Выполните проверку ещё раз.',
      );
      assert(
        p.migration.targetMayHaveWritten,
        'Нет новой копии для восстановления',
      );
      record.assistant = {
        ...record.assistant,
        prepare: [],
        configure: plan.assistant.configure,
      };
      record.options = {
        ...record.options,
        check: plan.assistant.check || record.options.check,
      };
      const fresh = store.get('projects', p.id);
      fresh.secret.migrationRecord = record;
      store.save('projects', fresh);
    }
    const migration = { ...p.migration };
    if (!migration.targetMayHaveWritten) {
      if (migration.sourceMayHaveStopped !== false)
        await remote(source, 'resume-source', {
          inventory: record.inventory,
          job: record.jobId,
        });
      transition(p, migration, 'rolled_back', {
        locked: false,
        needsRecovery: false,
      });
      const fresh = store.get('projects', p.id);
      fresh.status = 'running';
      fresh.autoDeploy = record.autoDeploy;
      store.save('projects', fresh);
      log(
        'Запуск исходного приложения восстановлен. Резервные копии сохранены.',
      );
      return;
    }
    const target = await connect(servers.target);
    try {
      await remote(source, 'verify-source', {
        inventory: record.inventory,
        job: record.jobId,
      });
      if (record.assistant?.configure?.length) {
        await assistant.execute(record.assistant.configure, {
          client: target,
          project: p,
          record,
          sourceServer: servers.source,
          targetServer: servers.target,
          run,
          log,
        });
        await remote(target, 'accept-config', {
          inventory: record.inventory,
          job: record.jobId,
        });
      }
      await remote(target, 'start', {
        inventory: record.inventory,
        job: record.jobId,
      });
      await finish(source, target, p, record, log);
    } finally {
      target.end();
    }
  }
  return { prepare, execute, recover, repairPlan };
}
