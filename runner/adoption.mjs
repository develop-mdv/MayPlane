import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import * as ssh from './ssh.mjs';
import { assert, q } from './security.mjs';
import { scrub } from './repository-context.mjs';
import { parseEnvDocument, serializeEnvDocument } from '../lib/environment.mjs';
import {
  inferEnvDefinitions,
  refreshEnvState,
} from '../lib/env-requirements.mjs';

const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const hasControl = (value) =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32);
const dockerId = (value) => /^[a-f0-9]{64}$/.test(value || '');
const serviceName = (value) =>
  /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,180}\.service$/.test(value || '') &&
  !/^(?:ssh|sshd|docker|containerd|systemd[^.]*|dbus|NetworkManager|networking|cron|polkit|ufw|firewalld)(?:[.@]|$)/.test(
    value,
  );
export function adoptionDirectory(value) {
  const path = String(value || '').trim();
  assert(
    !path ||
      (path.startsWith('/') &&
        path.length <= 500 &&
        !hasControl(path) &&
        !path.split('/').includes('..') &&
        !/^\/(?:proc|sys|dev)(?:\/|$)/.test(path) &&
        ![
          '/',
          '/etc',
          '/usr',
          '/bin',
          '/sbin',
          '/var',
          '/opt',
          '/srv',
          '/root',
          '/home',
          '/proc',
          '/sys',
          '/dev',
        ].includes(posix.normalize(path))),
    'Укажите полный путь к каталогу конкретного приложения',
  );
  return path ? posix.normalize(path).replace(/\/$/, '') : '';
}
function maybeDirectory(value) {
  try {
    return adoptionDirectory(value);
  } catch {
    return '';
  }
}
export function normalizedRepo(value) {
  const text = String(value || '')
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/');
  try {
    const url = new URL(text);
    return ['https:', 'http:', 'ssh:'].includes(url.protocol)
      ? `https://${url.hostname.toLowerCase()}${url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')}`
      : '';
  } catch {
    return '';
  }
}
function scope(p, s) {
  return hash([p.serverId, p.repo, p.branch, s.host, s.port, s.fingerprint]);
}
const template =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"status":{{json .State.Status}},"running":{{json .State.Running}},"health":{{if (index .State "Health")}}{{json .State.Health.Status}}{{else}}null{{end}},"project":{{if (index .Config "Labels")}}{{json (index .Config.Labels "com.docker.compose.project")}}{{else}}null{{end}},"directory":{{if (index .Config "Labels")}}{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}{{else}}null{{end}},"configFiles":{{if (index .Config "Labels")}}{{json (index .Config.Labels "com.docker.compose.project.config_files")}}{{else}}null{{end}},"service":{{if (index .Config "Labels")}}{{json (index .Config.Labels "com.docker.compose.service")}}{{else}}null{{end}},"oneoff":{{if (index .Config "Labels")}}{{json (index .Config.Labels "com.docker.compose.oneoff")}}{{else}}null{{end}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}';
function linesJson(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}
function systemdRecords(output) {
  return output
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) =>
      Object.fromEntries(
        block
          .split(/\r?\n/)
          .filter((line) => line.includes('='))
          .map((line) => [
            line.slice(0, line.indexOf('=')),
            line.slice(line.indexOf('=') + 1),
          ]),
      ),
    );
}
function summarizeContainers(containers) {
  const groups = new Map();
  for (const c of containers.filter(
    (c) => dockerId(c.id) && String(c.oneoff).toLowerCase() !== 'true',
  )) {
    const key = c.project
      ? `compose:${c.project}:${c.directory || ''}`
      : `docker:${c.id}`;
    const group = groups.get(key) || {
      runtime: c.project ? 'compose' : 'docker',
      name: c.project || c.name?.replace(/^\//, '') || c.id.slice(0, 12),
      directory: maybeDirectory(c.directory),
      resources: [],
      images: [],
      ports: [],
      mounts: [],
      configFiles: [],
      containers: [],
    };
    group.resources.push(c.id);
    group.containers.push(c);
    group.images.push(c.image || '');
    group.configFiles.push(
      ...String(c.configFiles || '')
        .split(',')
        .filter((path) => path.startsWith('/') && !hasControl(path)),
    );
    for (const [port, bindings] of Object.entries(c.ports || {}))
      for (const binding of bindings || [])
        group.ports.push(
          `${binding.HostIp || '0.0.0.0'}:${binding.HostPort} → ${port}`,
        );
    for (const mount of c.mounts || [])
      group.mounts.push({
        type: mount.Type,
        source: mount.Source,
        target: mount.Destination,
        name: mount.Name || '',
        readOnly: mount.RW === false,
      });
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => {
    g.resources.sort();
    g.id = hash([g.runtime, g.resources]);
    g.status = g.containers.every((c) => c.running && c.health !== 'unhealthy')
      ? 'running'
      : g.containers.every((c) => !c.running)
        ? 'stopped'
        : 'failed';
    g.images = [...new Set(g.images)];
    g.configFiles = [...new Set(g.configFiles)].slice(0, 8);
    g.ports = [...new Set(g.ports)];
    return g;
  });
}
function candidatePublic(c, p, store) {
  const linked = store
    .list('projects')
    .find(
      (other) =>
        other.id !== p.id &&
        other.serverId === p.serverId &&
        (other.adoption?.resources?.some((r) => c.resources.includes(r)) ||
          c.name === 'ez_' + other.id ||
          c.directory === '/opt/ezdeploy/' + other.id + '/repo'),
    );
  const { containers: _containers, ...data } = c;
  return { ...data, ...(linked ? { linkedProject: linked.name } : {}) };
}
export function envFromEntries(entries) {
  const rows = [];
  const names = new Set();
  for (const entry of entries) {
    const split = entry.indexOf('=');
    if (split < 1) continue;
    const key = entry.slice(0, split);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || names.has(key)) continue;
    names.add(key);
    rows.push({
      id: key,
      key,
      value: entry.slice(split + 1),
      interpolate: false,
    });
  }
  return serializeEnvDocument({ source: '', rows });
}
export function adoptionCommands(a) {
  const fail = (message) => `printf '%s\\n' ${q(message)} >&2; exit 1`;
  if (['docker', 'compose'].includes(a.runtime)) {
    assert(
      a.resources.length && a.resources.every(dockerId),
      'Некорректные идентификаторы контейнеров',
    );
    const ids = a.resources.map(q).join(' ');
    return {
      deploy: `docker start ${ids}`,
      restart: `docker restart ${ids}`,
      stop: `docker stop ${ids}`,
      remove: `docker rm -f ${ids}`,
      check: `docker inspect --format '{{.State.Running}} {{if (index .State "Health")}}{{.State.Health.Status}}{{else}}none{{end}}' ${ids} | awk 'BEGIN {ok=1} $1 != "true" || $2 == "unhealthy" {ok=0} END {exit !ok}'`,
      logs: a.resources
        .map(
          (id) =>
            `printf '%s\\n' ${q('Контейнер ' + id.slice(0, 12))}; docker logs --tail 100 --timestamps ${q(id)} 2>&1`,
        )
        .join('\n'),
    };
  }
  if (a.runtime === 'systemd') {
    const units = a.units || [a.unit];
    assert(units.length && units.every(serviceName), 'Некорректная служба');
    const unit = units.map(q).join(' ');
    return {
      deploy: `systemctl start -- ${unit}`,
      restart: `systemctl restart -- ${unit}`,
      stop: `systemctl stop -- ${unit}`,
      remove: `systemctl disable --now -- ${unit}`,
      check: units
        .map((name) => `systemctl is-active --quiet -- ${q(name)}`)
        .join('\n'),
      logs: `journalctl ${units.map((name) => '--unit=' + q(name)).join(' ')} --no-pager --lines=200 --output=short-iso`,
    };
  }
  return {
    deploy: fail('Способ запуска не определён. Подготовьте сценарий в чате.'),
    restart: fail('Подготовьте сценарий перезапуска в чате.'),
    stop: fail('Процесс не определён. Подготовьте сценарий в чате.'),
    remove: fail(
      'Для удаления нужен сценарий. Чтобы убрать привязку, нажмите «Отвязать».',
    ),
    check: `test -d ${q(a.directory)}`,
    logs: fail('Источник логов не определён. Укажите его в чате.'),
  };
}
const statusDescription = (c) =>
  ({
    running: 'Приложение работает.',
    stopped: 'Приложение остановлено.',
    failed: 'Обнаружена ошибка состояния приложения.',
    needs_setup: 'Каталог доступен. Для проверки процесса нужен сценарий.',
  })[c.status];
export function createAdoption(store, overrides = {}) {
  const { run } = { ...ssh, ...overrides };
  async function inventory(client, directory = '', bound = null) {
    const warnings = [];
    let containers = [],
      units = [];
    try {
      const out =
        bound && !['docker', 'compose'].includes(bound.runtime)
          ? ''
          : await run(
              client,
              `# ezdeploy:discover-docker\nif command -v docker >/dev/null 2>&1; then ${bound ? `ids=${q(bound.resources.filter(dockerId).join(' '))}` : "ids=$(docker ps -aq --no-trunc | sed -n '1,150p')"}; if [ -n "$ids" ]; then docker inspect --format ${q(template)} $ids; fi; fi`,
              { timeout: 20000, limit: 1500000 },
            );
      containers = linesJson(out);
    } catch {
      warnings.push('Не удалось проверить Docker.');
    }
    try {
      const out =
        bound && bound.runtime !== 'systemd'
          ? ''
          : await run(
              client,
              `# ezdeploy:discover-systemd\nif command -v systemctl >/dev/null 2>&1; then ${bound ? `units=${q(serviceName(bound.unit) ? bound.unit : '')}` : "units=$(systemctl list-units --type=service --all --no-pager --plain --no-legend | awk '{print $1}' | sed -n '1,150p')"}; if [ -n "$units" ]; then systemctl show --no-pager --property=Id,Description,ActiveState,SubState,MainPID,WorkingDirectory,FragmentPath,User -- $units; fi; fi`,
              { timeout: 20000, limit: 500000 },
            );
      units = systemdRecords(out).filter(
        (u) =>
          serviceName(u.Id) &&
          (u.FragmentPath?.startsWith('/etc/systemd/system/') ||
            (directory && maybeDirectory(u.WorkingDirectory) === directory)),
      );
    } catch {
      warnings.push('Не удалось проверить systemd.');
    }
    const candidates = summarizeContainers(containers);
    for (const unit of units)
      candidates.push({
        id: hash(['systemd', unit.Id, unit.FragmentPath]),
        runtime: 'systemd',
        name: unit.Id,
        unit: unit.Id,
        directory: maybeDirectory(unit.WorkingDirectory),
        resources: ['systemd:' + unit.Id],
        status:
          unit.ActiveState === 'active'
            ? 'running'
            : unit.ActiveState === 'failed'
              ? 'failed'
              : 'stopped',
        description: scrub(unit.Description || '').slice(0, 200),
        fragmentPath: unit.FragmentPath,
        pid: Number(unit.MainPID) || 0,
        user: unit.User || 'root',
        configFiles: [unit.FragmentPath],
        ports: [],
        mounts: [],
        images: [],
      });
    if (
      directory &&
      (!bound || bound.runtime === 'directory') &&
      !candidates.some((c) => c.directory === directory)
    ) {
      const exists = await run(
        client,
        `# ezdeploy:discover-directory\nif [ -d ${q(directory)} ]; then realpath -- ${q(directory)}; fi`,
        { timeout: 10000 },
      );
      if (exists.trim() === directory)
        candidates.push({
          id: hash(['directory', directory]),
          runtime: 'directory',
          name: posix.basename(directory),
          directory,
          resources: ['directory:' + directory],
          status: 'needs_setup',
          ports: [],
          mounts: [],
          images: [],
          configFiles: [],
        });
      else
        warnings.push(
          'Указанный каталог не найден или является ссылкой. Укажите его реальный путь.',
        );
    }
    return { candidates, warnings };
  }
  async function gitInfo(client, directory) {
    if (!directory) return null;
    try {
      const out = await run(
        client,
        `# ezdeploy:inspect-git\nif command -v git >/dev/null 2>&1 && git -C ${q(directory)} rev-parse --show-toplevel >/dev/null 2>&1; then git -C ${q(directory)} rev-parse --show-toplevel; git -C ${q(directory)} remote get-url origin 2>/dev/null || printf '\\n'; git -C ${q(directory)} symbolic-ref --short -q HEAD || printf 'HEAD\\n'; git -C ${q(directory)} rev-parse HEAD; fi`,
        { timeout: 10000, limit: 12000 },
      );
      const [root, repo, branch, commit] = out.trim().split(/\r?\n/);
      if (!/^[a-f0-9]{40}$/.test(commit || '')) return null;
      return {
        root: maybeDirectory(root),
        repo: normalizedRepo(repo),
        branch: String(branch).slice(0, 100),
        commit,
      };
    } catch {
      return null;
    }
  }
  async function readFile(client, path, limit = 65535) {
    if (!path?.startsWith('/') || hasControl(path)) return null;
    const out = await run(
      client,
      `# ezdeploy:read-adoption-file\nif [ -f ${q(path)} ] && [ ! -L ${q(path)} ] && [ "$(realpath -- ${q(path)})" = ${q(posix.normalize(path))} ]; then size=$(wc -c < ${q(path)}); if [ "$size" -le ${limit} ]; then printf 'FILE:'; base64 -w0 -- ${q(path)}; fi; fi`,
      { timeout: 10000, limit: limit * 2 },
    );
    return out.startsWith('FILE:')
      ? Buffer.from(out.slice(5).trim(), 'base64').toString('utf8')
      : null;
  }
  async function discover(client, p, s, directory, log) {
    assert(!p.adoption, 'Проект уже привязан. Сначала отвяжите его.', 409);
    const expected = scope(p, s);
    const result = await inventory(client, adoptionDirectory(directory));
    const needle =
      normalizedRepo(p.repo).split('/').at(-1)?.toLowerCase() || p.name;
    const matched = result.candidates.sort(
      (a, b) =>
        Number((b.name + ' ' + b.directory).toLowerCase().includes(needle)) -
        Number((a.name + ' ' + a.directory).toLowerCase().includes(needle)),
    );
    const gitCache = new Map();
    for (const c of matched.slice(0, 30))
      if (c.directory) {
        if (!gitCache.has(c.directory))
          gitCache.set(c.directory, await gitInfo(client, c.directory));
        c.git = gitCache.get(c.directory);
        c.repoMatch = !!c.git?.repo && c.git.repo === normalizedRepo(p.repo);
      }
    matched.sort((a, b) => Number(!!b.repoMatch) - Number(!!a.repoMatch));
    const fresh = store.get('projects', p.id);
    assert(
      fresh && scope(fresh, store.get('servers', p.serverId)) === expected,
      'Настройки изменились. Повторите поиск.',
      409,
    );
    fresh.secret.discovery = {
      id: randomUUID(),
      scope: expected,
      createdAt: new Date().toISOString(),
      directory: directory || '',
      warnings: result.warnings,
      candidates: matched.map((c) => candidatePublic(c, p, store)),
    };
    fresh.discovery = {
      id: fresh.secret.discovery.id,
      createdAt: fresh.secret.discovery.createdAt,
      count: matched.length,
    };
    store.save('projects', fresh);
    log(
      `Найдено вариантов: ${matched.length}. Выберите приложение в карточке проекта. На сервере ничего не изменено.`,
    );
  }
  function preview(p) {
    return p.secret.discovery || null;
  }
  async function attach(client, p, s, { scanId, candidateId }, log) {
    const scan = p.secret.discovery;
    assert(!p.adoption, 'Проект уже привязан', 409);
    assert(
      scan &&
        scan.id === scanId &&
        scan.scope === scope(p, s) &&
        Date.now() - Date.parse(scan.createdAt) < 30 * 60000,
      'Результат поиска устарел. Проверьте сервер заново.',
      409,
    );
    const selected = scan.candidates.find((c) => c.id === candidateId);
    assert(selected, 'Выберите найденное приложение', 400);
    const current = (await inventory(client, scan.directory)).candidates.find(
      (c) => c.id === candidateId,
    );
    assert(current, 'Приложение изменилось или исчезло. Повторите поиск.', 409);
    assert(
      !candidatePublic(current, p, store).linkedProject,
      'Приложение уже привязано к другой карточке',
      409,
    );
    assert(
      current.directory === selected.directory &&
        JSON.stringify(current.resources) ===
          JSON.stringify(selected.resources),
      'Состав приложения изменился. Повторите поиск.',
      409,
    );
    const configuration = {};
    const envByService = [];
    const warnings = [];
    if (['compose', 'docker'].includes(current.runtime)) {
      const raw = await run(
        client,
        `# ezdeploy:inspect-selected-containers\ndocker inspect ${current.resources.map(q).join(' ')}`,
        { timeout: 20000, limit: 2000000 },
      );
      const inspected = JSON.parse(raw);
      assert(
        Array.isArray(inspected) &&
          inspected.length === current.resources.length &&
          inspected.every((c) => current.resources.includes(c.Id)),
        'Не удалось проверить контейнеры',
      );
      configuration.containers = inspected;
      for (const c of inspected)
        envByService.push({
          name:
            c.Config?.Labels?.['com.docker.compose.service'] ||
            c.Name?.replace(/^\//, ''),
          env: envFromEntries(c.Config?.Env || []),
        });
    } else if (current.runtime === 'systemd') {
      configuration.unit = await run(
        client,
        `# ezdeploy:inspect-selected-unit\nsystemctl cat -- ${q(current.unit)}`,
        { timeout: 10000, limit: 150000 },
      );
      if (current.pid > 1) {
        try {
          const raw = await run(
            client,
            `# ezdeploy:inspect-selected-environment\nbase64 -w0 -- /proc/${current.pid}/environ`,
            { timeout: 10000, limit: 100000 },
          );
          envByService.push({
            name: current.unit,
            env: envFromEntries(
              Buffer.from(raw.trim(), 'base64').toString('utf8').split('\0'),
            ),
          });
        } catch {
          warnings.push('Не удалось прочитать окружение службы.');
        }
      }
    }
    const sourceFiles = {};
    for (const file of current.configFiles) {
      if (
        current.runtime !== 'systemd' &&
        (!current.directory ||
          !posix.normalize(file).startsWith(current.directory + '/') ||
          !/\.ya?ml$/i.test(file))
      ) {
        warnings.push('Файл вне каталога приложения не импортирован: ' + file);
        continue;
      }
      const content = await readFile(client, file, 131000);
      if (content !== null) sourceFiles[file] = content;
      else warnings.push('Конфигурация недоступна для чтения: ' + file);
    }
    let envFile = '',
      environmentSource = 'runtime',
      env = '';
    if (current.directory) {
      const file = current.directory + '/.env';
      const content = await readFile(client, file);
      if (content !== null) {
        try {
          parseEnvDocument(content);
          env = content;
          envFile = file;
          sourceFiles[file] = content;
          environmentSource = 'file';
        } catch {
          warnings.push(
            'Формат .env не поддерживает редактор. Сохранён снимок файла; используем окружение процесса.',
          );
          sourceFiles[file] = content;
        }
      }
    }
    const conflicts = new Set();
    if (!envFile) {
      const values = new Map();
      for (const service of envByService)
        for (const row of parseEnvDocument(service.env).rows) {
          if (values.has(row.key) && values.get(row.key) !== row.value)
            conflicts.add(row.key);
          else values.set(row.key, row.value);
        }
      env = envFromEntries(
        [...values]
          .filter(([key]) => !conflicts.has(key))
          .map(([key, value]) => key + '=' + value),
      );
    }
    const git = await gitInfo(client, current.directory);
    if (git?.repo && git.repo !== normalizedRepo(p.repo))
      warnings.push(
        'Репозиторий на сервере отличается от ссылки в карточке. Исходные данные сервера сохранены в привязке.',
      );
    if (conflicts.size)
      warnings.push(
        'Значения различаются между сервисами: ' +
          [...conflicts].join(', ') +
          '. Раздельные окружения сохранены в снимке.',
      );
    const fresh = store.get('projects', p.id);
    assert(
      fresh &&
        scope(fresh, store.get('servers', s.id)) === scan.scope &&
        fresh.secret.discovery?.id === scanId,
      'Настройки изменились. Повторите поиск.',
      409,
    );
    assert(
      !candidatePublic(current, p, store).linkedProject,
      'Приложение уже привязано',
      409,
    );
    const publicBinding = {
      ...candidatePublic(current, p, store),
      id: randomUUID(),
      linkedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      git,
      envFile,
      environmentSource,
      environmentConflicts: [...conflicts],
      warnings,
      sourceFiles: Object.entries(sourceFiles).map(([path, content]) => ({
        path,
        sha256: hash(content),
        bytes: Buffer.byteLength(content),
      })),
    };
    delete publicBinding.linkedProject;
    fresh.secret.adoptionBackup = {
      env: fresh.secret.env,
      workflow: fresh.secret.workflow || null,
      assistantPlan: fresh.secret.assistantPlan || null,
    };
    fresh.secret.adopted = {
      binding: publicBinding,
      configuration,
      sourceFiles,
      envByService,
    };
    fresh.secret.env = env;
    fresh.adoption = publicBinding;
    fresh.status = current.status;
    fresh.autoDeploy = false;
    fresh.envDefinitions = inferEnvDefinitions(
      sourceFiles,
      parseEnvDocument(env).rows.map((r) => r.key),
    );
    fresh.requiredEnvKeys = [];
    // Runtime snapshots may contain image defaults unrelated to owner input. Do not impose old plan requirements.
    refreshEnvState(fresh);
    if (git?.commit) fresh.commit = git.commit.slice(0, 8);
    for (const key of [
      'assistant',
      'workflow',
      'diagnosis',
      'managedDeployment',
      'managedDomain',
      'publicUrl',
      'removedAt',
      'pendingPlanCommit',
    ])
      delete fresh[key];
    for (const key of [
      'workflow',
      'workflowDraft',
      'assistantPlan',
      'generatedFiles',
      'discovery',
    ])
      delete fresh.secret[key];
    delete fresh.discovery;
    fresh.updatedAt = new Date().toISOString();
    store.save('projects', fresh);
    log(
      'Приложение привязано. Конфигурация и переменные сохранены зашифрованными. Процессы, файлы и данные на сервере не изменялись.',
    );
  }
  async function migratedInventory(client, a) {
    adoptionCommands(a); // Validate pinned resource identifiers before inspection.
    if (a.runtime === 'systemd') {
      const units = a.units || [a.unit];
      const records = systemdRecords(
        await run(
          client,
          'systemctl show --no-pager --property=Id,ActiveState,FragmentPath -- ' +
            units.map(q).join(' '),
        ),
      );
      assert(
        records.length === units.length &&
          records.every(
            (u) =>
              units.includes(u.Id) &&
              u.FragmentPath === (a.unitFiles?.[u.Id] || a.fragmentPath),
          ),
        'Состав перенесённых служб изменился',
        409,
      );
      return {
        ...a,
        status: records.every((u) => u.ActiveState === 'active')
          ? 'running'
          : records.every((u) => ['inactive', 'failed'].includes(u.ActiveState))
            ? 'stopped'
            : 'failed',
      };
    }
    const containers = JSON.parse(
      await run(client, 'docker inspect ' + a.resources.map(q).join(' ')),
    );
    assert(
      containers.length === a.resources.length &&
        containers.every(
          (c) =>
            a.resources.includes(c.Id) &&
            c.Config.Labels?.['ezdeploy.migration'] === a.migrationId,
        ),
      'Состав перенесённых контейнеров изменился',
      409,
    );
    return {
      ...a,
      status: containers.every(
        (c) =>
          c.State.Running &&
          !c.State.Restarting &&
          c.State.Health?.Status !== 'unhealthy',
      )
        ? 'running'
        : containers.every((c) => !c.State.Running)
          ? 'stopped'
          : 'failed',
    };
  }
  async function execute(client, p, operation, log = () => {}) {
    const a = p.adoption;
    assert(a, 'Нет привязки');
    assert(
      ['deploy', 'restart', 'stop', 'remove', 'check', 'logs'].includes(
        operation,
      ),
      'Неизвестная операция',
    );
    const current = a.migrationId
      ? await migratedInventory(client, a)
      : (await inventory(client, a.directory, a)).candidates.find(
          (c) =>
            c.runtime === a.runtime &&
            JSON.stringify(c.resources) === JSON.stringify(a.resources),
        );
    assert(
      current &&
        current.directory === a.directory &&
        (a.runtime !== 'systemd' || current.fragmentPath === a.fragmentPath),
      'Приложение изменилось или не найдено. Проверьте привязку перед управлением.',
      409,
    );
    const command = adoptionCommands(a)[operation];
    log(
      'Используем существующее приложение: ' +
        a.name +
        '. Без пересоздания конфигурации.',
    );
    const output =
      operation === 'check'
        ? statusDescription(current)
        : await run(client, command, {
            log,
            timeout: operation === 'logs' ? 30000 : 120000,
          });
    if (['deploy', 'restart'].includes(operation))
      await run(client, adoptionCommands(a).check, { log, timeout: 30000 });
    if (operation !== 'logs') {
      const fresh = store.get('projects', p.id);
      fresh.adoption.checkedAt = new Date().toISOString();
      fresh.status =
        operation === 'check'
          ? current.status
          : ['stop', 'remove'].includes(operation)
            ? 'stopped'
            : current.runtime === 'directory'
              ? 'needs_setup'
              : 'running';
      if (operation === 'remove') {
        fresh.removedAt = new Date().toISOString();
        fresh.autoDeploy = false;
      } else if (operation === 'deploy') delete fresh.removedAt;
      store.save('projects', fresh);
    }
    if (operation === 'check') log(output);
    return output;
  }
  return { discover, attach, preview, execute, inventory };
}
