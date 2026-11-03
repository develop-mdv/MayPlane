import { AgentRpc } from './agent-rpc.mjs';
import { assert } from './security.mjs';

const choice = (id, name, description) => ({
  id,
  name: name || id,
  ...(description ? { description } : {}),
});
export async function codexModels(rpc) {
  const models = new Map(),
    cursors = new Set();
  let cursor;
  do {
    const page = await rpc.request('model/list', {
      limit: 100,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    });
    for (const m of page.data || []) {
      if (m.hidden || !m.id) continue;
      const id = m.model || m.id;
      models.set(id, {
        ...choice(id, m.displayName, m.description),
        isDefault: !!m.isDefault,
        reasoning: (m.supportedReasoningEfforts || []).map((e) =>
          choice(e.reasoningEffort, e.reasoningEffort, e.description),
        ),
        defaultReasoning: m.defaultReasoningEffort || '',
      });
    }
    cursor = page.nextCursor;
    assert(
      !cursor || !cursors.has(cursor),
      'Агент вернул повторяющуюся страницу моделей',
      502,
    );
    if (cursor) cursors.add(cursor);
    assert(cursors.size < 100, 'Каталог моделей слишком большой', 502);
  } while (cursor);
  return {
    models: [...models.values()],
    defaultModelId: [...models.values()].find((m) => m.isDefault)?.id || '',
  };
}

const flatten = (options = [], group = '') =>
  options.flatMap((o) =>
    Array.isArray(o.options)
      ? flatten(o.options, o.name || group)
      : typeof o.value === 'string'
        ? [
            {
              ...choice(o.value, o.name, o.description),
              ...(group ? { group } : {}),
            },
          ]
        : [],
  );
export function acpOptions(state) {
  const configs = state.configOptions || [];
  const model = configs.find(
    (c) => c.category === 'model' && c.type === 'select',
  );
  const effort = configs.find(
    (c) => c.category === 'thought_level' && c.type === 'select',
  );
  const models = model
    ? flatten(model.options)
    : (state.models?.availableModels || []).map((m) =>
        choice(m.modelId, m.name, m.description),
      );
  return {
    modelConfig: model?.id,
    effortConfig: effort?.id,
    currentModel: model?.currentValue || state.models?.currentModelId || '',
    currentReasoning: effort?.currentValue || '',
    models: models.map((m) => ({
      ...m,
      reasoning:
        m.id === model?.currentValue && effort ? flatten(effort.options) : [],
      defaultReasoning:
        m.id === model?.currentValue && effort ? effort.currentValue : '',
    })),
  };
}

export async function setAcpSelection(rpc, runtime, model, reasoning = '') {
  let options = acpOptions(runtime.modelState || {});
  assert(
    !model || options.models.some((m) => m.id === model),
    'Модель больше недоступна. Обновите список и выберите другую.',
    409,
  );
  if (model && model !== options.currentModel) {
    const result = await rpc.request(
      options.modelConfig ? 'session/set_config_option' : 'session/set_model',
      {
        sessionId: runtime.nativeId,
        ...(options.modelConfig
          ? { configId: options.modelConfig, value: model }
          : { modelId: model }),
      },
    );
    if (result.configOptions) runtime.modelState = result;
    else if (result.models) runtime.modelState = result;
    else if (!options.modelConfig)
      runtime.modelState = {
        ...runtime.modelState,
        models: { ...runtime.modelState.models, currentModelId: model },
      };
    options = acpOptions(runtime.modelState);
  }
  const effectiveReasoning =
    reasoning ||
    (options.models
      .find((m) => m.id === model)
      ?.reasoning.some((e) => e.id === 'default')
      ? 'default'
      : '');
  if (effectiveReasoning) {
    const selected = options.models.find((m) => m.id === model);
    assert(
      options.effortConfig &&
        selected?.reasoning.some((e) => e.id === effectiveReasoning),
      'Этот уровень reasoning не поддерживается моделью. Обновите список.',
      409,
    );
    const result = await rpc.request('session/set_config_option', {
      sessionId: runtime.nativeId,
      configId: options.effortConfig,
      value: effectiveReasoning,
    });
    if (result.configOptions) runtime.modelState = result;
  }
  return acpOptions(runtime.modelState);
}

export function validateSelection(catalog, model, reasoning = '') {
  assert(
    typeof model === 'string' &&
      model.length <= 500 &&
      typeof reasoning === 'string' &&
      reasoning.length <= 120,
    'Некорректный выбор модели',
  );
  assert(
    !reasoning || model,
    'Сначала выберите модель для настройки reasoning',
  );
  if (!model) return;
  const selected = catalog.models.find((m) => m.id === model);
  assert(
    selected,
    'Модель больше недоступна. Обновите список и выберите другую.',
    409,
  );
  assert(
    !reasoning || selected.reasoning.some((e) => e.id === reasoning),
    'Этот уровень reasoning не поддерживается моделью. Обновите список.',
    409,
  );
}

// Probes never prompt a model or change a user's chat. Reuse their native session
// IDs so periodic refreshes do not create an unbounded native chat history.
export function createModelCatalog({ openProcess, connectors, isClosed }) {
  const entries = new Map(),
    probes = new Set();
  let opening = 0;
  async function get(
    machine,
    provider,
    cwd,
    { model = '', refresh = false } = {},
  ) {
    assert(!isClosed(), 'Исполнитель останавливается', 503);
    assert(
      typeof model === 'string' && model.length <= 500,
      'Некорректная модель',
    );
    const key = JSON.stringify([machine.id, provider, cwd]);
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= 64) {
        const idle = [...entries].find(([, e]) => !e.pending);
        assert(idle, 'Слишком много запросов моделей', 429);
        entries.delete(idle[0]);
      }
      entry = { variants: new Map() };
      entries.set(key, entry);
    }
    if (entry.pending) {
      await entry.pending;
      return get(machine, provider, cwd, { model });
    }
    if (
      !refresh &&
      entry.expiresAt > Date.now() &&
      (!model || provider === 'codex' || entry.variants.has(model))
    )
      return entry.catalog;
    assert(
      probes.size + opening < 4,
      'Слишком много одновременных проверок моделей. Повторите позже.',
      429,
    );
    entry.pending = (async () => {
      opening++;
      let opened;
      try {
        opened = await openProcess(
          machine,
          { provider, operation: 'agent', cwd },
          connectors,
        );
      } finally {
        opening--;
      }
      if (isClosed()) {
        opened.close();
        throw new Error('Исполнитель останавливается');
      }
      const rpc = new AgentRpc(opened);
      let runtime;
      rpc.on('message', (msg) => {
        if (msg.id !== undefined) rpc.reject(msg.id);
        if (
          runtime &&
          msg.method === 'session/update' &&
          msg.params?.update?.sessionUpdate === 'config_option_update'
        )
          runtime.modelState = {
            configOptions: msg.params.update.configOptions,
          };
      });
      probes.add(rpc);
      const deadline = setTimeout(
        () =>
          rpc.close(
            new Error(
              'Не удалось загрузить модели за 25 секунд. Проверьте соединение и вход в агент.',
            ),
          ),
        25000,
      );
      try {
        let catalog;
        if (provider === 'codex') {
          await rpc.request('initialize', {
            clientInfo: { name: 'ezdeploy', version: '0.2.0' },
          });
          rpc.notify('initialized');
          catalog = await codexModels(rpc);
        } else {
          const init = await rpc.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'ezdeploy', version: '0.2.0' },
          });
          const reusable =
            entry.nativeId && init.agentCapabilities?.loadSession;
          const state = await rpc.request(
            reusable ? 'session/load' : 'session/new',
            {
              cwd,
              mcpServers: [],
              ...(reusable ? { sessionId: entry.nativeId } : {}),
            },
          );
          runtime = {
            nativeId: reusable ? entry.nativeId : state.sessionId,
            modelState: state,
          };
          entry.nativeId = runtime.nativeId;
          const initial = acpOptions(state);
          assert(
            initial.models.length,
            'OpenCode не вернул модели. Проверьте провайдеров и вход в настройках агента.',
            409,
          );
          if (refresh || entry.expiresAt <= Date.now()) entry.variants.clear();
          entry.variants.set(
            initial.currentModel,
            initial.models.find((m) => m.id === initial.currentModel),
          );
          const available = model && initial.models.some((m) => m.id === model);
          const selected = available
            ? await setAcpSelection(rpc, runtime, model)
            : initial;
          if (available)
            entry.variants.set(
              model,
              selected.models.find((m) => m.id === model),
            );
          catalog = {
            models: selected.models.map((m) => ({
              ...m,
              ...entry.variants.get(m.id),
            })),
            defaultModelId: initial.currentModel,
          };
          // Restore only the private probe's selection, preserving the agent default.
          if (
            available &&
            initial.currentModel &&
            model !== initial.currentModel
          )
            await setAcpSelection(
              rpc,
              runtime,
              initial.currentModel,
              initial.currentReasoning,
            );
        }
        entry.catalog = { ...catalog, updatedAt: new Date().toISOString() };
        entry.expiresAt = Date.now() + 60000;
        return entry.catalog;
      } finally {
        clearTimeout(deadline);
        probes.delete(rpc);
        rpc.close();
      }
    })();
    try {
      return await entry.pending;
    } catch (error) {
      throw Object.assign(
        new Error(
          `Не удалось получить модели ${provider === 'codex' ? 'Codex' : 'OpenCode'}. ${error.message}`,
        ),
        { status: error.status || 400 },
      );
    } finally {
      entry.pending = null;
    }
  }
  return {
    get,
    invalidate(machineId, provider) {
      for (const key of entries.keys()) {
        const [id, agent] = JSON.parse(key);
        if (id === machineId && agent === provider) entries.delete(key);
      }
    },
    close() {
      for (const rpc of probes) rpc.close();
      entries.clear();
    },
  };
}
