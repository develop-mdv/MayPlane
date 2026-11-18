import { stripVTControlCharacters } from 'node:util';
import { sshActions } from '../lib/chat-references.mjs';
import { sourceLabel } from './chat-targets.mjs';
import { assert, redact } from './security.mjs';
import { serviceUrl, sourceKey } from './service-model.mjs';
import {
  checkServiceHttp,
  controlServiceSource,
  inspectServices,
  readServiceLogs,
  runtimeError,
  withServiceMachine,
} from './service-runtime.mjs';
import { connect, metrics } from './ssh.mjs';

const target = {
  type: 'string',
  description: 'The exact target value supplied by MayPlane in this turn.',
};
const source = {
  type: 'integer',
  minimum: 1,
  description:
    'The source number from the selected service card. Required for cards with several sources.',
};

function tool(name, description, fields = {}, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { target, ...fields },
      required: ['target', ...required],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: name !== 'service_control',
      destructiveHint: name === 'service_control',
      openWorldHint: true,
    },
  };
}

export const hostSshTools = [
  tool(
    'server_status',
    'Read live system and resource metrics over SSH for a mentioned server or the server of a mentioned service.',
  ),
  tool(
    'server_services',
    'List detected Docker, Compose, and systemd services on a mentioned server.',
  ),
  tool(
    'service_status',
    'Check the configured sources and optional HTTP health endpoint of a mentioned service.',
  ),
  tool(
    'service_logs',
    'Read recent logs for one configured source of a mentioned service.',
    { source },
  ),
  tool(
    'service_control',
    'Request owner approval to start, stop, or restart one configured source of a mentioned service.',
    { source, action: { type: 'string', enum: Object.keys(sshActions) } },
    ['action'],
  ),
];

function result(data, secrets = [], isError = false) {
  const text = JSON.stringify(data, (_, value) =>
    typeof value === 'string'
      ? stripVTControlCharacters(redact(value, secrets))
      : value,
  );
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

async function serverStatus(machine, signal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(24000)]);
  let client;
  try {
    client = await connect(machine, { signal: deadline });
    return await metrics(client, { signal: deadline });
  } catch {
    throw Object.assign(
      new Error(
        'Не удалось получить метрики по SSH. Проверьте подключение к серверу.',
      ),
      { status: 502 },
    );
  } finally {
    client?.end();
  }
}

function statusEntry(entry) {
  return {
    status: entry.status,
    health: entry.health,
    instances: entry.instances,
    unitState: entry.unitState,
    startedAt: entry.startedAt,
    restarts: entry.restarts,
  };
}

export function createHostSshTools({
  chatTargets,
  machine,
  withMachine = withServiceMachine,
  refreshMachine,
}) {
  const changing = new Set();

  async function call(name, args, turn, requestSignal, approve, audit) {
    let secrets = [];
    try {
      assert(
        turn && !turn.controller.signal.aborted,
        'Упомяните сервер или сервис в текущем сообщении чата на хосте.',
      );
      const signal = AbortSignal.any([requestSignal, turn.controller.signal]);
      signal.throwIfAborted();
      assert(
        ++turn.calls <= 24,
        'Достигнут лимит SSH-операций в одном сообщении',
      );
      const definition = hostSshTools.find((tool) => tool.name === name);
      assert(
        args &&
          typeof args === 'object' &&
          !Array.isArray(args) &&
          Object.keys(args).every((key) =>
            Object.hasOwn(definition.inputSchema.properties, key),
          ),
        'Некорректные параметры SSH-операции',
      );
      const target = turn.targets.get(args.target);
      assert(target, 'Цель SSH не выбрана в текущем сообщении', 403);
      const resolved = chatTargets.current(target);
      const { service, sources, context } = resolved;
      assert(
        !name.startsWith('service_') || service,
        'Выберите карточку сервиса через @',
      );
      assert(
        name !== 'server_services' || !service,
        'Для обнаружения сервисов выберите сервер через @',
      );
      const sourceIndex = args.source ?? (sources.length === 1 ? 1 : null);
      const source = Number.isInteger(sourceIndex)
        ? sources[sourceIndex - 1]
        : undefined;
      if (name === 'service_logs' || name === 'service_control')
        assert(source, 'Укажите номер настроенного источника сервиса');
      const readMachine = () => {
        signal.throwIfAborted();
        const selected = machine(resolved.machine.id);
        const { password, privateKey, passphrase } = selected.secret || {};
        assert(
          (typeof password === 'string' && password) ||
            (typeof privateKey === 'string' && privateKey),
          'Сохраните учётные данные SSH в настройках сервера',
          409,
        );
        const secret = { password, privateKey, passphrase };
        secrets = Object.values(secret).filter(
          (value) => typeof value === 'string',
        );
        return { ...selected, secret };
      };

      if (name === 'service_control') {
        const action = args.action;
        assert(
          typeof action === 'string' && Object.hasOwn(sshActions, action),
          'Выберите запуск, остановку или перезапуск',
        );
        const machineId = resolved.machine.id;
        assert(
          !changing.has(machineId),
          'У этого сервера уже есть операция управления',
          409,
        );
        const operation = {
          action,
          service: context.name,
          machine: resolved.machine.name,
          address: resolved.machine.host,
          source: sourceLabel(source),
          sourceType: source.type,
        };
        changing.add(machineId);
        let dispatched = false;
        try {
          const approved = await approve(operation, signal);
          if (!approved)
            return result(
              {
                message: 'Операция отклонена или время подтверждения истекло.',
              },
              [],
              true,
            );
          signal.throwIfAborted();
          chatTargets.current(target);
          const selected = readMachine();
          const instances = await withMachine(
            selected,
            (execute) =>
              controlServiceSource(execute, source, action, () => {
                signal.throwIfAborted();
                chatTargets.current(target);
                dispatched = true;
              }),
            signal,
            { gracefulAbort: true },
          );
          audit(operation, 'Выполнено');
          void refreshMachine(machineId, { force: true, repeat: true });
          return result(
            { action, source: operation.source, instances, completed: true },
            secrets,
          );
        } catch (error) {
          if (dispatched)
            audit(operation, 'Проверьте текущее состояние сервиса');
          throw error;
        } finally {
          changing.delete(machineId);
        }
      }

      if (name === 'service_status' && !sources.length && !service.healthUrl)
        return result({
          status: 'unconfigured',
          message: 'У карточки пока нет источника состояния или HTTP-проверки.',
        });
      const selected = readMachine();
      if (name === 'server_status')
        return result(await serverStatus(selected, signal), secrets);
      const data = await withMachine(
        selected,
        async (execute) => {
          if (name === 'server_services') {
            const { records, warnings } = await inspectServices(
              execute,
              selected,
            );
            return {
              services: [...records.values()].slice(0, 80).map((entry) => ({
                source: entry.source,
                name: entry.name,
                ...statusEntry(entry),
              })),
              warnings,
              limited: records.size > 80,
            };
          }
          if (name === 'service_logs') {
            const { lines, warning } = await readServiceLogs(
              execute,
              selected,
              { source },
            );
            return {
              lines: lines
                .slice(-60)
                .map((line) => ({ ...line, text: line.text.slice(0, 500) })),
              warning,
            };
          }
          const inventory = await inspectServices(execute, selected, sources);
          const http = service.healthUrl
            ? await checkServiceHttp(
                execute,
                selected,
                serviceUrl(service.healthUrl, true),
              )
            : undefined;
          return {
            sources: sources.map((source, index) => {
              const entry = inventory.records.get(sourceKey(source));
              const error = runtimeError(inventory, source);
              return {
                source: index + 1,
                name: sourceLabel(source),
                ...(entry
                  ? statusEntry(entry)
                  : { status: error ? 'unknown' : 'missing', error }),
              };
            }),
            http,
          };
        },
        signal,
      );
      return result(data, secrets);
    } catch (error) {
      const message = error.status
        ? error.message
        : 'Операция SSH прервана или не завершилась.';
      return result({ message }, secrets, true);
    }
  }

  return { call };
}
