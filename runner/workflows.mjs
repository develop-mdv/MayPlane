import { withoutCancellation } from './cancellation.mjs';
import {
  normalizeEnvDefinitions,
  updateEnvDefinitions,
  deploymentEnv,
  refreshEnvState,
} from '../lib/env-requirements.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import * as ssh from './ssh.mjs';
import { assert, q, envEntries } from './security.mjs';
import { removeManagedEndpoint } from './managed-deploy.mjs';
import { repositoryName } from './github.mjs';

export const workflowScope = (p) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        p.repo,
        p.branch,
        p.kind,
        ...(p.adoption ? [p.adoption.id] : []),
      ]),
    )
    .digest('hex');
export function workflowInput(input, project, source = 'Вручную') {
  assert(
    input && typeof input === 'object',
    'Нужен сценарий управления проектом',
  );
  const commands = {};
  for (const key of ['deploy', 'stop', 'remove', 'check', 'logs']) {
    assert(
      typeof input[key] === 'string' &&
        input[key].trim() &&
        input[key].length <= 24000 &&
        !input[key].includes('\0'),
      'Укажите команду ' + key + ', до 24 000 символов',
    );
    commands[key] = input[key];
  }
  const files = {};
  assert(
    !input.files ||
      (typeof input.files === 'object' && !Array.isArray(input.files)),
    'Некорректные файлы сценария',
  );
  for (const [path, content] of Object.entries(input.files || {})) {
    assert(
      /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,220}$/.test(path) &&
        !path
          .split('/')
          .some(
            (part) =>
              !part ||
              part === '..' ||
              part === '.git' ||
              /^\.env(?:\.|$)/.test(part),
          ),
      'Недопустимый путь файла сценария',
    );
    assert(
      typeof content === 'string' && content.length <= 48000,
      'Слишком большой файл сценария',
    );
    files[path] = content;
  }
  assert(
    JSON.stringify(files).length <= 160000,
    'Слишком много файлов сценария',
  );
  const env = normalizeEnvDefinitions(input.env || []);
  return {
    id: randomUUID(),
    scope: workflowScope(project),
    summary: String(input.summary || 'Сценарий управления проектом').slice(
      0,
      2000,
    ),
    ...commands,
    files,
    env,
    source,
    createdAt: new Date().toISOString(),
  };
}
export function saveWorkflow(store, projectId, input, source) {
  const p = store.get('projects', projectId);
  assert(p, 'Проект не найден', 404);
  const workflow = workflowInput(input, p, source);
  p.secret.workflow = workflow;
  p.workflow = {
    id: workflow.id,
    summary: workflow.summary,
    source: workflow.source,
    createdAt: workflow.createdAt,
  };
  updateEnvDefinitions(p, workflow.env);
  store.save('projects', p);
  return workflow;
}
export function workflowEnvironment(p, server) {
  const variables = p
    ? {
        ...(p.adoption ? {} : Object.fromEntries(envEntries(deploymentEnv(p)))),
        EZDEPLOY_PROJECT_ID: p.id,
        EZDEPLOY_PROJECT_NAME: p.name,
        EZDEPLOY_PROJECT_DIR: p.adoption?.directory || ssh.rootOf(p),
        EZDEPLOY_REPO_DIR:
          p.adoption?.git?.root ||
          p.adoption?.directory ||
          ssh.rootOf(p) + '/repo',
        EZDEPLOY_DATA_DIR: ssh.rootOf(p) + '/data',
        EZDEPLOY_ENV_FILE: p.adoption
          ? p.adoption.envFile || ''
          : ssh.rootOf(p) + '/.env',
        EZDEPLOY_DOMAIN: p.domain || '',
        EZDEPLOY_SERVER_HOST: server.host,
      }
    : { EZDEPLOY_SERVER_HOST: server.host };
  return Object.entries(variables)
    .map(([key, value]) => 'export ' + key + '=' + q(value))
    .join('\n');
}
export function createWorkflowRunner(store, overrides = {}) {
  const { run, put, rootOf, compose, workspaceOf } = { ...ssh, ...overrides };
  async function prepareRepository(client, p, log) {
    assert(
      !p.adoption,
      'Это существующее приложение. Обновляйте его исходный каталог явными командами; автоматический checkout отключён.',
    );
    const root = rootOf(p);
    const git = p.gitConnectionId
      ? store.get('git_connections', p.gitConnectionId)
      : null;
    assert(!p.gitConnectionId || git, 'GitHub-подключение не найдено');
    if (git) repositoryName(p.repo);
    const header = git
      ? 'Authorization: Basic ' +
        Buffer.from('x-access-token:' + git.secret.token).toString('base64')
      : '';
    const authPath = '/opt/ezdeploy/.auth/' + randomUUID();
    await run(
      client,
      `command -v git >/dev/null || { echo 'Сначала установите Git на сервер'; exit 1; }
install -d -m 700 ${q(root)} ${q(root + '/data')} /opt/ezdeploy/.auth
actual=$(realpath ${q(root)}); test "$actual" = ${q(root)} || { echo 'Каталог проекта является ссылкой'; exit 1; }`,
      { log },
    );
    try {
      if (header) await put(client, authPath, header);
      const auth = header
        ? `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${q('http.' + p.repo + '.extraheader')}; export GIT_CONFIG_VALUE_0="$(cat ${q(authPath)})"; trap 'rm -f -- ${authPath}' EXIT;`
        : '';
      await run(
        client,
        `${auth}
export GIT_TERMINAL_PROMPT=0
test ! -L ${q(root + '/repo')}
if [ ! -d ${q(root + '/repo/.git')} ]; then git -c credential.helper= -c http.followRedirects=false clone --single-branch --branch ${q(p.branch)} -- ${q(p.repo)} ${q(root + '/repo')}; fi
cd ${q(root + '/repo')}
git remote set-url origin ${q(p.repo)}
git -c credential.helper= -c http.followRedirects=false fetch origin ${q(p.branch)}
git reset --hard FETCH_HEAD`,
        { log },
      );
    } finally {
      if (header)
        await withoutCancellation(() =>
          run(client, `rm -f -- ${q(authPath)}`, { timeout: 10000 }),
        );
    }
    await syncEnv(client, p);
    const commit = (
      await run(client, `cd ${q(root + '/repo')} && git rev-parse HEAD`, {
        timeout: 10000,
      })
    ).trim();
    if (/^[a-f0-9]{40}$/.test(commit)) {
      const fresh = store.get('projects', p.id);
      fresh.commit = commit.slice(0, 8);
      store.save('projects', fresh);
    }
    log('Репозиторий обновлён. Данные хранятся отдельно от Git.');
  }
  async function syncEnv(client, p) {
    if (p.adoption) return;
    const root = rootOf(p);
    await run(
      client,
      `install -d -m 700 ${q(root)} ${q(root + '/data')}; test "$(realpath ${q(root)})" = ${q(root)}; test ! -L ${q(root + '/.env')}`,
    );
    await put(client, root + '/.env', deploymentEnv(p));
  }
  async function files(client, p, workflow) {
    assert(
      !p.adoption ||
        p.adoption.directory ||
        !Object.keys(workflow.files).length,
      'У привязки не определён каталог для файлов',
    );
    const root = p.adoption?.directory || rootOf(p);
    for (const [relative, content] of Object.entries(workflow.files)) {
      const path = root + '/' + relative;
      await run(
        client,
        `actual=$(realpath -m ${q(path)}); case "$actual" in ${q(root + '/')}*) ;; *) echo 'Файл вне проекта'; exit 1 ;; esac; test ! -L ${q(path)}; ${p.adoption ? 'mkdir -p --' : 'install -d -m 700'} ${q(posix.dirname(path))}`,
      );
      await put(client, path, content, { preserveMode: !!p.adoption });
    }
  }
  async function command(
    client,
    p,
    server,
    script,
    log,
    timeout = 10 * 60 * 1000,
  ) {
    assert(
      typeof script === 'string' &&
        script.trim() &&
        script.length <= 32000 &&
        !script.includes('\0'),
      'Некорректная команда',
    );
    const directory = p
      ? p.adoption
        ? p.adoption.directory || '/root'
        : rootOf(p)
      : '/root';
    // ssh.run owns the timeout and process group for this complete command.
    const inner = `${workflowEnvironment(p, server)}\ncd ${q(directory)}\n${script}`;
    return run(client, inner, { log, timeout, limit: 1024 * 1024 });
  }

  async function execute(client, p, server, operation, log) {
    assert(
      ['deploy', 'stop', 'remove', 'restart', 'logs', 'check'].includes(
        operation,
      ),
      'Неизвестное действие',
    );
    refreshEnvState(p);
    const workflow = p.secret.workflow;
    assert(
      workflow &&
        (!['deploy', 'restart'].includes(operation) ||
          workflow.scope === workflowScope(p)),
      'Сценарий устарел. Подготовьте его заново в чате.',
    );
    if (operation === 'deploy' || operation === 'restart') {
      const values = new Map(envEntries(p.secret.env));
      const missing = (p.requiredEnvKeys || []).filter(
        (key) => !values.get(key)?.trim(),
      );
      assert(
        p.adoption || !missing.length,
        'Заполните переменные в карточке проекта: ' + missing.join(', '),
      );
      if (!p.adoption) await prepareRepository(client, p, log);
      await files(client, p, workflow);
    } else if (!['logs', 'check'].includes(operation)) await syncEnv(client, p);
    const key = operation === 'restart' ? 'deploy' : operation;
    log('Сохранённый сценарий: ' + key + '. Без обращения к LLM.');
    log('$ ' + workflow[key]);
    let output;
    try {
      if (operation === 'restart') {
        log('Останавливаем проект перед повторным запуском.');
        await command(client, p, server, workflow.stop, log);
      }
      output = await command(
        client,
        p,
        server,
        workflow[key],
        log,
        ['logs', 'check'].includes(operation) ? 60000 : 600000,
      );
      if (['deploy', 'restart'].includes(operation)) {
        log('Проверяем результат запуска.');
        await command(client, p, server, workflow.check, log, 60000);
      }
      if (operation === 'remove')
        await removeManagedEndpoint(client, p, { store, run, put, log });
    } catch (error) {
      if (operation !== 'logs') {
        const failed = store.get('projects', p.id);
        failed.status = 'failed';
        store.save('projects', failed);
      }
      throw error;
    }
    if (operation === 'check') {
      const checked = store.get('projects', p.id);
      checked.status = 'running';
      if (checked.adoption)
        checked.adoption.checkedAt = new Date().toISOString();
      store.save('projects', checked);
    }
    if (!['logs', 'check'].includes(operation)) {
      const fresh = store.get('projects', p.id);
      fresh.status = ['stop', 'remove'].includes(operation)
        ? 'stopped'
        : 'running';
      if (operation === 'remove') {
        fresh.removedAt = new Date().toISOString();
        fresh.autoDeploy = false;
      } else if (operation !== 'stop') {
        delete fresh.removedAt;
        fresh.workflow.verifiedAt = new Date().toISOString();
      }
      fresh.updatedAt = new Date().toISOString();
      store.save('projects', fresh);
    }
    return output;
  }
  async function removeCompose(client, p, log) {
    // down keeps volumes and bind-mounted data. Missing checkouts have nothing to tear down.
    await run(
      client,
      `if [ -f ${q(workspaceOf(p) + '/' + posix.basename(p.composeFile))} ]; then
${compose(p)} down --remove-orphans
fi`,
      { log },
    );
    await removeManagedEndpoint(client, p, { store, run, put, log });
    const fresh = store.get('projects', p.id);
    fresh.status = 'stopped';
    fresh.autoDeploy = false;
    fresh.removedAt = new Date().toISOString();
    store.save('projects', fresh);
  }
  return { execute, prepareRepository, syncEnv, command, removeCompose };
}
