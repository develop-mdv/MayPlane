import {
  normalizeEnvDefinitions,
  inferEnvDefinitions,
} from '../lib/env-requirements.mjs';
import { posix } from 'node:path';
import { assert } from './security.mjs';
const join = (a, b) => posix.join(a || '.', b).replace(/^\.\//, '');
export function safePath(value, { dot = false } = {}) {
  assert(
    typeof value === 'string' &&
      ((dot && value === '.') ||
        /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/.test(value)) &&
      !value.split('/').some((p) => p === '..' || p === '') &&
      !value.startsWith('/'),
    'Недопустимый путь в плане',
  );
  return value;
}
const dirsOf = (paths, name) =>
  paths.filter((p) => posix.basename(p) === name).map((p) => posix.dirname(p));
export function detectRecipe(context, project) {
  const compose = context.paths.filter((p) =>
    /(^|\/)(?:docker-)?compose[^/]*\.ya?ml$/.test(p),
  );
  const recipe = {
    runtime: 'manual',
    workdir: '.',
    summary: 'Нужна конфигурация запуска',
    notes: [],
    blockers: [],
    env: inferEnvDefinitions(
      context.files,
      context.envNames,
      compose.includes(project.composeFile)
        ? project.composeFile
        : compose.length === 1
          ? compose[0]
          : '',
    ),
  };
  if (compose.includes(project.composeFile) || compose.length === 1)
    return {
      ...recipe,
      runtime: 'compose',
      composeFile: compose.includes(project.composeFile)
        ? project.composeFile
        : compose[0],
      summary: 'В репозитории найдена готовая конфигурация Docker Compose',
    };
  const node = dirsOf(context.paths, 'package.json');
  if (node.length === 1) {
    const workdir = node[0];
    let pkg;
    try {
      pkg = JSON.parse(context.files[join(workdir, 'package.json')] || '{}');
    } catch {
      return recipe;
    }
    const scripts = pkg.scripts || {};
    const staticSite = !!(
      pkg.dependencies?.vite ||
      pkg.devDependencies?.vite ||
      pkg.dependencies?.['react-scripts']
    );
    if (staticSite && scripts.build)
      return {
        ...recipe,
        runtime: 'node-static',
        workdir,
        buildScript: 'build',
        distDir: pkg.dependencies?.['react-scripts'] ? 'build' : 'dist',
        appPort: 80,
        summary: 'Сборка статического сайта и запуск в Nginx',
      };
    if (scripts.start)
      return {
        ...recipe,
        runtime: 'node',
        workdir,
        buildScript: scripts.build ? 'build' : '',
        startScript: 'start',
        appPort: 3000,
        summary: 'Node.js: установка зависимостей, сборка и запуск start',
      };
  }
  const docker = dirsOf(context.paths, 'Dockerfile');
  if (docker.length === 1) {
    const file = context.files[join(docker[0], 'Dockerfile')] || '';
    const port = file.match(/^EXPOSE\s+(\d+)/m)?.[1];
    return {
      ...recipe,
      runtime: 'dockerfile',
      workdir: docker[0],
      appPort: port ? Number(port) : project.kind === 'web' ? 3000 : 0,
      summary: 'Сборка существующего Dockerfile',
      notes: port
        ? []
        : ['Проверьте порт приложения: в Dockerfile нет EXPOSE.'],
    };
  }
  const python = dirsOf(context.paths, 'requirements.txt');
  if (python.length === 1) {
    const workdir = python[0];
    const entry = ['app/main.py', 'main.py', 'bot.py', 'app.py'].find((p) =>
      context.paths.includes(join(workdir, p)),
    );
    if (entry)
      return {
        ...recipe,
        runtime: 'python',
        workdir,
        entry: entry.replace(/\.py$/, '').replaceAll('/', '.'),
        pythonMode: 'module',
        appPort: project.kind === 'web' ? 8000 : 0,
        summary: 'Python: установка requirements.txt и запуск модуля',
      };
  }
  const html = dirsOf(context.paths, 'index.html');
  if (html.length === 1)
    return {
      ...recipe,
      runtime: 'static',
      workdir: html[0],
      distDir: '.',
      appPort: 80,
      summary: 'Статический сайт в Nginx',
    };
  recipe.blockers = [
    'Не удалось однозначно определить запуск. Подключите LLM или добавьте Dockerfile / Compose.',
  ];
  return recipe;
}
export function compileRecipe(input, context, project) {
  assert(input && typeof input === 'object', 'Модель вернула пустой план');
  const allowed = [
    'compose',
    'dockerfile',
    'node',
    'node-static',
    'python',
    'static',
    'go',
    'manual',
  ];
  assert(
    allowed.includes(input.runtime),
    'Неизвестный способ запуска в ответе модели',
  );
  const workdir = safePath(input.workdir || '.', { dot: true });
  assert(
    workdir === '.' || context.paths.some((p) => p.startsWith(workdir + '/')),
    'Рабочая папка отсутствует в репозитории',
  );
  const notes = (Array.isArray(input.notes) ? input.notes : [])
    .filter((x) => typeof x === 'string')
    .slice(0, 12)
    .map((x) => x.slice(0, 1200));
  const blockers = (Array.isArray(input.blockers) ? input.blockers : [])
    .filter((x) => typeof x === 'string')
    .slice(0, 10)
    .map((x) => x.slice(0, 1200));
  const env = normalizeEnvDefinitions(input.env || []);
  const result = {
    runtime: input.runtime,
    workdir,
    summary: String(input.summary || 'План развёртывания').slice(0, 1500),
    notes,
    blockers,
    env,
    files: {},
    composeFile: '',
    appPort: 0,
    webService: 'app',
  };
  if (input.runtime === 'manual') {
    if (!blockers.length)
      blockers.push('Опишите команду запуска или добавьте Dockerfile.');
    return result;
  }
  if (input.runtime === 'compose') {
    const path = safePath(input.composeFile);
    assert(
      context.paths.includes(path) && /\.ya?ml$/.test(path),
      'Compose-файл не найден',
    );
    result.composeFile = path;
    result.workdir = posix.dirname(path);
    return result;
  }
  const appPort =
    project.kind === 'web'
      ? Number(
          input.runtime === 'static' || input.runtime === 'node-static'
            ? 80
            : input.appPort || 3000,
        )
      : Number(input.appPort || 0);
  assert(
    Number.isInteger(appPort) && appPort >= 0 && appPort <= 65535,
    'Некорректный порт приложения',
  );
  result.appPort = appPort;
  let dockerfile = '';
  const publicKeys = env
    .map((e) => e.name)
    .filter((n) => /^(?:VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]+$/.test(n));
  if (input.runtime === 'node' || input.runtime === 'node-static') {
    let pkg;
    try {
      pkg = JSON.parse(context.files[join(workdir, 'package.json')]);
    } catch {
      assert(
        false,
        'package.json не прочитан: добавьте доступный манифест до 24 КБ',
      );
    }
    const scripts = pkg.scripts || {};
    const build = String(input.buildScript || '');
    const start = String(input.startScript || 'start');
    for (const script of [
      build,
      ...(input.runtime === 'node' ? [start] : []),
    ].filter(Boolean))
      assert(
        /^[A-Za-z0-9:_-]{1,80}$/.test(script) &&
          typeof scripts[script] === 'string',
        'Сценарий отсутствует в package.json: ' + script,
      );
    let manager = 'npm',
      install = context.paths.includes(join(workdir, 'package-lock.json'))
        ? 'npm ci'
        : 'npm install',
      prepare = '';
    if (context.paths.includes(join(workdir, 'pnpm-lock.yaml'))) {
      manager = 'pnpm';
      const version =
        String(pkg.packageManager || '').match(
          /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)/,
        )?.[1] || '10';
      prepare = `RUN npm install -g pnpm@${version}\n`;
      install = 'pnpm install --frozen-lockfile';
    } else if (context.paths.includes(join(workdir, 'yarn.lock'))) {
      manager = 'yarn';
      const version =
        String(pkg.packageManager || '').match(
          /^yarn@([0-9]+\.[0-9]+\.[0-9]+)/,
        )?.[1] || '1';
      prepare = `RUN npm install -g ${version.startsWith('1') ? 'yarn' : '@yarnpkg/cli-dist'}@${version}\n`;
      install = version.startsWith('1')
        ? 'yarn install --frozen-lockfile'
        : 'yarn install --immutable';
    }
    dockerfile = `FROM node:24-bookworm-slim AS build\nWORKDIR /app\n${prepare}COPY . .\n${publicKeys.map((n) => 'ARG ' + n + '\nENV ' + n + '=$' + n + '\n').join('')}RUN ${install}\n${build ? `RUN ${manager} run ${build}\n` : ''}`;
    if (input.runtime === 'node')
      dockerfile += `ENV NODE_ENV=production HOST=0.0.0.0 HOSTNAME=0.0.0.0\nCMD ${JSON.stringify([manager, 'run', start])}\n`;
    else {
      assert(build, 'Для сборки сайта нужен build script');
      const dist = safePath(input.distDir || 'dist', { dot: true });
      dockerfile += `FROM nginx:stable-alpine\nCOPY --from=build /app/${dist}/ /usr/share/nginx/html/\nCOPY mayplane.nginx.conf /etc/nginx/conf.d/default.conf\n`;
    }
  } else if (input.runtime === 'python') {
    assert(
      context.paths.includes(join(workdir, 'requirements.txt')),
      'Python-рецепт требует requirements.txt; используйте Dockerfile для другого менеджера зависимостей',
    );
    const mode = input.pythonMode || 'module';
    let cmd;
    const entry = String(input.entry || '');
    if (mode === 'file') {
      safePath(entry);
      assert(
        context.paths.includes(join(workdir, entry)) && entry.endsWith('.py'),
        'Python-файл не найден',
      );
      cmd = ['python', entry];
    } else {
      assert(
        /^[A-Za-z_][A-Za-z0-9_.]*(?::[A-Za-z_][A-Za-z0-9_]*)?$/.test(entry),
        'Некорректный Python entrypoint',
      );
      const modulePath = entry.split(':')[0].replaceAll('.', '/');
      assert(
        context.paths.includes(join(workdir, modulePath + '.py')) ||
          context.paths.includes(join(workdir, module + '/__main__.py')),
        'Python-модуль отсутствует в репозитории',
      );
      if (mode === 'module') {
        assert(!entry.includes(':'), 'python -m требует имя модуля');
        cmd = ['python', '-m', entry];
      } else if (mode === 'uvicorn')
        cmd = [
          'python',
          '-m',
          'uvicorn',
          entry,
          '--host',
          '0.0.0.0',
          '--port',
          String(appPort),
        ];
      else if (mode === 'gunicorn')
        cmd = ['gunicorn', entry, '--bind', '0.0.0.0:' + appPort];
      else assert(false, 'Неподдерживаемый режим Python');
    }
    dockerfile = `FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nENV PYTHONUNBUFFERED=1\nCMD ${JSON.stringify(cmd)}\n`;
  } else if (input.runtime === 'static') {
    const assets = context.paths
      .filter((path) => workdir === '.' || path.startsWith(workdir + '/'))
      .map((path) => posix.relative(workdir, path))
      .filter(
        (path) =>
          /\.(?:html?|css|m?js|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|webmanifest|mp4|webm)$/.test(
            path,
          ) || path === 'robots.txt',
      );
    assert(
      assets.includes('index.html') && assets.length <= 500,
      'Для статического сайта нужен index.html и до 500 файлов в выбранной папке',
    );
    dockerfile =
      'FROM nginx:stable-alpine\n' +
      assets
        .map(
          (path) =>
            'COPY ' + JSON.stringify([path, '/usr/share/nginx/html/' + path]),
        )
        .join('\n') +
      '\nCOPY mayplane.nginx.conf /etc/nginx/conf.d/default.conf\n';
  } else if (input.runtime === 'go') {
    assert(context.paths.includes(join(workdir, 'go.mod')), 'go.mod не найден');
    const go =
      context.files[join(workdir, 'go.mod')]?.match(/^go\s+(\d+\.\d+)/m)?.[1] ||
      '1.26';
    dockerfile = `FROM golang:${go}-bookworm AS build\nWORKDIR /src\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /app .\nFROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*\nCOPY --from=build /app /app\nENTRYPOINT ["/app"]\n`;
  } else
    assert(
      context.paths.includes(join(workdir, 'Dockerfile')),
      'Dockerfile отсутствует',
    );
  result.composeFile = join(workdir, 'mayplane.compose.yaml');
  const service = {
    build: {
      context: '.',
      dockerfile: dockerfile ? 'mayplane.Dockerfile' : 'Dockerfile',
      ...(publicKeys.length
        ? {
            args: Object.fromEntries(
              publicKeys.map((n) => [n, '${' + n + '}']),
            ),
          }
        : {}),
    },
    restart: 'unless-stopped',
    env_file: ['.env'],
    volumes: ['app-data:/app/data'],
    ...(project.kind === 'web'
      ? {
          environment: {
            PORT: String(appPort),
            HOST: '0.0.0.0',
            HOSTNAME: '0.0.0.0',
          },
          ports: [`\${MAYPLANE_HTTP_PORT}:${appPort}`],
        }
      : {}),
  };
  result.files[result.composeFile] =
    JSON.stringify(
      { services: { app: service }, volumes: { 'app-data': {} } },
      null,
      2,
    ) + '\n';
  if (dockerfile)
    result.files[join(workdir, 'mayplane.Dockerfile')] = dockerfile;
  if (['static', 'node-static'].includes(input.runtime))
    result.files[join(workdir, 'mayplane.nginx.conf')] =
      'server { listen 80; server_name _; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }\n';
  for (const file of Object.keys(result.files))
    assert(
      !context.paths.includes(file),
      'Файл ' +
        file +
        ' уже есть в Git. Укажите существующий Compose вместо генерации.',
    );
  notes.push(
    'Данные в /app/data сохраняются в отдельном Docker volume. Для других каталогов настройте тома в Compose.',
  );
  return result;
}
