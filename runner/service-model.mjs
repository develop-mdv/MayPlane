import { randomUUID } from 'node:crypto';
import { projectPath } from './machine-process.mjs';
import { assert } from './security.mjs';

const dockerName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}$/;
export const unitName = /^[a-zA-Z0-9][a-zA-Z0-9_.@:\\-]{0,239}\.service$/;

export function serviceSource(value = { type: 'manual' }) {
  assert(value && typeof value === 'object', 'Выберите источник сервиса');
  if (value.type === 'manual') return { type: 'manual' };
  if (value.type === 'systemd') {
    assert(
      typeof value.unit === 'string' && unitName.test(value.unit),
      'Укажите имя службы systemd, например app.service',
    );
    return { type: 'systemd', unit: value.unit };
  }
  if (value.type === 'docker') {
    assert(
      typeof value.container === 'string' && dockerName.test(value.container),
      'Укажите имя контейнера Docker',
    );
    return { type: 'docker', container: value.container };
  }
  assert(
    value.type === 'compose' &&
      typeof value.stack === 'string' &&
      dockerName.test(value.stack) &&
      typeof value.component === 'string' &&
      dockerName.test(value.component),
    'Укажите имена проекта и сервиса Docker Compose',
  );
  return { type: 'compose', stack: value.stack, component: value.component };
}

function text(value, max, label, required = false) {
  assert(
    typeof value === 'string' && value.length <= max,
    `${label}: до ${max} символов`,
  );
  assert(!value.includes('\0'), `Некорректное поле «${label}»`);
  assert(!required || value.trim(), `Заполните поле «${label}»`);
  return value.trim();
}

export function serviceUrl(
  value,
  health = false,
  label = health ? 'Проверка HTTP' : 'Адрес приложения',
) {
  if (value === '') return '';
  let url;
  try {
    url = new URL(text(value, 1000, label));
  } catch {
    assert(false, `Укажите корректный URL в поле «${label}»`);
  }
  assert(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    `Укажите HTTP(S)-адрес без логина, пароля и параметров в поле «${label}»`,
  );
  if (health)
    assert(
      url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname),
      'Для проверки укажите HTTP-адрес на 127.0.0.1 или [::1] на машине сервиса',
    );
  return url.href;
}

export function serviceHasRuntime(machine, source) {
  if (source.type === 'manual' || machine.transport === 'connector')
    return false;
  return source.type !== 'systemd' || (machine.platform || 'linux') === 'linux';
}

export const sourceKey = (source) => JSON.stringify(source);
export const serviceRecordKey = (id) => 'service:' + id;
export const serviceSources = (service) =>
  service.source.type === 'manual'
    ? []
    : [service.source, ...(service.additionalSources || [])];
export const serviceBinding = (s) =>
  JSON.stringify([s.machineId, serviceSources(s), s.healthUrl]);

export function serviceInput(body, machine, { previous, draft = false } = {}) {
  const values = { ...previous, ...body };
  const source = serviceSource(values.source);
  const additional = values.additionalSources ?? [];
  assert(
    Array.isArray(additional) && additional.length <= 7,
    'У одного сервиса может быть до восьми компонентов',
  );
  const additionalSources = additional.map(serviceSource);
  assert(
    (source.type === 'manual' && !additionalSources.length) ||
      [source, ...additionalSources].every((entry) =>
        serviceHasRuntime(machine, entry),
      ),
    'Этот источник недоступен на выбранной машине',
  );
  assert(
    new Set([source, ...additionalSources].map(sourceKey)).size ===
      additionalSources.length + 1,
    'Компоненты сервиса должны отличаться',
  );
  const healthUrl = serviceUrl(values.healthUrl ?? '', true);
  assert(
    !healthUrl || machine.transport !== 'connector',
    'HTTP-проверка доступна для SSH-машин и хоста панели',
  );
  const directory = text(values.directory ?? '', 1024, 'Каталог');
  const service = {
    id: previous?.id || randomUUID(),
    recordType: 'service',
    machineId: machine.id,
    projectId: values.projectId || null,
    source,
    ...(additionalSources.length ? { additionalSources } : {}),
    name: text(values.name ?? '', 100, 'Название', !draft),
    description: text(values.description ?? '', 500, 'Описание'),
    environment: text(values.environment ?? '', 40, 'Окружение'),
    notes: text(values.notes ?? '', 6000, 'Заметки'),
    directory: directory
      ? projectPath(directory, machine.platform || 'linux')
      : '',
    url: serviceUrl(values.url ?? ''),
    repo: serviceUrl(values.repo ?? '', false, 'Репозиторий'),
    healthUrl,
    createdAt: previous?.createdAt || new Date().toISOString(),
  };
  if (
    previous?.history?.length &&
    serviceBinding(previous) === serviceBinding(service)
  )
    service.history = previous.history;
  return service;
}

function legacyUrl(value) {
  try {
    return value
      ? serviceUrl(value.includes('://') ? value : `https://${value}`)
      : '';
  } catch {
    return '';
  }
}

function fromLegacy(legacy, overlay) {
  const sameMachine = overlay?.machineId === legacy.serverId;
  return {
    id: legacy.id,
    name: legacy.name,
    projectId: null,
    description: '',
    environment: '',
    notes: '',
    url: legacyUrl(legacy.domain),
    repo: legacyUrl(legacy.repo),
    createdAt: legacy.createdAt || legacy.updatedAt,
    ...overlay,
    machineId: legacy.serverId,
    source: sameMachine ? overlay.source : { type: 'manual' },
    additionalSources: sameMachine ? overlay.additionalSources : undefined,
    directory: sameMachine
      ? overlay.directory
      : legacy.adoption?.directory || '',
    healthUrl: sameMachine ? overlay.healthUrl : '',
    history: sameMachine ? overlay.history : undefined,
    legacy: true,
  };
}

export function listServices(store, settings = store.list('settings')) {
  const records = new Map(
    settings
      .filter((s) => s.recordType === 'service')
      .map(({ serviceId, ...entry }) => [
        serviceId,
        { ...entry, id: serviceId },
      ]),
  );
  for (const legacy of store.list('projects'))
    records.set(legacy.id, fromLegacy(legacy, records.get(legacy.id)));
  return [...records.values()];
}

export function findService(store, id) {
  const row = store.get('settings', serviceRecordKey(id));
  const record = row?.recordType === 'service' ? { ...row, id } : null;
  const legacy = store.get('projects', id);
  return legacy ? fromLegacy(legacy, record) : record;
}

export function unlinkProjectServices(store, services) {
  for (const service of services) {
    const row = store.get('settings', serviceRecordKey(service.id));
    if (row?.recordType === 'service')
      store.save('settings', { ...row, projectId: null });
  }
}
