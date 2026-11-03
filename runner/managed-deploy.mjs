import { lookup } from 'node:dns/promises';
import { q, assert, envEntries, validateMigrationConfig } from './security.mjs';
import { rootOf, workspaceOf } from './ssh.mjs';
export function domainName(value) {
  if (!value) return '';
  let input = String(value).trim();
  try {
    if (input.includes('://')) {
      const url = new URL(input);
      if (
        url.pathname !== '/' ||
        url.port ||
        url.search ||
        url.hash ||
        url.username
      )
        return '';
      input = url.hostname;
    }
  } catch {
    return '';
  }
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
    input,
  )
    ? input.toLowerCase()
    : '';
}
export async function prepareGeneratedFiles(
  client,
  p,
  { store, run, put, log },
) {
  const files = p.secret.generatedFiles || {};
  if (!Object.keys(files).length) return;
  if (p.kind === 'web' && p.assistant?.appPort) {
    const listeners = await run(client, "ss -H -ltn | awk '{print $4}'", {
      timeout: 10000,
    });
    const used = new Set(
      [...listeners.matchAll(/:(\d+)\s*$/gm)].map((m) => Number(m[1])),
    );
    for (const other of store.list('projects'))
      if (other.serverId === p.serverId && other.id !== p.id && other.httpPort)
        used.add(other.httpPort);
    let port = Object.keys(p.secret.generatedFiles || {}).length
      ? p.httpPort
      : null;
    if (!port) {
      for (port = 18080; port < 18180 && used.has(port); port++);
      assert(port < 18180, 'Не найден свободный порт в диапазоне 18080–18179');
    }
    p.httpPort = port;
    p.secret.env =
      p.secret.env
        .split(/\r?\n/)
        .filter((l) => !/^\s*(?:export\s+)?EZDEPLOY_HTTP_PORT\s*=/.test(l))
        .join('\n')
        .replace(/\n*$/, '\n') + `EZDEPLOY_HTTP_PORT=${port}\n`;
    p.envKeys = envEntries(p.secret.env).map((e) => e[0]);
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = rootOf(p) + '/repo/' + relative;
    await run(
      client,
      `test ! -L ${q(target)}; if git -C ${q(rootOf(p) + '/repo')} ls-files --error-unmatch ${q(relative)} >/dev/null 2>&1; then echo 'Создаваемый файл уже отслеживается Git'; exit 1; fi`,
    );
    await put(client, target, content);
  }
  const ignore = workspaceOf(p) + '/.dockerignore';
  await run(
    client,
    `test ! -L ${q(ignore)}; printf '\\n.env\\n.env.*\\n.git\\n' >> ${q(ignore)}`,
  );
  store.save('projects', p);
  log(
    'Конфигурация создана рядом с проектом; .env исключён из Docker build context.',
  );
}
export async function validateAutomaticCompose(client, p, { run, compose }) {
  const config = JSON.parse(
    await run(client, `${compose(p)} config --format json`),
  );
  validateMigrationConfig(config, rootOf(p));
  for (const network of Object.values(config.networks || {}))
    assert(
      !network.driver || network.driver === 'bridge',
      'Автоматический запуск разрешает только изолированные bridge-сети',
    );
  for (const s of Object.values(config.services || {})) {
    assert(
      !s.privileged &&
        !s.network_mode &&
        !s.pid &&
        !s.ipc &&
        !s.devices &&
        !s.cap_add &&
        !s.security_opt &&
        !s.volumes_from &&
        !s.use_api_socket,
      'Compose требует расширенного доступа к хосту. Нужна ручная проверка конфигурации.',
    );
    for (const mount of s.volumes || [])
      if (mount.type === 'bind') {
        const actual = (
          await run(client, `realpath -m ${q(mount.source)}`)
        ).trim();
        assert(
          actual.startsWith(rootOf(p) + '/'),
          'Том выходит за пределы каталога проекта',
        );
      }
    if (s.build) {
      assert(
        !s.build.ssh &&
          !s.build.secrets &&
          !s.build.additional_contexts &&
          !s.build.privileged &&
          (!s.build.network || s.build.network === 'default'),
        'Сборка требует неподдерживаемых доступов',
      );
      const actual = (
        await run(client, `realpath ${q(s.build.context)}`)
      ).trim();
      assert(
        actual === rootOf(p) + '/repo' ||
          actual.startsWith(rootOf(p) + '/repo/'),
        'Build context находится за пределами репозитория',
      );
      assert(
        !s.build.dockerfile_inline,
        'Встроенный Dockerfile требует ручного развёртывания',
      );
      const dockerfile = s.build.dockerfile || 'Dockerfile';
      assert(
        !dockerfile.startsWith('/') && !dockerfile.split('/').includes('..'),
        'Dockerfile находится вне build context',
      );
    }
  }
  return config;
}
export async function publishEndpoint(
  client,
  p,
  { store, run, put, compose, log, dns = lookup },
) {
  if (p.kind !== 'web') return;
  p.deploymentChecks = {
    checkedAt: new Date().toISOString(),
    steps: [],
    httpStatus: null,
  };
  const steps = p.deploymentChecks.steps;
  const server = store.get('servers', p.serverId);
  let port = p.httpPort;
  if (!port) {
    const config = JSON.parse(
      await run(client, `${compose(p)} config --format json`),
    );
    const ports = Object.values(config.services || {})
      .flatMap((s) =>
        (s.ports || [])
          .filter((v) => v.protocol !== 'udp')
          .map((v) => Number(v.published)),
      )
      .filter(Boolean);
    if (ports.length === 1) port = ports[0];
  }
  if (!port) {
    steps.push('Укажите опубликованный HTTP-порт приложения в Compose.');
    return;
  }
  p.httpPort = port;
  p.publicUrl = `http://${server.host.includes(':') ? '[' + server.host + ']' : server.host}:${port}`;
  try {
    const probe = `exec 3<>/dev/tcp/127.0.0.1/${port}; printf 'GET / HTTP/1.0\\r\\nHost: ${domainName(p.domain) || 'localhost'}\\r\\n\\r\\n' >&3; IFS= read -r status <&3; printf '%s\\n' "$status"`;
    const output = await run(client, `timeout 12 bash -c ${q(probe)}`, {
      timeout: 15000,
    });
    p.deploymentChecks.httpStatus =
      Number(output.match(/HTTP\/\S+\s+(\d+)/)?.[1]) || null;
    if (!p.deploymentChecks.httpStatus || p.deploymentChecks.httpStatus >= 500)
      steps.push(
        'Контейнер запущен, но HTTP-проверка не прошла. Откройте логи приложения.',
      );
    else log('HTTP приложения: ' + p.deploymentChecks.httpStatus);
  } catch {
    steps.push(
      'Не удалось получить HTTP-ответ. Проверьте порт и адрес прослушивания приложения (0.0.0.0).',
    );
  }
  const domain = domainName(p.domain);
  if (!domain) {
    if (p.domain)
      steps.push('Для HTTPS укажите домен без пути, например app.example.com.');
    else
      steps.push(
        'Сайт доступен по IP и порту. Для HTTPS задайте домен проекта.',
      );
    return;
  }
  let addresses = [];
  try {
    addresses = await Promise.race([
      dns(domain, { all: true }),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve([]), 5000);
        timer.unref?.();
      }),
    ]);
  } catch {}
  if (!addresses.length || addresses.some((a) => a.address !== server.host)) {
    steps.push(
      `Укажите DNS A/AAAA для ${domain} на ${server.host}; удалите записи на другие серверы. Затем повторите настройку домена.`,
    );
    return;
  }
  try {
    const managed =
      (
        await run(
          client,
          'docker inspect --format \'{{index .Config.Labels "ezdeploy.managed-proxy"}}\' ezdeploy-proxy 2>/dev/null || true',
          { timeout: 10000 },
        )
      ).trim() === 'true';
    if (!managed) {
      const ports = await run(client, "ss -H -ltn | awk '{print $4}'", {
        timeout: 10000,
      });
      if (/:(?:80|443)\s*$/m.test(ports)) {
        steps.push(
          `Порты 80/443 заняты. В существующем reverse proxy направьте ${domain} на http://127.0.0.1:${port}. Настройки действующего прокси сохранены.`,
        );
        return;
      }
    }
    const other = store
      .list('projects')
      .filter(
        (x) =>
          x.id !== p.id &&
          x.serverId === p.serverId &&
          x.managedDomain &&
          x.httpPort,
      );
    assert(
      !other.some((x) => x.managedDomain === domain),
      'Этот домен уже используется другим проектом',
    );
    const routes = [
      ...other.map((x) => ({
        domain: domainName(x.managedDomain),
        port: x.httpPort,
      })),
      { domain, port },
    ];
    const config =
      routes
        .filter((r) => r.domain && Number.isInteger(r.port))
        .map((r) => `${r.domain} {\n reverse_proxy 127.0.0.1:${r.port}\n}`)
        .join('\n\n') + '\n';
    const root = '/opt/ezdeploy-proxy';
    await run(
      client,
      `test ! -e ${q(root)} || test -f ${q(root + '/.managed-by-ezdeploy')}; install -d -m 700 ${q(root)}; test ! -L ${q(root + '/Caddyfile.next')}`,
    );
    await put(client, root + '/.managed-by-ezdeploy', 'ezdeploy\n');
    await put(client, root + '/Caddyfile.next', config);
    await run(
      client,
      `docker run --rm -v ${q(root + ':/etc/caddy:ro')} caddy:2 caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile`,
      { timeout: 180000 },
    );
    if (managed)
      await run(
        client,
        `cp -p ${q(root + '/Caddyfile')} ${q(root + '/Caddyfile.previous')}`,
      );
    await run(
      client,
      `mv ${q(root + '/Caddyfile.next')} ${q(root + '/Caddyfile')}`,
    );
    if (managed) {
      try {
        await run(
          client,
          'docker exec ezdeploy-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile',
          { timeout: 30000 },
        );
      } catch (e) {
        await run(
          client,
          `mv ${q(root + '/Caddyfile.previous')} ${q(root + '/Caddyfile')}; docker exec ezdeploy-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
          { timeout: 30000 },
        );
        throw e;
      }
    } else
      await run(
        client,
        `docker run -d --name ezdeploy-proxy --label ezdeploy.managed-proxy=true --restart unless-stopped --network host -v ${q(root + ':/etc/caddy:ro')} -v ezdeploy-caddy-data:/data -v ezdeploy-caddy-config:/config caddy:2`,
        { timeout: 180000 },
      );
    p.managedDomain = domain;
    p.publicUrl = 'https://' + domain;
    steps.push(
      'HTTPS-прокси настроен. Выпуск сертификата требует доступных снаружи портов 80/443; проверьте домен после завершения выдачи.',
    );
    log('Домен подключён к управляемому Caddy: ' + domain);
  } catch {
    steps.push(
      `Автоматическая настройка HTTPS не завершена. Приложение доступно на порту ${port}; проверьте прокси и DNS.`,
    );
  }
}

export async function removeManagedEndpoint(
  client,
  p,
  { store, run, put, log },
) {
  if (!p.managedDomain) return;
  const root = '/opt/ezdeploy-proxy';
  const managed =
    (
      await run(
        client,
        'docker inspect --format \'{{index .Config.Labels "ezdeploy.managed-proxy"}}\' ezdeploy-proxy 2>/dev/null || true',
      )
    ).trim() === 'true';
  assert(
    managed,
    'Не удалось подтвердить принадлежность прокси. Проверьте маршрут домена перед удалением.',
  );
  const others = store
    .list('projects')
    .filter(
      (x) =>
        x.id !== p.id &&
        x.serverId === p.serverId &&
        x.managedDomain &&
        x.httpPort &&
        !x.removedAt,
    );
  const config =
    others
      .map((x) => {
        const domain = domainName(x.managedDomain);
        assert(
          domain &&
            Number.isInteger(x.httpPort) &&
            x.httpPort > 0 &&
            x.httpPort < 65536,
          'Некорректный маршрут соседнего проекта',
        );
        return `${domain} {\n reverse_proxy 127.0.0.1:${x.httpPort}\n}`;
      })
      .join('\n\n') || '{\n admin localhost:2019\n}\n';
  await run(
    client,
    `test -f ${q(root + '/.managed-by-ezdeploy')}; test ! -L ${q(root + '/Caddyfile.next')}; test ! -L ${q(root + '/Caddyfile.previous')}`,
  );
  await put(client, root + '/Caddyfile.next', config);
  await run(
    client,
    `docker run --rm -v ${q(root + ':/etc/caddy:ro')} caddy:2 caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile`,
    { timeout: 180000 },
  );
  await run(
    client,
    `cp -p ${q(root + '/Caddyfile')} ${q(root + '/Caddyfile.previous')}; mv ${q(root + '/Caddyfile.next')} ${q(root + '/Caddyfile')}`,
  );
  try {
    await run(
      client,
      'docker exec ezdeploy-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile',
      { timeout: 30000 },
    );
  } catch (error) {
    await run(
      client,
      `mv ${q(root + '/Caddyfile.previous')} ${q(root + '/Caddyfile')}; docker exec ezdeploy-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
      { timeout: 30000 },
    );
    throw error;
  }
  const fresh = store.get('projects', p.id);
  delete fresh.managedDomain;
  delete fresh.publicUrl;
  store.save('projects', fresh);
  log(
    'Маршрут проекта удалён из управляемого прокси. Другие маршруты сохранены.',
  );
}
