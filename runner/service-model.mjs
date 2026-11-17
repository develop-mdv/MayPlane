import { randomUUID } from 'node:crypto';
import {
  allServiceMetrics,
  serviceLinkUrl,
} from '../lib/service-customization.mjs';
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

export function serviceMetricSources(service) {
  const configuration = service.customization;
  if (!configuration || configuration.metricsMachineId !== service.machineId)
    return [];
  return configuredMetricSources(configuration);
}

function configuredMetricSources(configuration) {
  return allServiceMetrics(configuration).map((metric) => ({
    metric,
    url:
      metric.source === 'runtime' ? '' : metric.url || configuration.metricsUrl,
  }));
}

export const serviceRuntimeMetricPaths = [
  'cpuCores',
  'memoryBytes',
  'restarts',
  'instances.running',
  'instances.found',
];

function customField(field) {
  const type = field?.type;
  assert(
    type === undefined ||
      ['text', 'link', 'badge', 'note', 'code'].includes(type),
    'Неизвестный вид поля',
  );
  const label = text(field?.label, 60, 'Название поля', true);
  const value = text(
    field?.value ?? (type === 'link' ? 'Открыть' : ''),
    type === 'note' ? 2000 : 600,
    'Значение поля',
    true,
  );
  if (type === 'link') {
    const url = serviceLinkUrl(
      typeof field.url === 'string' ? field.url.trim() : '',
    );
    assert(url, 'Для ссылки укажите HTTP(S)-адрес без логина и пароля');
    return { label, value, type, url };
  }
  if (type === 'badge') {
    const tone = field.tone ?? 'neutral';
    assert(
      ['neutral', 'good', 'warning', 'danger'].includes(tone),
      'Выберите цвет метки',
    );
    return { label, value, type, tone };
  }
  return { label, value, ...(type ? { type } : {}) };
}

function customMetric(metric) {
  const source = metric?.source;
  assert(
    source === undefined || source === 'json' || source === 'runtime',
    'Выберите источник метрики',
  );
  const path = text(metric?.path, 160, 'Путь метрики', true);
  if (source === 'runtime')
    assert(
      serviceRuntimeMetricPaths.includes(path) && !metric.url,
      'Выберите доступную системную метрику',
    );
  else
    assert(
      /^[\w-]+(?:\.[\w-]+){0,11}$/.test(path),
      'Путь метрики задаётся через точки, например queue.waiting',
    );
  const item = {
    label: text(metric?.label, 60, 'Название метрики', true),
    path,
    unit: text(metric?.unit ?? '', 20, 'Единица измерения'),
  };
  if (source === 'runtime') item.source = source;
  if (metric.url !== undefined && metric.url !== '')
    item.url = serviceUrl(metric.url, true, 'Эндпоинт метрики');
  const { warningAt, criticalAt } = metric;
  const alertWhen = metric.alertWhen ?? 'above';
  assert(
    ['above', 'below'].includes(alertWhen),
    'Порог срабатывает выше или ниже числа',
  );
  for (const threshold of [warningAt, criticalAt])
    assert(
      threshold === undefined || Number.isFinite(threshold),
      'Порог метрики должен быть числом',
    );
  if (warningAt !== undefined && criticalAt !== undefined)
    assert(
      alertWhen === 'above' ? warningAt <= criticalAt : warningAt >= criticalAt,
      'Проверьте порядок порогов метрики',
    );
  if (warningAt !== undefined || criticalAt !== undefined)
    item.alertWhen = alertWhen;
  if (warningAt !== undefined) item.warningAt = warningAt;
  if (criticalAt !== undefined) item.criticalAt = criticalAt;
  return item;
}

function distinctLabels(entries, key, message) {
  assert(
    new Set(entries.map((entry) => entry[key].toLowerCase())).size ===
      entries.length,
    message,
  );
}

function customItems(group) {
  const { fields = [], metrics = [] } = group;
  assert(
    Array.isArray(fields) && fields.length <= 24,
    'Укажите до 24 полей карточки',
  );
  assert(
    Array.isArray(metrics) && metrics.length <= 16,
    'Укажите до 16 метрик карточки',
  );
  const result = {
    fields: fields.map(customField),
    metrics: metrics.map(customMetric),
  };
  for (const entries of [result.fields, result.metrics])
    distinctLabels(
      entries,
      'label',
      'Названия полей и метрик внутри раздела должны отличаться',
    );
  return result;
}

export function serviceCustomization(value, machine, healthUrl = '', previous) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Укажите поля и метрики карточки',
  );
  const { sections = [] } = value;
  assert(
    Array.isArray(sections) && sections.length <= 6,
    'Укажите до шести разделов карточки',
  );
  const extras = { ...customItems(value), metricsUrl: '' };
  if (sections.length) {
    extras.sections = sections.map((section) => {
      assert(
        section && typeof section === 'object' && !Array.isArray(section),
        'Некорректный раздел карточки',
      );
      const layout = section.layout ?? 'rows';
      assert(
        ['rows', 'grid'].includes(layout),
        'Выберите список или сетку для раздела',
      );
      return {
        title: text(section.title, 65, 'Заголовок раздела', true),
        description: text(section.description ?? '', 280, 'Описание раздела'),
        layout,
        ...customItems(section),
      };
    });
    distinctLabels(
      extras.sections,
      'title',
      'Заголовки разделов должны отличаться',
    );
  }
  const metrics = allServiceMetrics(extras);
  const fieldCount =
    extras.fields.length +
    (extras.sections || []).reduce(
      (sum, group) => sum + group.fields.length,
      0,
    );
  assert(
    fieldCount <= 24 && metrics.length <= 16,
    'В карточке может быть до 24 полей и 16 метрик',
  );
  if (!metrics.length) return extras;

  const jsonMetrics = metrics.filter((metric) => metric.source !== 'runtime');
  const needsDefault = jsonMetrics.some((metric) => !metric.url);
  const sharedUrl =
    value.metricsUrl === undefined
      ? ''
      : text(value.metricsUrl, 1000, 'Эндпоинт метрик');
  extras.metricsUrl = serviceUrl(
    sharedUrl || (needsDefault ? healthUrl : ''),
    true,
    'Эндпоинт метрик',
  );
  assert(
    !needsDefault || extras.metricsUrl,
    'Для JSON-метрик укажите эндпоинт',
  );
  assert(
    new Set(jsonMetrics.map((metric) => metric.url || extras.metricsUrl))
      .size <= 6,
    'Укажите до шести локальных источников JSON',
  );
  let metricsMachineId = machine.id;
  if (previous?.metricsMachineId && previous.metricsMachineId !== machine.id) {
    const key = ({ metric, url }) =>
      JSON.stringify([metric.source || 'json', metric.path, url]);
    const previousSources = new Set(configuredMetricSources(previous).map(key));
    if (
      configuredMetricSources(extras).every((source) =>
        previousSources.has(key(source)),
      )
    )
      metricsMachineId = previous.metricsMachineId;
  }
  assert(
    metricsMachineId !== machine.id || machine.transport !== 'connector',
    'Живые метрики доступны для SSH-машин и хоста панели',
  );
  extras.metricsMachineId = metricsMachineId;
  return extras;
}

export function serviceInput(
  body,
  machine,
  { previous, draft = false, preserveMetricBinding = false } = {},
) {
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
  const customization = Object.hasOwn(body, 'customization')
    ? serviceCustomization(
        body.customization,
        machine,
        healthUrl,
        preserveMetricBinding ? previous?.customization : undefined,
      )
    : previous?.customization;
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
    ...(customization ? { customization } : {}),
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
