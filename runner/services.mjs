import { assert } from './security.mjs';
import {
  findService,
  listServices,
  serviceBinding,
  serviceInput,
  serviceHasRuntime,
  serviceRecordKey,
  serviceSources,
  sourceKey,
} from './service-model.mjs';
import {
  createServiceDrafts,
  discoveredDirectory,
  serviceDraftAgent,
} from './service-drafts.mjs';
import {
  checkServiceHttp,
  inspectServices,
  readServiceLogs,
  runtimeError,
  withServiceMachine,
} from './service-runtime.mjs';

const refreshInterval = 30000;
const observationExpiry = 90000;

const initialStatus = (service) =>
  service.source.type === 'manual' ? 'unconfigured' : 'unknown';
const watches = (service) =>
  service.source.type !== 'manual' || !!service.healthUrl;
const connectionKey = (machine) =>
  JSON.stringify([
    machine.transport,
    machine.platform,
    machine.host,
    machine.port,
    machine.username,
    machine.fingerprint,
    machine.secret,
  ]);

const sourceKeys = (service) => serviceSources(service).map(sourceKey);
const sharesSource = (left, right) =>
  sourceKeys(left).some((key) => sourceKeys(right).includes(key));
const sumMeasured = (entries, key) =>
  entries.length && entries.every((entry) => Number.isFinite(entry[key]))
    ? entries.reduce((sum, entry) => sum + entry[key], 0)
    : undefined;

function serviceMeasurement(service, machine, inventory, connectionError) {
  const components = serviceSources(service).map((source) => {
    const error =
      connectionError ||
      (!serviceHasRuntime(machine, source)
        ? 'Источник недоступен на выбранной машине.'
        : inventory && runtimeError(inventory, source));
    const entry = inventory?.records.get(sourceKey(source));
    return {
      source,
      error: error || undefined,
      status: error ? 'unknown' : entry?.status || 'missing',
      startedAt: entry?.startedAt,
      restarts: entry?.restarts,
      health: entry?.health,
      instances: entry?.instances,
      cpuCores: entry?.cpuCores,
      memoryBytes: entry?.memoryBytes,
      unitState: entry?.unitState,
    };
  });
  if (!components.length)
    return { status: initialStatus(service), error: connectionError };
  if (components.length === 1) {
    const { source: _source, ...entry } = components[0];
    return entry;
  }
  const available = components.filter((entry) => entry.status !== 'unknown');
  const errors = [
    ...new Set(components.map((entry) => entry.error).filter(Boolean)),
  ];
  const running = components.filter((entry) => entry.status === 'running');
  const times = running
    .map((entry) => entry.startedAt)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const checks = components.map((entry) => entry.health).filter(Boolean);
  const first = components[0].status;
  return {
    status: components.every((entry) => entry.status === first)
      ? first
      : 'degraded',
    error: available.length ? undefined : errors.join(' '),
    startedAt: times.length === components.length ? times.at(-1) : undefined,
    health: checks.includes('unhealthy')
      ? 'unhealthy'
      : checks.includes('starting')
        ? 'starting'
        : checks[0],
    cpuCores: sumMeasured(running, 'cpuCores'),
    memoryBytes: sumMeasured(running, 'memoryBytes'),
    restarts: sumMeasured(components, 'restarts'),
    components,
  };
}

function repoKey(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.host + url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
  } catch {
    return '';
  }
}

export function createServices({
  store,
  machine,
  save,
  accounts,
  openProcess,
  connectors,
  withMachine = withServiceMachine,
  completeDraft,
}) {
  const observations = new Map();
  const pending = new Map();
  const attempts = new Map();
  const controller = new AbortController();
  const drafts = createServiceDrafts({
    withMachine,
    complete:
      completeDraft ||
      serviceDraftAgent({ store, accounts, openProcess, connectors }),
    projectForDirectory: (machineId, directory) =>
      directory
        ? store
            .list('settings')
            .find(
              (record) =>
                record.recordType === 'workspace' &&
                record.machineId === machineId &&
                record.path === directory,
            )?.id || null
        : null,
  });
  let batches;

  function snapshotOf(service) {
    const {
      recordType: _type,
      serviceId: _serviceId,
      history: _history,
      secret: _secret,
      ...data
    } = service;
    const seen = observations.get(service.id);
    if (seen?.binding !== serviceBinding(service))
      return { ...data, status: initialStatus(service) };
    const { binding: _binding, ...measure } = seen;
    if (Date.now() - Date.parse(measure.attemptedAt) > observationExpiry)
      return {
        ...data,
        status: initialStatus(service),
        checkedAt: measure.checkedAt,
        error: 'Данные проверки устарели.',
      };
    return { ...data, ...measure };
  }

  function get(id) {
    const service = findService(store, id);
    assert(service, 'Сервис не найден', 404);
    return service;
  }

  function remember(service, measure) {
    const row = findService(store, service.id);
    const binding = serviceBinding(service);
    if (!row || binding !== serviceBinding(row)) return;
    const seen = observations.get(service.id);
    if (!measure.checkedAt && seen?.binding === binding)
      measure.checkedAt = seen.checkedAt;
    observations.set(service.id, { ...measure, binding });
    if (row.recordType !== 'service') return;
    const event = {
      at: measure.attemptedAt,
      status: measure.status,
      health: measure.health || null,
      http: measure.http?.status || null,
    };
    const history = row.history || [];
    const last = history.at(-1);
    if (
      last?.status === event.status &&
      last.health === event.health &&
      last.http === event.http
    )
      return;
    const record = store.get('settings', serviceRecordKey(service.id));
    store.save('settings', {
      ...record,
      history: [...history, event].slice(-30),
    });
  }

  async function sample(machineId) {
    const services = listServices(store).filter(
      (s) => s.machineId === machineId && watches(s),
    );
    if (!services.length) return;
    const selected = machine(machineId);
    const identity = connectionKey(selected);
    const sources = services
      .flatMap(serviceSources)
      .filter((source) => serviceHasRuntime(selected, source));
    const attemptedAt = new Date().toISOString();
    const http = new Map();
    let inventory, error;
    try {
      await withMachine(
        selected,
        async (execute) => {
          const inspection = inspectServices(execute, selected, sources, {
            collectStats: true,
          });
          const urls = [
            ...new Set(
              services.map((service) => service.healthUrl).filter(Boolean),
            ),
          ];
          for (let offset = 0; offset < urls.length; offset += 4)
            await Promise.all(
              urls.slice(offset, offset + 4).map(async (url) => {
                http.set(url, await checkServiceHttp(execute, selected, url));
              }),
            );
          inventory = await inspection;
        },
        controller.signal,
      );
    } catch (reason) {
      error = reason.message;
    }
    if (controller.signal.aborted) return;
    const current = store.get('servers', machineId);
    if (!current || connectionKey(current) !== identity) return;
    const checkedAt = new Date().toISOString();
    for (const service of services) {
      const measure = serviceMeasurement(service, selected, inventory, error);
      const endpoint = service.healthUrl
        ? http.get(service.healthUrl)
        : undefined;
      remember(service, {
        ...measure,
        attemptedAt,
        checkedAt:
          measure.error ||
          measure.status === 'unknown' ||
          (service.source.type === 'manual' && endpoint?.status === 'unknown')
            ? undefined
            : checkedAt,
        http: service.healthUrl
          ? endpoint || { status: 'unknown', code: null }
          : undefined,
      });
    }
  }

  function refreshMachine(id, force = false) {
    if (controller.signal.aborted || !store.get('servers', id))
      return Promise.resolve();
    const current = pending.get(id);
    if (current)
      return force ? current.then(() => refreshMachine(id, true)) : current;
    if (!force && Date.now() - (attempts.get(id) || 0) < 10000)
      return Promise.resolve();
    attempts.set(id, Date.now());
    const task = sample(id)
      .catch(() => {})
      .finally(() => pending.delete(id));
    pending.set(id, task);
    return task;
  }

  function refreshAll() {
    if (batches || controller.signal.aborted) return;
    const machines = [
      ...new Set(
        listServices(store)
          .filter(watches)
          .map((s) => s.machineId),
      ),
    ];
    if (!machines.length) return;
    batches = (async () => {
      for (let offset = 0; offset < machines.length; offset += 4)
        await Promise.all(
          machines.slice(offset, offset + 4).map((id) => refreshMachine(id)),
        );
    })().finally(() => {
      batches = undefined;
    });
  }
  const timer = setInterval(refreshAll, refreshInterval);
  timer.unref();

  function input(body, selected, options) {
    const service = serviceInput(body, selected, options);
    if (service.projectId) {
      assert(
        typeof service.projectId === 'string' &&
          store.get('settings', service.projectId)?.recordType === 'workspace',
        'Проект не найден',
        404,
      );
    }
    return service;
  }

  function saveService(body, previous) {
    const selected = machine(body.machineId ?? previous?.machineId);
    assert(
      !previous?.legacy || selected.id === previous.machineId,
      'Машина прежнего развёртывания определяется его настройками',
      409,
    );
    const service = input(body, selected, { previous });
    const changed =
      !previous || serviceBinding(previous) !== serviceBinding(service);
    if (serviceSources(service).length)
      assert(
        !listServices(store).some(
          (entry) =>
            entry.id !== service.id &&
            entry.machineId === selected.id &&
            sharesSource(entry, service),
        ),
        'Этот источник уже привязан к другому сервису на машине',
        409,
      );
    saveRecord(service);
    if (changed) {
      observations.delete(service.id);
      if (watches(service)) void refreshMachine(selected.id, true);
    }
    return snapshotOf({
      ...service,
      legacy: previous?.legacy,
    });
  }

  function saveRecord(service) {
    save({
      ...service,
      id: serviceRecordKey(service.id),
      serviceId: service.id,
    });
  }

  function chatDraft(body, session) {
    const selected = machine(session.machineId);
    const service = serviceInput(body, selected);
    const projects = store
      .list('settings')
      .filter((entry) => entry.recordType === 'workspace');
    const explicit = projects.find((entry) => entry.id === session.projectId);
    const sameDirectory =
      service.directory &&
      projects.find(
        (entry) =>
          entry.machineId === service.machineId &&
          entry.path === service.directory,
      );
    const key = repoKey(service.repo);
    const sameRepo = key
      ? projects.filter((entry) => repoKey(entry.repo) === key)
      : [];
    const { id: _id, recordType: _type, createdAt: _at, ...fields } = service;
    return {
      ...fields,
      projectId:
        explicit?.id ||
        sameDirectory?.id ||
        (sameRepo.length === 1 ? sameRepo[0].id : null),
    };
  }

  function saveChatDrafts(machineId, cards, finish) {
    const selected = machine(machineId);
    const existing = listServices(store).filter(
      (service) => service.machineId === machineId,
    );
    const created = [];
    const receipts = cards.map((card) => {
      if (card.result) return { id: card.id, ...card.result };
      const service = input(card.fields, selected);
      const keys = sourceKeys(service);
      const conflicts = existing.filter((item) => sharesSource(item, service));
      const sameManual = (item) =>
        !serviceSources(item).length &&
        !keys.length &&
        item.name.toLowerCase() === service.name.toLowerCase() &&
        item.directory === service.directory;
      const match =
        conflicts.find((item) =>
          keys.every((key) => sourceKeys(item).includes(key)),
        ) || existing.find(sameManual);
      assert(
        match || !conflicts.length,
        'Часть компонентов уже привязана к «' +
          (conflicts[0]?.name || '') +
          '». Уточните состав карточки перед сохранением.',
        409,
      );
      if (match) return { id: card.id, serviceId: match.id, existing: true };
      assert(
        !created.some(
          (item) => sharesSource(item, service) || sameManual(item),
        ),
        'В выбранных карточках повторяются компоненты или названия ручных сервисов.',
        409,
      );
      created.push(service);
      return { id: card.id, serviceId: service.id, existing: false };
    });
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const service of created) saveRecord(service);
      finish(receipts);
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
    if (created.some(watches)) void refreshMachine(selected.id, true);
    return receipts;
  }

  async function discover(body) {
    const selected = machine(body.machineId);
    const services = new Map(
      listServices(store)
        .filter((s) => s.machineId === selected.id)
        .flatMap((s) => sourceKeys(s).map((key) => [key, s.id])),
    );
    return withMachine(
      selected,
      async (execute) => {
        const inventory = await inspectServices(execute, selected);
        const candidates = Array.from(inventory.records, ([key, entry]) => ({
          source: entry.source,
          name: entry.name,
          description: entry.description?.slice(0, 500) || '',
          directory: discoveredDirectory(entry.directory, selected),
          status: entry.status,
          serviceId: services.get(key),
        })).sort(
          (a, b) =>
            Number(b.status === 'running') - Number(a.status === 'running') ||
            a.name.localeCompare(b.name),
        );
        return { candidates, warnings: inventory.warnings };
      },
      controller.signal,
    );
  }

  async function handle(path, method, body, send) {
    const root = '/api/hub/services';
    if (!(path === root || path.startsWith(root + '/'))) return false;
    if (method === 'POST' || method === 'PATCH')
      assert(
        body && typeof body === 'object' && !Array.isArray(body),
        'Укажите поля сервиса',
      );
    if (method === 'POST') {
      if (path === root) {
        send(saveService(body), 201);
        return true;
      }
      if (path === root + '/discover') {
        send(await discover(body));
        return true;
      }
      if (path === root + '/refresh') {
        if (body.machineId) void refreshMachine(machine(body.machineId).id);
        else refreshAll();
        send({ ok: true }, 202);
        return true;
      }
      if (path === root + '/drafts') {
        const selected = machine(body.machineId);
        send(
          drafts.start(input(body, selected, { draft: true }), selected),
          202,
        );
        return true;
      }
    }
    const draft = /^\/api\/hub\/services\/drafts\/([a-f0-9-]+)$/.exec(path);
    if (draft && ['GET', 'DELETE'].includes(method)) {
      send(drafts.get(draft[1], method === 'DELETE'));
      return true;
    }
    const match =
      /^\/api\/hub\/services\/([a-f0-9-]+)(\/logs(?:\/(\d+))?)?$/.exec(path);
    if (match && method === 'GET') {
      const service = get(match[1]);
      if (match[2]) {
        const selected = machine(service.machineId);
        const source = serviceSources(service)[Number(match[3] || 0)];
        assert(
          source && serviceHasRuntime(selected, source),
          'Укажите источник логов сервиса',
          409,
        );
        send(
          await withMachine(
            selected,
            (execute) => readServiceLogs(execute, selected, { source }),
            controller.signal,
          ),
        );
      } else send({ ...snapshotOf(service), history: service.history || [] });
      return true;
    }
    if (match && !match[2] && method === 'PATCH') {
      send(saveService(body, get(match[1])));
      return true;
    }
    return false;
  }

  const startup = setImmediate(refreshAll);
  startup.unref();
  return {
    handle,
    chatDraft,
    saveChatDrafts,
    list: () => listServices(store).map(snapshotOf),
    forgetServices(ids) {
      for (const id of ids) observations.delete(id);
    },
    forgetMachine(id) {
      attempts.delete(id);
      drafts.forgetMachine(id);
    },
    close() {
      controller.abort();
      drafts.close();
      clearImmediate(startup);
      clearInterval(timer);
    },
  };
}
