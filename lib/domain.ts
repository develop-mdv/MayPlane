export type Status =
  | 'running'
  | 'stopped'
  | 'deploying'
  | 'failed'
  | 'pending'
  | 'success'
  | 'online'
  | 'offline'
  | 'needs_setup';
export type Server = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  status: Status;
  region: string;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  specs: string;
  fingerprint?: string;
  checkedAt?: string;
};
export type Project = {
  id: string;
  name: string;
  repo: string;
  branch: string;
  serverId: string;
  kind: 'web' | 'bot' | 'service';
  status: Status;
  domain: string;
  composeFile: string;
  autoDeploy: boolean;
  updatedAt: string;
  commit: string;
  color: string;
  envKeys: string[];
};
export type Job = {
  id: string;
  projectId?: string;
  serverId?: string;
  projectName: string;
  type: 'deploy' | 'restart' | 'stop' | 'migration' | 'provision';
  status: Status;
  createdAt: string;
  finishedAt?: string;
  source?: string;
  target?: string;
  logs: string[];
};
export type Snapshot = { projects: Project[]; servers: Server[]; jobs: Job[] };
export const statusLabels: Record<Status, string> = {
  running: 'Работает',
  stopped: 'Остановлен',
  deploying: 'Деплой',
  failed: 'Ошибка',
  pending: 'В очереди',
  success: 'Успешно',
  online: 'Доступен',
  offline: 'Недоступен',
  needs_setup: 'Нужна настройка',
};
export const jobLabels = {
  deploy: 'Деплой',
  restart: 'Перезапуск',
  stop: 'Остановка',
  migration: 'Перенос',
  provision: 'Настройка сервера',
};
export const kindLabels = { web: 'Сайт', bot: 'Бот', service: 'Сервис' };
export function relativeDate(value: string) {
  const m = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  return m < 1
    ? 'только что'
    : m < 60
      ? `${m} мин назад`
      : m < 1440
        ? `${Math.floor(m / 60)} ч назад`
        : `${Math.floor(m / 1440)} дн назад`;
}
export function makeDemo(): Snapshot {
  const ago = (n: number) => new Date(Date.now() - n * 60000).toISOString();
  const servers: Server[] = [
    {
      id: 's1',
      name: 'production-01',
      host: '203.0.113.24',
      port: 22,
      username: 'root',
      status: 'online',
      region: 'Frankfurt, DE',
      cpu: 24,
      memory: 46,
      disk: 32,
      specs: '4 vCPU · 8 GB RAM · Ubuntu 24.04',
    },
    {
      id: 's2',
      name: 'production-02',
      host: '203.0.113.86',
      port: 22,
      username: 'root',
      status: 'online',
      region: 'Amsterdam, NL',
      cpu: 12,
      memory: 31,
      disk: 18,
      specs: '2 vCPU · 4 GB RAM · Ubuntu 24.04',
    },
    {
      id: 's3',
      name: 'staging',
      host: '198.51.100.12',
      port: 22,
      username: 'root',
      status: 'online',
      region: 'Helsinki, FI',
      cpu: 7,
      memory: 22,
      disk: 14,
      specs: '2 vCPU · 4 GB RAM · Ubuntu 24.04',
    },
  ];
  const projects: Project[] = [
    {
      id: 'p1',
      name: 'storefront',
      repo: 'https://github.com/example/storefront',
      branch: 'main',
      serverId: 's1',
      kind: 'web',
      status: 'running',
      domain: 'store.example.com',
      composeFile: 'compose.yaml',
      autoDeploy: true,
      updatedAt: ago(12),
      commit: 'a8f42e1',
      color: 'mint',
      envKeys: ['DATABASE_URL', 'NODE_ENV', 'PORT'],
    },
    {
      id: 'p2',
      name: 'notify-bot',
      repo: 'https://github.com/example/notify-bot',
      branch: 'main',
      serverId: 's2',
      kind: 'bot',
      status: 'running',
      domain: 'Telegram bot',
      composeFile: 'compose.yaml',
      autoDeploy: true,
      updatedAt: ago(48),
      commit: 'c71db09',
      color: 'blue',
      envKeys: ['BOT_TOKEN', 'REDIS_URL'],
    },
    {
      id: 'p3',
      name: 'backend-api',
      repo: 'https://github.com/example/backend-api',
      branch: 'main',
      serverId: 's1',
      kind: 'service',
      status: 'running',
      domain: 'api.example.com',
      composeFile: 'compose.yaml',
      autoDeploy: true,
      updatedAt: ago(125),
      commit: '9de6b3a',
      color: 'purple',
      envKeys: ['DATABASE_URL', 'JWT_SECRET'],
    },
    {
      id: 'p4',
      name: 'personal-website',
      repo: 'https://github.com/example/personal-website',
      branch: 'main',
      serverId: 's2',
      kind: 'web',
      status: 'running',
      domain: 'hello.example.com',
      composeFile: 'compose.yaml',
      autoDeploy: false,
      updatedAt: ago(210),
      commit: '5f2a801',
      color: 'orange',
      envKeys: ['NODE_ENV'],
    },
    {
      id: 'p5',
      name: 'analytics-worker',
      repo: 'https://github.com/example/analytics-worker',
      branch: 'develop',
      serverId: 's3',
      kind: 'service',
      status: 'stopped',
      domain: 'Фоновый процесс',
      composeFile: 'compose.yaml',
      autoDeploy: false,
      updatedAt: ago(960),
      commit: '2c8e731',
      color: 'pink',
      envKeys: ['QUEUE_URL'],
    },
    {
      id: 'p6',
      name: 'support-bot',
      repo: 'https://github.com/example/support-bot',
      branch: 'main',
      serverId: 's2',
      kind: 'bot',
      status: 'running',
      domain: 'Telegram bot',
      composeFile: 'compose.yaml',
      autoDeploy: true,
      updatedAt: ago(1300),
      commit: 'b134e7c',
      color: 'cyan',
      envKeys: ['BOT_TOKEN'],
    },
  ];
  const jobs: Job[] = projects.map((p, i) => ({
    id: `j${i}`,
    projectId: p.id,
    projectName: p.name,
    type: 'deploy',
    status: i === 4 ? 'failed' : 'success',
    createdAt: p.updatedAt,
    finishedAt: p.updatedAt,
    logs:
      i === 4
        ? [
            '[demo] Получен push в develop',
            '[demo] Сборка образа',
            '[demo] ERROR: переменная QUEUE_URL не определена',
          ]
        : [
            '[demo] Получен push в main',
            '[demo] SSH-соединение установлено',
            '[demo] Репозиторий обновлён',
            '[demo] Docker Compose: образ собран',
            '[demo] Контейнер запущен. Проверка состояния пройдена.',
          ],
    source: i % 2 === 0 ? 'Git push' : 'Вручную',
  }));
  return { servers, projects, jobs };
}
