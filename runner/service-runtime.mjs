import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { connect, run } from './ssh.mjs';
import { assert, q, redact } from './security.mjs';
import { serviceSource, serviceUrl, sourceKey, unitName } from './service-model.mjs';
import { sshActions } from '../lib/chat-references.mjs';

const containerId = /^[a-f0-9]{64}$/;
const maxDiscovery = 160;
const maxLogs = 200;
const dockerList =
  '{"id":{{json .ID}},"name":{{json .Names}},"stack":{{json (.Label "com.docker.compose.project")}},"component":{{json (.Label "com.docker.compose.service")}},"oneOff":{{json (.Label "com.docker.compose.oneoff")}}}';
// Docker's template is strict, and inspect omits Health for containers without a healthcheck.
const dockerInspect = [
  '{"id":{{json .Id}},"image":{{json .Config.Image}},"state":{{json .State.Status}}',
  '"exitCode":{{json (index .State "ExitCode")}},"started":{{json (index .State "StartedAt")}},"restarts":{{json (index . "RestartCount")}}',
  '"health":{{with index .State "Health"}}{{json (index . "Status")}}{{else}}null{{end}}',
  '"directory":{{with index .Config "Labels"}}{{json (index . "com.docker.compose.project.working_dir")}}{{else}}null{{end}}',
  '"ports":{{json (index .HostConfig "PortBindings")}}}',
].join(',');
const dockerStats =
  '{"id":{{json .ID}},"cpu":{{json .CPUPerc}},"memory":{{json .MemUsage}}}';
const unitFields =
  'Id,LoadState,ActiveState,SubState,Description,WorkingDirectory,FragmentPath,Type,ActiveEnterTimestampMonotonic,ExecMainStartTimestampMonotonic,NRestarts,MemoryCurrent';
const remoteError = (message, status = 502) =>
  Object.assign(new Error(message), { status });
const missingContainer =
  /^(?:Error(?: response from daemon)?:\s*)?No such (?:object|container): [a-f0-9]{64}$/i;
const dockerStages = {
  ps: 'список контейнеров',
  inspect: 'состояние контейнеров',
  stats: 'CPU и память контейнеров',
};

function dockerContainerGone(output) {
  const errors = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('{'));
  return (
    errors.length > 0 && errors.every((line) => missingContainer.test(line))
  );
}

function commandError(error, output, file, args, aborted = false) {
  const curlCode = /\bcurl: \((\d+)\)/.exec(output)?.[1];
  if (curlCode)
    return Object.assign(new Error('HTTP-проверка не завершилась.'), {
      curlCode: Number(curlCode),
    });
  if (error.code === 'ENOENT' || /\bcommand not found\b/i.test(output))
    return remoteError('На машине отсутствует команда «' + file + '».');
  if (
    /permission denied|access is denied|not authorized|insufficient permissions|access denied/i.test(
      output,
    )
  )
    return remoteError('Недостаточно прав для чтения данных на машине.', 403);
  if (
    error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    /лимит вывода/.test(error.message)
  )
    return remoteError('Вывод команды превысил допустимый размер.');
  const stage = file === 'docker' && dockerStages[args[0]];
  if (
    aborted ||
    error.killed ||
    error.name === 'AbortError' ||
    /превышено время|кодом 124$/i.test(error.message)
  )
    return remoteError(
      stage
        ? 'Docker не ответил вовремя. Этап · ' + stage + '.'
        : 'Машина не ответила вовремя.',
      504,
    );
  if (file === 'docker') {
    if (
      /cannot connect to the docker daemon|is the docker daemon running/i.test(
        output,
      )
    )
      return remoteError('Не удалось подключиться к Docker на машине.');
    if (stage)
      return remoteError(
        /template parsing error|error parsing template/i.test(output)
          ? 'Docker не смог сформировать данные для проверки. Этап · ' +
              stage +
              '.'
          : 'Docker не вернул данные. Этап · ' + stage + '.',
      );
  }
  return remoteError(
    'Не удалось прочитать данные. Проверьте наличие и доступность источника на машине.',
  );
}

export async function withServiceMachine(
  machine,
  work,
  signal,
  { gracefulAbort = false } = {},
) {
  assert(
    machine.transport !== 'connector',
    'Для этой машины доступна ручная карточка',
    409,
  );
  const deadline = AbortSignal.timeout(19000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (machine.transport === 'local') {
    const execute = (
      file,
      args,
      { timeout = 6000, limit = 1048576, merge = false, partial } = {},
    ) =>
      new Promise((resolve, reject) => {
        execFile(
          file,
          args,
          { timeout, windowsHide: true, maxBuffer: limit, signal: abort },
          (error, stdout, stderr) => {
            if (
              !error ||
              (typeof error.code === 'number' &&
                partial?.(stdout + '\n' + stderr))
            )
              resolve(merge ? stdout + '\n' + stderr : stdout);
            else reject(commandError(error, stderr, file, args));
          },
        );
      });
    return work(execute);
  }
  let ssh;
  try {
    ssh = await connect(machine, { signal: abort });
  } catch {
    throw remoteError('Не удалось подключиться к машине по SSH.');
  }
  // For mutations, let run() signal the remote command and wait for its exit.
  const close = () => ssh.destroy();
  if (!gracefulAbort) abort.addEventListener('abort', close, { once: true });
  try {
    abort.throwIfAborted();
    return await work(
      async (file, args, { timeout = 6000, limit = 1048576, partial } = {}) => {
        let output = '';
        try {
          return await run(ssh, 'exec ' + [file, ...args].map(q).join(' '), {
            timeout,
            limit,
            signal: abort,
            log: (line) => {
              output += line + '\n';
            },
          });
        } catch (error) {
          if (/кодом \d+/.test(error.message) && partial?.(output))
            return output;
          throw commandError(error, output, file, args, abort.aborted);
        }
      },
    );
  } finally {
    abort.removeEventListener('abort', close);
    ssh.end();
  }
}

function jsonLines(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

function dockerSource(row) {
  if (!containerId.test(row.id) || String(row.oneOff).toLowerCase() === 'true')
    return null;
  try {
    return serviceSource(
      row.stack && row.component
        ? { type: 'compose', stack: row.stack, component: row.component }
        : { type: 'docker', container: row.name?.split(',')[0] },
    );
  } catch {
    return null;
  }
}

function bytes(value) {
  const match = /^([\d.]+)\s*(B|[KMGTPE]i?B)$/i.exec(value || '');
  if (!match) return null;
  const unit = match[2].toUpperCase();
  const power = ' KMGTPE'.indexOf(unit[0]);
  const count =
    Number(match[1]) * (unit.includes('I') ? 1024 : 1000) ** Math.max(0, power);
  return Number.isFinite(count) ? Math.round(count) : null;
}

function total(rows, key) {
  return rows.length && rows.every((row) => Number.isFinite(row[key]))
    ? rows.reduce((sum, row) => sum + row[key], 0)
    : null;
}

function positiveNumber(value) {
  if (value === '' || value == null) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function containerStatus(row) {
  if (row.state === 'running') return 'running';
  if (row.state === 'restarting') return 'starting';
  if (row.state === 'dead' || (row.state === 'exited' && row.exitCode > 0))
    return 'failed';
  return 'stopped';
}

function summarizeDocker(entries, stats, siblings, statsErrors) {
  const { source, directory } = entries[0];
  const states = entries.map(containerStatus);
  const running = entries.filter((row) => row.state === 'running');
  const times = running
    .map((row) => Date.parse(row.started))
    .filter((at) => at > 0);
  const health = entries.map((row) => row.health);
  const ports = entries.flatMap((row) =>
    Object.entries(row.ports || {}).flatMap(([port, bindings]) =>
      (bindings || [])
        .map(({ HostIp, HostPort }) =>
          HostPort
            ? (HostIp ? HostIp + ':' : '') + HostPort + ' → ' + port
            : '',
        )
        .filter(Boolean),
    ),
  );
  const used = running.map((row) => stats.get(row.id) || {});
  const cpuCores = total(used, 'cpuCores');
  const memoryBytes = total(used, 'memoryBytes');
  const metricsError =
    statsErrors && running.length && (cpuCores == null || memoryBytes == null)
      ? running.map((row) => statsErrors.get(row.id)).find(Boolean) ||
        'Docker не вернул часть замеров CPU и памяти.'
      : undefined;
  return {
    source,
    name: source.type === 'compose' ? source.component : source.container,
    directory: directory || '',
    status: states.every((state) => state === states[0])
      ? states[0]
      : 'degraded',
    health: health.includes('unhealthy')
      ? 'unhealthy'
      : health.includes('starting')
        ? 'starting'
        : health.every((v) => v === 'healthy')
          ? 'healthy'
          : null,
    startedAt:
      times.length === entries.length
        ? new Date(Math.max(...times)).toISOString()
        : null,
    restarts: total(entries, 'restarts'),
    instances: { running: running.length, found: entries.length },
    cpuCores,
    memoryBytes,
    metricsError,
    images: [...new Set(entries.map((row) => row.image).filter(Boolean))].slice(
      0,
      12,
    ),
    ports: [...new Set(ports)].slice(0, 24),
    components: siblings,
    ids: entries.map((row) => row.id),
  };
}

async function listDocker(execute) {
  const listed = jsonLines(
    await execute('docker', ['ps', '-a', '--no-trunc', '--format', dockerList]),
  );
  return listed
    .map((row) => ({ ...row, source: dockerSource(row) }))
    .filter((row) => row.source);
}

async function readDocker(execute, sources, collectStats) {
  const wanted = new Set(sources?.map(sourceKey));
  const rows = await listDocker(execute);
  const selected = sources
    ? rows.filter((row) => wanted.has(sourceKey(row.source)))
    : rows.slice(0, maxDiscovery);
  assert(
    selected.length <= 512,
    'Слишком много контейнеров для одной проверки',
  );
  const inspected = new Map();
  for (let index = 0; index < selected.length; index += 80) {
    const ids = selected.slice(index, index + 80).map((row) => row.id);
    for (const row of jsonLines(
      await execute(
        'docker',
        ['inspect', '--type=container', '--format', dockerInspect, ...ids],
        { partial: dockerContainerGone },
      ),
    ))
      inspected.set(row.id, row);
  }
  const bySource = new Map();
  for (const row of selected) {
    const data = inspected.get(row.id);
    if (!data) continue;
    const key = sourceKey(row.source);
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push({ ...data, source: row.source });
  }
  const stats = new Map();
  const statsErrors = collectStats ? new Map() : undefined;
  const runningIds = [...inspected.values()]
    .filter((row) => row.state === 'running')
    .map((row) => row.id);
  if (statsErrors) {
    for (let index = 0; index < runningIds.length; index += 80) {
      const ids = runningIds.slice(index, index + 80);
      try {
        const output = await execute(
          'docker',
          [
            'stats',
            '--no-stream',
            '--no-trunc',
            '--format',
            dockerStats,
            ...ids,
          ],
          { partial: dockerContainerGone },
        );
        for (const row of jsonLines(output)) {
          const parsed = /^([\d.]+)%$/.exec(row.cpu);
          const cpu = parsed ? Number(parsed[1]) / 100 : null;
          stats.set(row.id, {
            cpuCores: cpu,
            memoryBytes: bytes(row.memory?.split('/')[0].trim()),
          });
        }
      } catch (error) {
        for (const id of ids) statsErrors.set(id, error.message);
      }
    }
  }
  const components = new Map();
  for (const { source } of rows) {
    if (source.type !== 'compose') continue;
    if (!components.has(source.stack)) components.set(source.stack, new Set());
    components.get(source.stack).add(source.component);
  }
  const records = Array.from(bySource.values(), (group) =>
    summarizeDocker(
      group,
      stats,
      [...(components.get(group[0].source.stack) || [])].slice(0, 24),
      statsErrors,
    ),
  );
  return { records, limited: !sources && rows.length > maxDiscovery };
}

export async function controlServiceSource(
  execute,
  source,
  action,
  beforeAction,
) {
  assert(Object.hasOwn(sshActions, action), 'Неизвестная операция с сервисом');
  if (source.type === 'systemd') {
    beforeAction();
    await execute(
      'systemctl',
      ['--no-ask-password', '--no-pager', action, '--', source.unit],
      { timeout: 14000 },
    );
    return 1;
  }
  const key = sourceKey(source);
  const ids = (await listDocker(execute))
    .filter((row) => sourceKey(row.source) === key)
    .map((row) => row.id);
  assert(ids.length, 'Контейнеры сервиса не найдены', 404);
  assert(ids.length <= 64, 'Слишком много экземпляров для одной операции');
  beforeAction();
  await execute('docker', [action, '--', ...ids], { timeout: 14000 });
  return ids.length;
}

function unitRecords(output) {
  return output
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((block) =>
      Object.fromEntries(
        block
          .split(/\r?\n/)
          .filter((line) => /^[A-Za-z]+=/.test(line))
          .map((line) => {
            const index = line.indexOf('=');
            return [line.slice(0, index), line.slice(index + 1)];
          }),
      ),
    )
    .filter((unit) => unitName.test(unit.Id || ''));
}

async function readSystemd(execute, sources) {
  let names = sources?.map((source) => source.unit);
  if (!names) {
    const output = await execute('systemctl', [
      'list-units',
      '--type=service',
      '--all',
      '--plain',
      '--no-legend',
      '--no-pager',
    ]);
    names = output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => unitName.test(name));
  }
  const selected = sources ? names : names.slice(0, maxDiscovery);
  const records = [];
  for (let index = 0; index < selected.length; index += 60) {
    const output = await execute(
      'systemctl',
      [
        'show',
        '--all',
        '--no-pager',
        '--property=' + unitFields,
        '--',
        ...selected.slice(index, index + 60),
      ],
      { partial: (output) => /^Id=/m.test(output) },
    );
    for (const unit of unitRecords(output)) {
      if (unit.LoadState === 'not-found') continue;
      const status =
        {
          active: 'running',
          inactive: 'stopped',
          failed: 'failed',
          activating: 'starting',
          reloading: 'starting',
          deactivating: 'stopped',
        }[unit.ActiveState] || 'unknown';
      records.push({
        source: { type: 'systemd', unit: unit.Id },
        name: unit.Id,
        description: unit.Description,
        directory: unit.WorkingDirectory || '',
        configPath: unit.FragmentPath || '',
        unitType: unit.Type || '',
        status,
        health: null,
        unitState: unit.SubState,
        sinceBootMicros:
          status === 'running' && unit.SubState !== 'exited'
            ? positiveNumber(unit.ExecMainStartTimestampMonotonic) ||
              positiveNumber(unit.ActiveEnterTimestampMonotonic)
            : null,
        restarts: positiveNumber(unit.NRestarts),
        memoryBytes:
          status === 'running' ? positiveNumber(unit.MemoryCurrent) : null,
      });
    }
  }
  if (records.some((unit) => unit.sinceBootMicros)) {
    try {
      const output = await execute('cat', ['/proc/uptime']);
      const uptime = Number(output.trim().split(/\s+/)[0]);
      for (const unit of records) {
        const elapsed = uptime - unit.sinceBootMicros / 1e6;
        if (unit.sinceBootMicros && Number.isFinite(elapsed) && elapsed >= 0)
          unit.startedAt = new Date(Date.now() - elapsed * 1000).toISOString();
      }
    } catch {}
  }
  return { records, limited: !sources && selected.length < names.length };
}

export async function inspectServices(
  execute,
  machine,
  sources,
  { collectStats = false } = {},
) {
  const group = (kind) =>
    sources?.filter((source) =>
      kind === 'docker'
        ? ['docker', 'compose'].includes(source.type)
        : source.type === 'systemd',
    );
  const tasks = {};
  if (!sources || group('docker').length)
    tasks.docker = readDocker(execute, group('docker'), collectStats);
  if (
    (machine.platform || 'linux') === 'linux' &&
    (!sources || group('systemd').length)
  )
    tasks.systemd = readSystemd(execute, group('systemd'));
  const results = await Promise.allSettled(Object.values(tasks));
  const records = new Map();
  const warnings = {};
  const unavailable = {};
  for (const [index, kind] of Object.keys(tasks).entries()) {
    const result = results[index];
    if (result.status === 'fulfilled') {
      for (const entry of result.value.records)
        records.set(sourceKey(entry.source), entry);
      if (result.value.limited)
        warnings[kind] =
          'Достигнут лимит результатов. Имя сервиса можно указать вручную.';
    } else {
      unavailable[kind] = result.reason.message;
      warnings[kind] = result.reason.message;
    }
  }
  return { records, warnings, unavailable };
}

export function runtimeError(inventory, source) {
  return inventory.unavailable[
    source.type === 'systemd' ? 'systemd' : 'docker'
  ];
}

export async function checkServiceHttp(execute, machine, url) {
  try {
    const output = await execute(
      machine.transport === 'local' && machine.platform === 'win32'
        ? 'curl.exe'
        : 'curl',
      [
        '--disable',
        '--noproxy',
        '*',
        '--proto',
        '=http',
        '--max-time',
        '4',
        '--silent',
        '--show-error',
        '--output',
        machine.transport === 'local' && machine.platform === 'win32'
          ? 'NUL'
          : '/dev/null',
        '--write-out',
        '%{http_code}',
        '--',
        url,
      ],
      { limit: 8192 },
    );
    const code = /^\d{3}$/.test(output.trim()) ? Number(output.trim()) : 0;
    return {
      status: code ? (code >= 200 && code < 300 ? 'ok' : 'failed') : 'unknown',
      code: code || null,
    };
  } catch (error) {
    return {
      status: [7, 18, 28, 52, 55, 56].includes(error.curlCode)
        ? 'failed'
        : 'unknown',
      code: null,
    };
  }
}

export async function readServiceMetricJson(execute, machine, url) {
  try {
    const output = await execute(
      machine.transport === 'local' && machine.platform === 'win32' ? 'curl.exe' : 'curl',
      [
        '--disable', '--noproxy', '*', '--proto', '=http', '--globoff',
        '--max-time', '4', '--max-filesize', '65536', '--silent', '--show-error',
        '--header', 'Accept: application/json', '--write-out', '\\n%{http_code}',
        '--', serviceUrl(url, true, 'Эндпоинт метрик'),
      ],
      { limit: 65540 },
    );
    const end = output.lastIndexOf('\n');
    const status = output.slice(end + 1).trim();
    if (end < 0 || !/^2\d\d$/.test(status))
      return { error: 'Эндпоинт метрик не вернул успешный HTTP-ответ.' };
    try {
      const document = JSON.parse(output.slice(0, end));
      if (document && typeof document === 'object') return { document };
    } catch {}
    return { error: 'Эндпоинт метрик должен вернуть JSON-объект или массив.' };
  } catch {
    return { error: 'Не удалось прочитать JSON-метрики на машине сервиса.' };
  }
}

function logLines(output, source, machine) {
  const safe = stripVTControlCharacters(
    redact(
      output,
      Object.values(machine.secret || {}).filter(
        (value) => typeof value === 'string',
      ),
    ),
  );
  return safe
    .split(/\r?\n/)
    .filter(Boolean)
    .map((text) => {
      const space = text.indexOf(' ');
      const date =
        space > 0 && /^\d{4}-\d{2}-\d{2}T/.test(text)
          ? text.slice(0, space)
          : '';
      return date && Number.isFinite(Date.parse(date))
        ? { at: date, source, text: text.slice(space + 1) }
        : { at: null, source, text };
    });
}

export async function readServiceLogs(execute, machine, service) {
  const source = service.source;
  if (source.type === 'systemd') {
    const output = await execute(
      'journalctl',
      [
        '--system',
        '--unit=' + source.unit,
        '--no-pager',
        '--lines=' + maxLogs,
        '--output=short-iso-precise',
      ],
      { limit: 262144, merge: true },
    );
    assert(
      !/not seeing messages from other users|insufficient permissions|permission denied/i.test(
        output
          .split(/\r?\n/)
          .filter((line) => !/^\d{4}-\d{2}-\d{2}T/.test(line))
          .join('\n'),
      ),
      'Недостаточно прав для чтения журнала службы.',
      403,
    );
    return {
      lines: logLines(output, source.unit, machine)
        .filter((line) => line.at)
        .slice(-maxLogs),
      warning: '',
    };
  }
  const inventory = await readDocker(execute, [source], false);
  const current = inventory.records[0];
  assert(current?.ids.length, 'Контейнеры сервиса не найдены', 404);
  const ids = current.ids.slice(0, 8);
  const results = await Promise.allSettled(
    ids.map(async (id) =>
      logLines(
        await execute(
          'docker',
          ['logs', '--tail', String(maxLogs), '--timestamps', id],
          { limit: 131072, merge: true },
        ),
        id.slice(0, 12),
        machine,
      ),
    ),
  );
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  if (!fulfilled.length) throw results[0].reason;
  const lines = fulfilled.flatMap((result) => result.value);
  lines.sort(
    (a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0),
  );
  return {
    lines: lines.slice(-maxLogs),
    warning:
      fulfilled.length < current.ids.length
        ? 'Логи получены только для части контейнеров.'
        : '',
  };
}
