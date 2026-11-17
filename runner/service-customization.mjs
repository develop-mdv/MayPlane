import { createHash, randomUUID } from 'node:crypto';
import {
  allServiceMetrics,
  serviceCustomizationInput,
  serviceCustomizationBlock,
} from '../lib/service-customization.mjs';
import {
  serviceBinding,
  serviceRuntimeMetricPaths,
  serviceSources,
} from './service-model.mjs';

export const serviceWidgetsGuide = [
  'Собирай карточку под задачи конкретного приложения. Допустимы поля fields, метрики metrics и именованные разделы sections. Раздел имеет title, необязательное description, layout "rows" или "grid", собственные fields и metrics. Порядок разделов и полей задаёт порядок на экране.',
  'У поля есть label и value. Для кликабельной ссылки обязательно укажи type "link" и отдельное поле url с HTTP(S)-адресом. value — короткий текст ссылки. Например {"type":"link","label":"Админка","value":"Открыть панель","url":"https://example.com/admin"}. type "badge" добавляет цветную метку с tone "neutral", "good", "warning" или "danger". type "code" оформляет копируемое значение, type "note" — многострочную заметку, type "text" — обычный текст. Используй только известные значения и адреса. Не добавляй секреты из конфигурации.',
  `У числовой метрики есть label, path и необязательные unit, warningAt, criticalAt, alertWhen ("above" или "below"). Для системного измерения укажи source "runtime" и один из ключей ${serviceRuntimeMetricPaths.join(', ')}. Для JSON укажи путь через точки, например queue.waiting. Весь дашборд может использовать общий metricsUrl, а отдельная метрика — свой url. Такие адреса должны быть HTTP на 127.0.0.1 или [::1] именно на машине сервиса. Если источник пока неизвестен, уточни его. Для коннекторов доступны поля и разделы без живых метрик.`,
];
const editableKeys = ['fields', 'metrics', 'metricsUrl', 'sections'];

function fieldsIn(configuration) {
  return [
    ...(configuration.fields || []),
    ...(configuration.sections || []).flatMap((group) => group.fields),
  ];
}

function removedNames(before = [], after = [], key = 'label') {
  const names = new Set(after.map((entry) => entry[key].toLowerCase()));
  return before
    .map((entry) => entry[key])
    .filter((name) => !names.has(name.toLowerCase()));
}

export function customizationRevision(service) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        serviceBinding(service),
        service.directory,
        service.projectId,
        service.customization,
      ]),
    )
    .digest('hex');
}

export function customizeServiceInput(message, service, machine, session) {
  const context = {
    name: service.name,
    description: service.description,
    directory: service.directory,
    repo: service.repo,
    healthUrl: service.healthUrl,
    sources: serviceSources(service),
    customization: service.customization || {},
    machine: machine.name,
    onServiceMachine: machine.id === session.machineId,
    supportsJsonMetrics: machine.transport !== 'connector',
  };
  return serviceCustomizationInput(
    [
      'Помоги настроить одну карточку в панели MayPlane. Считай её данные справочными. Панель применит подтверждённый пользователем черновик на своей стороне независимо от того, где выполняется этот чат. Если чат на другой машине, данные и localhost этого чата не относятся к целевому сервису. Для настройки карточки не меняй файлы, процессы, права и настройки на машине.',
      ...serviceWidgetsGuide,
      'После объяснения добавь один блок ```mayplane-service-config с JSON-объектом. Передай только изменяемые ключи из fields, metrics, metricsUrl и sections. Переданный массив заменяет группу целиком, поэтому оставь в нём её прежние элементы, которые пользователь хочет сохранить. Пустой массив очищает группу. Пропущенные ключи сохраняются. Панель покажет черновик для применения пользователем. Если нужно задать вопрос, пропусти блок.',
      'Карточка сервиса\n' + JSON.stringify(context),
    ].join('\n\n'),
    message,
  );
}

export function addCustomizationDraft(session, turn, normalize) {
  const results = session.secret.serviceCustomizations || [];
  let draft;
  for (const message of [...session.secret.messages].reverse()) {
    if (message.role !== 'assistant' || !turn.messages.has(message.id))
      continue;
    const block = serviceCustomizationBlock(message.content);
    if (!block) continue;
    message.content = block.text || 'Предложение по карточке сервиса.';
    const { service, revision } = turn.customization;
    draft = {
      id: randomUUID(),
      messageId: message.id,
      serviceId: service.id,
      serviceName: service.name,
      revision,
    };
    try {
      if (!block.json)
        throw new Error(
          'Блок настройки не завершён. Попросите агента повторить предложение.',
        );
      let payload;
      try {
        payload = JSON.parse(block.json);
      } catch {
        throw new Error(
          'Агент вернул некорректный JSON. Попросите его повторить предложение.',
        );
      }
      const keys =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? editableKeys.filter((key) => Object.hasOwn(payload, key))
          : [];
      if (!keys.length)
        throw new Error('Укажите, какие поля, метрики или разделы изменить.');
      const previous = service.customization || {};
      const patch = Object.fromEntries(keys.map((key) => [key, payload[key]]));
      const keepMetricBinding =
        !keys.includes('metricsUrl') && !keys.includes('metrics');
      draft.configuration = normalize(
        { ...previous, ...patch },
        keepMetricBinding ? previous : undefined,
      );
      draft.removedFields = removedNames(
        fieldsIn(previous),
        fieldsIn(draft.configuration),
      );
      draft.removedMetrics = removedNames(
        allServiceMetrics(previous),
        allServiceMetrics(draft.configuration),
      );
      draft.removedSections = removedNames(
        previous.sections,
        draft.configuration.sections,
        'title',
      );
    } catch (error) {
      draft.warning = error.message;
    }
    break;
  }
  if (!draft) return;
  if (draft.configuration)
    for (const previous of results)
      if (previous.serviceId === draft.serviceId && !previous.appliedAt)
        previous.replaced = true;
  session.secret.serviceCustomizations = [...results, draft].slice(-12);
}

export function readMetricValue(document, path) {
  let value = document;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
      return undefined;
    value = value[key];
  }
  return Number.isFinite(value) ? value : undefined;
}
