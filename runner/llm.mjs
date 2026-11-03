import { requestSignal, checkCancellation } from './cancellation.mjs';
import { assert } from './security.mjs';
import { randomUUID } from 'node:crypto';
export const LLM_DEFAULTS = {
  baseUrl: 'https://api.alltokens.ru/api/v1',
  model: 'google/gemini-3.8-flash',
  enabled: false,
};
const LEGACY_MODEL_ID = '00000000-0000-4000-8000-000000000000';

function modelFields(body, previous) {
  const baseUrlInput =
    body.baseUrl === undefined
      ? previous?.baseUrl || LLM_DEFAULTS.baseUrl
      : body.baseUrl;
  let url;
  try {
    url = new URL(baseUrlInput);
  } catch {
    assert(false, 'Укажите URL API провайдера');
  }
  assert(
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'Для провайдера нужен HTTPS URL без ключа и параметров; HTTP разрешён только локально',
  );
  const baseUrl = url.href.replace(/\/+$/, '');
  const model = String(
    body.model === undefined ? previous?.model || '' : body.model,
  ).trim();
  assert(
    /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}$/.test(model),
    'Укажите идентификатор модели',
  );
  const changed = previous && previous.baseUrl !== baseUrl;
  const apiKey =
    body.apiKey || (!changed ? previous?.secret?.apiKey : '') || '';
  assert(
    typeof apiKey === 'string' &&
      apiKey.length <= 1024 &&
      !/[\r\n]/.test(apiKey),
    'Некорректный API-ключ',
  );
  assert(
    apiKey || url.protocol === 'http:',
    'Введите API-ключ для этого провайдера',
  );
  return {
    baseUrl,
    model,
    enabled:
      body.enabled === undefined
        ? previous?.enabled !== false
        : body.enabled !== false,
    configured: true,
    updatedAt: new Date().toISOString(),
    secret: { apiKey },
  };
}

export function llmInput(body, previous) {
  return {
    id: 'llm',
    ...modelFields(body, previous),
  };
}

export function llmModels(settings) {
  if (!settings) return [];
  if (Array.isArray(settings.models)) return settings.models;
  if (!settings.baseUrl || !settings.model) return [];
  return [
    {
      id: LEGACY_MODEL_ID,
      name: settings.name || settings.model || 'Модель',
      baseUrl: settings.baseUrl,
      model: settings.model,
      enabled: settings.enabled !== false,
      configured: true,
      updatedAt: settings.updatedAt,
    },
  ];
}

export function resolveLlmModel(settings, modelId) {
  const models = llmModels(settings);
  const defaultModel = models.find(
    (model) => model.id === settings?.defaultModelId,
  );
  const id =
    modelId ||
    (defaultModel?.enabled ? defaultModel.id : '') ||
    models.find((model) => model.enabled)?.id ||
    defaultModel?.id ||
    models[0]?.id;
  const model = models.find((item) => item.id === id);
  assert(model, 'Сохранённая модель не найдена', 404);
  const apiKey = Array.isArray(settings.models)
    ? settings.secret?.apiKeys?.[model.id] ||
      (model.id === settings.defaultModelId ? settings.secret?.apiKey : '')
    : settings.secret?.apiKey;
  return { ...model, secret: { apiKey: apiKey || '' } };
}

function storedSettings(models, apiKeys, defaultModelId) {
  const requested = models.find((model) => model.id === defaultModelId);
  const selected =
    (requested?.enabled ? requested : null) ||
    models.find((model) => model.enabled) ||
    requested ||
    models[0];
  return {
    id: 'llm',
    models,
    defaultModelId: selected?.id,
    baseUrl: selected?.baseUrl || LLM_DEFAULTS.baseUrl,
    model: selected?.model || LLM_DEFAULTS.model,
    enabled: selected?.enabled || false,
    configured: !!selected,
    updatedAt: new Date().toISOString(),
    secret: {
      apiKeys,
      apiKey: selected ? apiKeys[selected.id] || '' : '',
    },
  };
}

function existingKeys(settings, models) {
  const keys = { ...settings?.secret?.apiKeys };
  if (
    settings &&
    !Array.isArray(settings.models) &&
    models[0]?.id === LEGACY_MODEL_ID
  )
    keys[LEGACY_MODEL_ID] = settings.secret?.apiKey || '';
  return keys;
}

export function saveLlmModel(settings, body, modelId) {
  const models = llmModels(settings);
  const previousPublic = modelId
    ? models.find((model) => model.id === modelId)
    : null;
  assert(!modelId || previousPublic, 'Сохранённая модель не найдена', 404);
  const keys = existingKeys(settings, models);
  const previous = previousPublic
    ? { ...previousPublic, secret: { apiKey: keys[previousPublic.id] || '' } }
    : null;
  const fields = modelFields(body, previous);
  const name = String(
    body.name === undefined ? previousPublic?.name || '' : body.name,
  ).trim();
  assert(name && name.length <= 80, 'Укажите название модели, до 80 символов');
  const id = modelId || randomUUID();
  const model = {
    id,
    name,
    baseUrl: fields.baseUrl,
    model: fields.model,
    enabled: fields.enabled,
    configured: true,
    updatedAt: fields.updatedAt,
  };
  const nextModels = modelId
    ? models.map((item) => (item.id === id ? model : item))
    : [...models, model];
  keys[id] = fields.secret.apiKey;
  const defaultModelId = models.some(
    (item) => item.id === settings?.defaultModelId,
  )
    ? settings.defaultModelId
    : nextModels[0].id;
  return storedSettings(nextModels, keys, defaultModelId);
}

export function deleteLlmModel(settings, modelId) {
  const models = llmModels(settings);
  assert(
    models.some((model) => model.id === modelId),
    'Сохранённая модель не найдена',
    404,
  );
  const nextModels = models.filter((model) => model.id !== modelId);
  const keys = existingKeys(settings, models);
  delete keys[modelId];
  const defaultModelId = nextModels.some(
    (model) => model.id === settings?.defaultModelId,
  )
    ? settings.defaultModelId
    : nextModels[0]?.id;
  return storedSettings(nextModels, keys, defaultModelId);
}

export function llmPublic(store) {
  const value = store.get('settings', 'llm');
  if (!value) return { ...LLM_DEFAULTS, configured: false, models: [] };
  const { secret: _, ...visible } = value;
  const models = llmModels(value).map(({ secret: __, ...model }) => model);
  return {
    ...visible,
    models,
    configured: models.length > 0,
    enabled: models.some((model) => model.enabled),
  };
}
// Providers may spend minutes generating a plan. Bound inactivity separately from
// total generation time, and consume SSE so a live response is not mistaken for a hang.
export async function chatJson(
  settings,
  messages,
  {
    fetcher = fetch,
    maxTokens = 5000,
    timeout = 600000,
    idleTimeout = 90000,
    onProgress = () => {},
  } = {},
) {
  assert(
    settings?.enabled,
    'Подключите LLM в настройках или используйте автоопределение без модели',
  );
  const idle = new AbortController();
  const total = requestSignal(timeout);
  const signal = AbortSignal.any([total, idle.signal]);
  let timer,
    reader,
    bytes = 0,
    lastProgress = 0;
  const started = Date.now();
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleTimeout);
  };
  const wait = (promise) =>
    new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  const providerError = (status) => {
    assert(
      false,
      status === 401 || status === 403
        ? 'Провайдер отклонил API-ключ или доступ к модели'
        : status === 402
          ? 'Недостаточно средств на балансе LLM-провайдера.'
          : status === 429
            ? 'Лимит провайдера исчерпан. Проверьте баланс и повторите позже.'
            : status === 404
              ? 'Модель или API endpoint не найдены. Проверьте Base URL и Model ID.'
              : 'Ошибка LLM-провайдера. Проверьте его доступность и настройки.',
      502,
    );
  };
  touch();
  try {
    const response = await wait(
      fetcher(settings.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.secret?.apiKey
            ? { Authorization: 'Bearer ' + settings.secret.apiKey }
            : {}),
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          max_tokens: maxTokens,
          stream: true,
        }),
        redirect: 'error',
        signal,
      }),
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      providerError(response.status);
    }
    assert(response.body, 'Провайдер вернул пустой ответ', 502);
    touch();
    onProgress('LLM подключена; ожидаем результат генерации.');
    reader = response.body.getReader();
    const streaming = /text\/event-stream/i.test(
      response.headers.get('content-type') || '',
    );
    const decoder = new TextDecoder();
    let buffer = '',
      text = '',
      finish = null,
      usage = null,
      doneEvent = false;
    const event = (frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') {
        doneEvent = true;
        return;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        assert(false, 'Провайдер вернул некорректное событие потока', 502);
      }
      if (payload.error)
        providerError(Number(payload.error.code || payload.error.status));
      const choice =
        payload.choices?.find((c) => c.index === 0) || payload.choices?.[0];
      if (choice?.index && choice.index !== 0) return;
      if (typeof choice?.delta?.content === 'string')
        text += choice.delta.content;
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (payload.usage) usage = payload.usage;
    };
    for (;;) {
      const { done, value } = await wait(reader.read());
      if (done) break;
      touch();
      bytes += value.length;
      assert(bytes <= 2000000, 'Слишком большой ответ модели', 502);
      buffer += decoder.decode(value, { stream: true });
      if (streaming) {
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          event(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
          if (doneEvent) break;
        }
      }
      if (Date.now() - lastProgress >= 15000) {
        onProgress(
          'LLM генерирует ответ: ' +
            Math.round((Date.now() - started) / 1000) +
            ' с.',
        );
        lastProgress = Date.now();
      }
      if (doneEvent) break;
    }
    buffer += decoder.decode();
    if (streaming) {
      if (!doneEvent && buffer.trim()) event(buffer);
      assert(
        finish,
        'Поток LLM оборвался до завершения ответа. Повторите запрос.',
        502,
      );
    } else {
      let payload;
      try {
        payload = JSON.parse(buffer);
      } catch {
        assert(false, 'Провайдер вернул некорректный JSON', 502);
      }
      if (payload.error)
        providerError(Number(payload.error.code || payload.error.status));
      const choice = payload.choices?.[0];
      text = choice?.message?.content;
      finish = choice?.finish_reason;
      usage = payload.usage;
    }
    assert(
      finish !== 'length',
      'Ответ модели обрезан. Выберите модель с большим лимитом вывода.',
      502,
    );
    assert(typeof text === 'string', 'Модель не вернула текстовый ответ', 502);
    let parsed;
    try {
      parsed = JSON.parse(
        text
          .trim()
          .replace(/^```(?:json)?\s*/, '')
          .replace(/\s*```$/, ''),
      );
    } catch {
      assert(false, 'Модель вернула ответ не по схеме. Повторите анализ.', 502);
    }
    assert(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed),
      'Модель вернула некорректный объект',
      502,
    );
    onProgress(
      'Ответ LLM получен за ' +
        Math.round((Date.now() - started) / 1000) +
        ' с.',
    );
    return {
      data: parsed,
      usage: usage
        ? {
            input: Number(usage.prompt_tokens) || 0,
            output: Number(usage.completion_tokens) || 0,
          }
        : null,
    };
  } catch (error) {
    checkCancellation();
    if (error.status) throw error;
    if (signal.aborted)
      assert(
        false,
        total.aborted
          ? 'LLM не завершила ответ за ' +
              Math.round(timeout / 1000) +
              ' секунд. Повторите запрос или выберите более быструю модель.'
          : 'LLM не передавала данные ' +
              Math.round(idleTimeout / 1000) +
              ' секунд. Соединение с провайдером прервано.',
        504,
      );
    const code = error.cause?.code || error.code;
    assert(
      false,
      ['ENOTFOUND', 'EAI_AGAIN'].includes(code)
        ? 'Не удалось определить адрес LLM-провайдера. Проверьте DNS и Base URL.'
        : ['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
          ? 'Не удалось подключиться к LLM-провайдеру. Проверьте сеть и Base URL.'
          : 'Сетевое соединение с LLM-провайдером прервано. Повторите запрос.',
      502,
    );
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}
