import { randomUUID } from 'node:crypto';
import * as ssh from './ssh.mjs';
import {
  assert,
  q,
  envEntries,
  redact,
  validateMigrationConfig,
} from './security.mjs';

export function createEngine(store, overrides = {}) {
  const { connect, run, put, copyFile, compose, rootOf, metrics } = {
    ...ssh,
    ...overrides,
  };
  let queue = Promise.resolve();
  // Never replay an interrupted destructive operation automatically.
  for (const job of store.list('jobs'))
    if (['pending', 'deploying'].includes(job.status)) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.logs.push(
        'Исполнитель был перезапущен. Проверьте контейнеры на обоих серверах перед повтором.',
      );
      store.save('jobs', job);
      if (job.projectId) {
        const p = store.get('projects', job.projectId);
        if (p) {
          p.status = 'failed';
          store.save('projects', p);
        }
      }
    }
  async function refresh(server) {
    const client = await connect(server);
    try {
      Object.assign(server, await metrics(client));
      store.save('servers', server);
      return server;
    } finally {
      client.end();
    }
  }
  async function execute(job) {
    const project = job.projectId ? store.get('projects', job.projectId) : null;
    const server = store.get('servers', job.serverId || project?.serverId);
    const secrets = [
      server?.secret.password,
      server?.secret.privateKey,
      ...(project ? envEntries(project.secret.env).map((e) => e[1]) : []),
    ].filter(Boolean);
    const log = (line) => {
      job.logs.push(redact(line, secrets));
      job.logs = job.logs.slice(-2000);
      store.save('jobs', job);
    };
    job.status = 'deploying';
    store.save('jobs', job);
    let client;
    try {
      assert(server, 'Сервер не найден');
      client = await connect(server);
      log('SSH: ключ сервера проверен, соединение установлено.');
      if (job.type === 'provision') {
        await run(
          client,
          `. /etc/os-release; test "$ID" = ubuntu && test "$VERSION_ID" = 24.04 || { echo 'Поддерживается Ubuntu 24.04'; exit 1; }; export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y docker.io docker-compose-v2 git ca-certificates tar; systemctl enable --now docker; install -d -m 700 /opt/ezdeploy /opt/ezdeploy-backups; docker compose version`,
          { log },
        );
        Object.assign(server, await metrics(client));
        store.save('servers', server);
      } else if (job.type === 'deploy') {
        const root = rootOf(project);
        project.status = 'deploying';
        store.save('projects', project);
        await run(
          client,
          `command -v git; docker compose version; install -d -m 700 ${q(root)}; if [ ! -d ${q(root + '/repo/.git')} ]; then GIT_TERMINAL_PROMPT=0 git clone --single-branch --branch ${q(project.branch)} -- ${q(project.repo)} ${q(root + '/repo')}; fi; cd ${q(root + '/repo')}; GIT_TERMINAL_PROMPT=0 git fetch origin ${q(project.branch)}; git reset --hard FETCH_HEAD; if git ls-files --error-unmatch .env >/dev/null 2>&1; then echo 'Удалите .env из Git: секреты загружаются отдельно'; exit 1; fi; test -f ${q(project.composeFile)}; test ! -L .env`,
          { log },
        );
        await put(client, root + '/repo/.env', project.secret.env);
        log('.env записан с правами 0600. Значения скрыты.');
        await run(
          client,
          `${compose(project)} config -q\n${compose(project)} up -d --build --remove-orphans --wait --wait-timeout 120`,
          { log },
        );
        project.commit = (
          await run(
            client,
            `cd ${q(root + '/repo')}; git rev-parse --short HEAD`,
          )
        ).trim();
        project.status = 'running';
        project.updatedAt = new Date().toISOString();
        store.save('projects', project);
      } else if (job.type === 'migration') {
        await migrate(client, project, job, log);
      } else {
        await run(
          client,
          `${compose(project)} ${job.type === 'stop' ? 'stop --timeout 60' : 'up -d --force-recreate --wait --wait-timeout 120'}`,
          { log },
        );
        project.status = job.type === 'stop' ? 'stopped' : 'running';
        project.updatedAt = new Date().toISOString();
        store.save('projects', project);
      }
      job.status = 'success';
      log('Операция завершена.');
    } catch (e) {
      job.status = 'failed';
      log(`Ошибка: ${e.message}`);
      if (project) {
        const fresh = store.get('projects', project.id);
        if (job.type !== 'migration') {
          fresh.status = 'failed';
          store.save('projects', fresh);
        }
      }
    } finally {
      client?.end();
      job.finishedAt = new Date().toISOString();
      store.save('jobs', job);
    }
  }
  async function migrate(source, p, job, log) {
    const destination = store.get('servers', job.target);
    assert(destination, 'Целевой сервер не найден');
    const target = await connect(destination);
    const root = rootOf(p);
    const backup = `/opt/ezdeploy-backups/${job.id}`;
    let stopped = false,
      targetStarted = false;
    try {
      const archA = await run(source, 'uname -m');
      const archB = await run(target, 'uname -m');
      assert(
        archA.trim() === archB.trim(),
        'Архитектуры серверов должны совпадать',
      );
      await run(
        target,
        `docker compose version; test ! -e ${q(root)}; install -d -m 700 /opt/ezdeploy ${q(backup)}`,
      );
      const config = JSON.parse(
        await run(source, `${compose(p)} config --format json`),
      );
      validateMigrationConfig(config, root);
      const volumes = [];
      for (const [logical, v] of Object.entries(config.volumes || {})) {
        const name = v.name || `ez_${p.id}_${logical}`;
        const info = JSON.parse(
          await run(source, `docker volume inspect ${q(name)}`),
        )[0];
        assert(
          info.Driver === 'local' &&
            !Object.keys(info.Options || {}).length &&
            info.Labels?.['com.docker.compose.project'] === `ez_${p.id}`,
          'Обнаружен том вне управления проекта',
        );
        const users = (
          await run(source, `docker ps -aq --filter ${q('volume=' + name)}`)
        ).trim();
        if (users) {
          const containers = JSON.parse(
            await run(
              source,
              `docker inspect ${users.split(/\s+/).map(q).join(' ')}`,
            ),
          );
          assert(
            containers.every(
              (c) =>
                c.Config.Labels?.['com.docker.compose.project'] ===
                `ez_${p.id}`,
            ),
            'Том используется другим проектом',
          );
        }
        await run(
          target,
          `if docker volume inspect ${q(name)} >/dev/null 2>&1; then echo 'На целевом сервере уже есть одноимённый том'; exit 1; fi`,
        );
        volumes.push({ name, logical, path: info.Mountpoint });
      }
      for (const service of Object.values(config.services))
        for (const mount of service.volumes || [])
          if (mount.type === 'bind') {
            const actual = (
              await run(source, `realpath ${q(mount.source)}`)
            ).trim();
            assert(
              actual.startsWith(root + '/'),
              'Bind mount ссылается за пределы проекта',
            );
          }
      const ids = (await run(source, `${compose(p)} ps -aq`))
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      assert(ids.length, 'Сначала разверните проект');
      const containers = JSON.parse(
        await run(source, `docker inspect ${ids.map(q).join(' ')}`),
      );
      const images = containers.map((c) => c.Config.Image);
      assert(
        images.every((i) => typeof i === 'string' && i),
        'Не удалось определить образы контейнеров',
      );
      log(
        'Проверены архитектура, тома и пути данных. На время копирования проект будет остановлен.',
      );
      await run(source, `${compose(p)} stop --timeout 60`, { log });
      stopped = true;
      p.status = 'stopped';
      store.save('projects', p);
      await run(
        source,
        `install -d -m 700 ${q(backup)}; tar -C /opt/ezdeploy -czf ${q(backup + '/project.tgz')} ${q(p.id)}; docker image save -o ${q(backup + '/images.tar')} ${[...new Set(images)].map(q).join(' ')}`,
        { log, timeout: 3600000 },
      );
      for (let i = 0; i < volumes.length; i++)
        await run(
          source,
          `tar --numeric-owner -C ${q(volumes[i].path)} -czf ${q(backup + `/volume-${i}.tgz`)} .`,
          { timeout: 3600000 },
        );
      for (const file of [
        'project.tgz',
        'images.tar',
        ...volumes.map((_, i) => `volume-${i}.tgz`),
      ]) {
        log(`Копирование ${file}…`);
        await copyFile(source, target, backup + '/' + file);
        log(`${file}: SHA-256 совпадает.`);
      }
      await run(
        target,
        `tar -xzf ${q(backup + '/project.tgz')} -C /opt/ezdeploy; docker image load -i ${q(backup + '/images.tar')}`,
        { log, timeout: 3600000 },
      );
      for (let i = 0; i < volumes.length; i++) {
        const v = volumes[i];
        await run(
          target,
          `docker volume create --label ${q('com.docker.compose.project=ez_' + p.id)} --label ${q('com.docker.compose.volume=' + v.logical)} ${q(v.name)}; dest=$(docker volume inspect --format '{{.Mountpoint}}' ${q(v.name)}); tar --numeric-owner -xzf ${q(backup + `/volume-${i}.tgz`)} -C "$dest"`,
          { log, timeout: 3600000 },
        );
      }
      targetStarted = true;
      await run(
        target,
        `${compose(p)} up -d --no-build --pull never --wait --wait-timeout 180`,
        { log },
      );
      p.serverId = destination.id;
      p.status = 'running';
      p.updatedAt = new Date().toISOString();
      store.save('projects', p);
      log(
        'Проект запущен на новом сервере. Исходный проект остановлен и сохранён. Переключите DNS/прокси вручную после проверки.',
      );
    } catch (e) {
      if (stopped) {
        if (targetStarted) {
          try {
            await run(target, `${compose(p)} stop --timeout 60`);
            log('Целевые контейнеры остановлены.');
          } catch {
            log(
              'Не удалось подтвердить остановку цели. Автовозврат отключён, чтобы избежать двух записывающих копий.',
            );
            throw e;
          }
        }
        try {
          await run(
            source,
            `${compose(p)} up -d --no-build --pull never --wait --wait-timeout 120`,
          );
          p.status = 'running';
          store.save('projects', p);
          log(
            'Исходный проект снова запущен. Копия на цели сохранена для проверки.',
          );
        } catch {
          p.status = 'failed';
          store.save('projects', p);
          log('Автовозврат не удался. Требуется проверка исходного сервера.');
        }
      }
      throw e;
    } finally {
      target.end();
    }
  }
  return {
    refresh,
    enqueue(type, { projectId, serverId, target, source = 'Вручную' }) {
      const p = projectId ? store.get('projects', projectId) : null;
      assert(!projectId || p, 'Проект не найден', 404);
      const sid = serverId || p?.serverId;
      assert(store.get('servers', sid), 'Сервер не найден', 404);
      if (type === 'migration') {
        assert(
          target !== sid && store.get('servers', target),
          'Выберите другой сервер',
        );
        assert(
          p.status === 'running',
          'Перенос доступен для работающего проекта',
        );
      }
      assert(
        !store
          .list('jobs')
          .some(
            (j) =>
              ['pending', 'deploying'].includes(j.status) &&
              ((projectId && j.projectId === projectId) ||
                j.serverId === sid ||
                j.target === sid ||
                j.serverId === target),
          ),
        'Для этого сервера уже выполняется операция',
        409,
      );
      const job = {
        id: randomUUID(),
        type,
        projectId,
        serverId: sid,
        target,
        projectName: p?.name || store.get('servers', sid).name,
        status: 'pending',
        createdAt: new Date().toISOString(),
        source,
        logs: ['Операция поставлена в очередь.'],
      };
      store.save('jobs', job);
      queue = queue.then(() => execute(job)).catch(() => {});
      return job;
    },
    async drain() {
      await queue;
    },
  };
}
