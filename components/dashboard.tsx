'use client';
import { MigrationQueue } from './migration-progress';
import { jobStatus } from '@/lib/job-actions.mjs';
import { useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDownUp,
  ArrowUpRight,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  FolderGit2,
  GitBranch,
  LayoutDashboard,
  Plus,
  Search,
  Server as ServerIcon,
  Settings2,
  Terminal,
  MessageSquare,
  Zap,
  Globe,
  Bot,
  Layers,
  RefreshCw,
  Unplug,
  AlertCircle,
} from 'lucide-react';
import {
  Sidebar,
  SidebarProvider,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { useWorkspace } from '@/lib/use-workspace';
import {
  kindLabels,
  relativeDate,
  statusLabels,
  jobLabels,
  type Status,
  type Project,
  type Job,
  type Server,
} from '@/lib/domain';
import {
  WorkspaceDialogs,
  ProjectDetail,
  LogViewer,
  EditServer,
} from './workspace-flows';
import { ServerChat } from './operations-chat';
import { ServerConsole } from './server-console';
import { GitConnections } from './git-connections';
import { LlmSettings } from './llm-settings';
const navigation = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'projects', label: 'Проекты', icon: FolderGit2 },
  { id: 'servers', label: 'Серверы', icon: ServerIcon },
  { id: 'deployments', label: 'Деплои', icon: Layers },
  { id: 'migrations', label: 'Перенос проектов', icon: ArrowDownUp },
  { id: 'logs', label: 'Логи', icon: Terminal },
];
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`status status-${status}`}>
      <span />
      {statusLabels[status]}
    </span>
  );
}
export function JobStatusBadge({ job }: { job: Job }) {
  return (
    <span className={`status status-${job.status}`}>
      <span />
      {jobStatus(job).label}
    </span>
  );
}
export default function Dashboard() {
  const ws = useWorkspace();
  const { data, connection } = ws;
  const [view, setView] = useState('overview');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState('');
  const [migrationProjectId, setMigrationProjectId] = useState<string>();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectTab, setProjectTab] = useState<'overview' | 'chat'>();
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [confirmServer, setConfirmServer] = useState<Server | null>(null);
  const [consoleServer, setConsoleServer] = useState<Server | null>(null);
  const [chatServerId, setChatServerId] = useState<string | null>(null);
  const [editServerId, setEditServerId] = useState<string | null>(null);
  const selectedProject = data.projects.find((p) => p.id === projectId);
  const visible = data.projects.filter(
    (p) =>
      (filter === 'all' || p.kind === filter) &&
      (p.name + ' ' + p.domain).toLowerCase().includes(search.toLowerCase()),
  );
  const online = data.servers.filter((s) => s.status === 'online').length;
  const running = data.projects.filter((p) => p.status === 'running').length;
  const deploys = data.jobs.filter((j) => j.type === 'deploy');
  const success = deploys.filter((j) => j.status === 'success').length;
  const complete = deploys.filter((j) =>
    ['success', 'failed'].includes(j.status),
  ).length;
  const title =
    view === 'overview'
      ? 'Всё под контролем'
      : navigation.find((n) => n.id === view)?.label ||
        (
          { settings: 'Настройки', help: 'Как начать' } as Record<
            string,
            string
          >
        )[view];
  const go = (next: string) => {
    setView(next);
    setNotice('');
  };
  const openProject = (project: Project, tab?: 'overview' | 'chat') => {
    setProjectTab(tab);
    setProjectId(project.id);
  };
  const showJob = (job: Job) => {
    setSelectedJob(job.id);
    setProjectId(null);
    go('logs');
  };
  async function refreshServer(s: Server) {
    try {
      await ws.action(`/servers/${s.id}/refresh`);
      setNotice(`Метрики ${s.name} обновлены`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  const projectCards = (
    <>
      <div className="project-toolbar">
        <Tabs value={filter} onValueChange={(v) => setFilter(String(v))}>
          <TabsList variant="line">
            <TabsTrigger value="all">Все проекты</TabsTrigger>
            <TabsTrigger value="web">Сайты</TabsTrigger>
            <TabsTrigger value="bot">Боты</TabsTrigger>
            <TabsTrigger value="service">Сервисы</TabsTrigger>
          </TabsList>
        </Tabs>
        <label className="search-box">
          <Search size={16} />
          <input
            aria-label="Поиск проектов"
            placeholder="Найти проект…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {visible.length ? (
        <div className="project-grid">
          {visible.map((p) => (
            <ProjectCard
              key={p.id}
              p={p}
              server={
                data.servers.find((s) => s.id === p.serverId)?.name || '—'
              }
              onClick={() => openProject(p)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            data.projects.length
              ? 'Ничего не найдено'
              : 'Здесь будут ваши проекты'
          }
          description={
            data.projects.length
              ? 'Попробуйте другое имя или тип проекта.'
              : 'Подключите сервер и добавьте первый Git-репозиторий.'
          }
          action={
            !data.projects.length ? (
              <Button onClick={() => setModal('project')}>
                Добавить проект
              </Button>
            ) : undefined
          }
        />
      )}
    </>
  );
  return (
    <SidebarProvider
      style={{ '--sidebar-width': '240px' } as React.CSSProperties}
    >
      <Sidebar className="app-sidebar">
        <SidebarHeader>
          <Link className="brand" href="/">
            <span className="brand-mark">
              <Terminal size={22} />
            </span>
            MayPlane<span className="brand-dot">.</span>
          </Link>
          <div className="workspace">
            <div className="workspace-icon">D</div>
            <div>
              <strong>Моё пространство</strong>
              <small>Личный аккаунт</small>
            </div>
            <ChevronRight size={15} />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <span className="nav-label">УПРАВЛЕНИЕ</span>
          <SidebarMenu>
            {navigation.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  isActive={view === item.id}
                  onClick={() => go(item.id)}
                >
                  <item.icon />
                  <span>{item.label}</span>
                  {item.id === 'projects' && (
                    <span className="nav-count">{data.projects.length}</span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <div className="sidebar-bottom">
            <div className="connection-light">
              <span />
              {online === data.servers.length && online > 0
                ? 'Все серверы на связи'
                : `${online} из ${data.servers.length} на связи`}
            </div>
            <span className="muted">
              {connection ? 'Подключён исполнитель' : 'Нет подключения'}
            </span>
          </div>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenuButton
            isActive={view === 'settings'}
            onClick={() => go('settings')}
          >
            <Settings2 />
            <span>Настройки</span>
          </SidebarMenuButton>
          <SidebarMenuButton
            isActive={view === 'help'}
            onClick={() => go('help')}
          >
            <CircleHelp />
            <span>Документация</span>
            <ArrowUpRight className="push-right" />
          </SidebarMenuButton>
          <div className="account">
            <div className="avatar">D</div>
            <div>
              <strong>Моё пространство</strong>
              <small>Владелец</small>
            </div>
            <span className="version">v0.1</span>
          </div>
        </SidebarFooter>
      </Sidebar>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <SidebarTrigger className="mobile-trigger" />
            <span>Рабочее пространство</span>
            <ChevronRight size={14} />
            <strong>{view === 'overview' ? 'Обзор' : title}</strong>
          </div>
          <div className="topbar-right">
            <button
              className={`demo-tag ${connection ? 'connected-tag' : ''}`}
              onClick={() => setModal('connect')}
            >
              {connection
                ? 'Серверная часть подключена'
                : ws.initializing
                  ? 'Подключаемся…'
                  : 'Нет подключения'}
              <span className="tag-action">
                {connection ? <Check size={12} /> : <ArrowUpRight size={12} />}
              </span>
            </button>
            <div className="avatar small">D</div>
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</div>
              <h1>{title}</h1>
              <p>
                {
                  (
                    {
                      overview:
                        'Проекты, серверы и деплои в одном пространстве.',
                      projects: 'От репозитория до работающего проекта.',
                      servers: 'Ресурсы и состояние вашей инфраструктуры.',
                      deployments: 'Каждый запуск и его результат.',
                      migrations: 'Новый сервер. Те же проекты и данные.',
                      logs: 'История операций и вывод приложений.',
                      settings: 'Подключение к вашему исполнителю.',
                      help: 'От первого сервера до автоматического деплоя.',
                    } as Record<string, string>
                  )[view]
                }
              </p>
            </div>
            {!['settings', 'help', 'logs'].includes(view) && (
              <Button
                className="primary-button"
                aria-label={
                  view === 'servers'
                    ? 'Добавить сервер'
                    : view === 'migrations'
                      ? 'Перенести проект'
                      : 'Новый проект'
                }
                onClick={() => {
                  if (view === 'migrations') setMigrationProjectId(undefined);
                  setModal(
                    view === 'servers'
                      ? 'server'
                      : view === 'migrations'
                        ? 'migration'
                        : 'project',
                  );
                }}
              >
                <Plus size={17} />
                {view === 'servers'
                  ? 'Добавить сервер'
                  : view === 'migrations'
                    ? 'Перенести проект'
                    : 'Новый проект'}
              </Button>
            )}
          </div>
          {(ws.error || notice) && (
            <output className="notice">
              <AlertCircle size={16} />
              {ws.error || notice}
              <button
                onClick={() => setNotice('')}
                aria-label="Скрыть сообщение"
              >
                ×
              </button>
            </output>
          )}
          {view === 'overview' && (
            <>
              <div className="stats-grid">
                <Stat
                  label="Активные проекты"
                  value={String(running)}
                  suffix={`/ ${data.projects.length}`}
                  icon={Box}
                  detail={`${data.projects.filter((p) => p.status === 'stopped').length} остановлено`}
                />
                <Stat
                  label="Серверы онлайн"
                  value={String(online)}
                  suffix={`/ ${data.servers.length}`}
                  icon={ServerIcon}
                  detail={
                    online === data.servers.length && online
                      ? 'Все серверы доступны'
                      : 'По последней проверке'
                  }
                  good={online > 0}
                />
                <Stat
                  label="Последние деплои"
                  value={String(deploys.length)}
                  icon={Layers}
                  detail="В истории пространства"
                />
                <Stat
                  label="Успешные деплои"
                  value={
                    complete ? ((success / complete) * 100).toFixed(1) : '—'
                  }
                  suffix={complete ? '%' : ''}
                  icon={Activity}
                  detail={`${success} из ${complete} завершённых`}
                  good={success > 0}
                />
              </div>
              <div className="overview-grid">
                <section className="projects-section">
                  <div className="section-heading">
                    <h2>
                      Проекты{' '}
                      <span className="count-badge">
                        {data.projects.length}
                      </span>
                    </h2>
                    <button
                      className="text-link"
                      onClick={() => go('projects')}
                    >
                      Все проекты <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {projectCards}
                </section>
                <aside className="overview-aside">
                  <section className="panel">
                    <div className="section-heading">
                      <h2>Серверы</h2>
                      <button
                        className="icon-button"
                        aria-label="Добавить сервер"
                        onClick={() => setModal('server')}
                      >
                        <Plus size={18} />
                      </button>
                    </div>
                    {data.servers.slice(0, 3).map((s) => (
                      <button
                        className="server-mini"
                        key={s.id}
                        onClick={() => go('servers')}
                      >
                        <div className="server-mini-title">
                          <span className="server-icon">
                            <ServerIcon size={18} />
                          </span>
                          <div>
                            <strong>{s.name}</strong>
                            <small>{s.region}</small>
                          </div>
                          <span
                            className={
                              s.status === 'online'
                                ? 'online-dot'
                                : 'offline-dot'
                            }
                          />
                        </div>
                        <div className="mini-metrics">
                          <Metric label="CPU" value={s.cpu} />
                          <Metric label="RAM" value={s.memory} />
                        </div>
                      </button>
                    ))}
                    {!data.servers.length && (
                      <p className="panel-empty">Подключите первый сервер</p>
                    )}
                    <button
                      className="panel-link"
                      onClick={() => go('servers')}
                    >
                      Управление серверами <ChevronRight size={15} />
                    </button>
                  </section>
                  <section className="tip-card">
                    <span className="tip-icon">
                      <ArrowDownUp size={21} />
                    </span>
                    <h3>Проекты могут переезжать</h3>
                    <p>
                      Переносите приложение и его данные между подключёнными
                      серверами.
                    </p>
                    <button onClick={() => go('migrations')}>
                      Перенести проект <ArrowUpRight size={15} />
                    </button>
                  </section>
                </aside>
              </div>
              <section className="recent-section">
                <div className="section-heading">
                  <h2>Последние деплои</h2>
                  <button
                    className="text-link"
                    onClick={() => go('deployments')}
                  >
                    Вся история <ArrowUpRight size={15} />
                  </button>
                </div>
                <JobTable jobs={data.jobs.slice(0, 4)} onSelect={showJob} />
              </section>
            </>
          )}
          {view === 'projects' && (
            <section className="all-projects">{projectCards}</section>
          )}
          {view === 'servers' && (
            <div className="server-grid">
              {data.servers.map((s) => (
                <section className="server-card" key={s.id}>
                  <div className="section-heading">
                    <span className="server-icon large">
                      <ServerIcon size={24} />
                    </span>
                    <StatusBadge status={s.status} />
                  </div>
                  <h2>{s.name}</h2>
                  <p className="server-host">
                    {s.host}:{s.port} <span>· {s.region}</span>
                  </p>
                  <p className="server-specs">{s.specs}</p>
                  <div className="server-metrics">
                    <Metric label="CPU" value={s.cpu} />
                    <Metric label="RAM" value={s.memory} />
                    <Metric label="Диск" value={s.disk} />
                  </div>
                  <div className="server-projects">
                    {data.projects
                      .filter((p) => p.serverId === s.id)
                      .map((p) => (
                        <button key={p.id} onClick={() => openProject(p)}>
                          <FolderGit2 size={13} />
                          {p.name}
                        </button>
                      ))}
                    {!data.projects.some((p) => p.serverId === s.id) && (
                      <span>Пока нет проектов</span>
                    )}
                  </div>
                  <div className="server-actions">
                    <Button
                      variant="outline"
                      disabled={!connection}
                      onClick={() => setConsoleServer(s)}
                    >
                      <Terminal size={14} />
                      Консоль
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setChatServerId(s.id)}
                    >
                      <MessageSquare size={14} />
                      Чат
                    </Button>
                    <Button
                      variant="outline"
                      disabled={ws.busy}
                      onClick={() => refreshServer(s)}
                    >
                      <RefreshCw size={14} />
                      Проверить
                    </Button>
                    {s.status === 'needs_setup' && (
                      <Button onClick={() => setConfirmServer(s)}>
                        Настроить сервер
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={!connection || ws.busy}
                      onClick={() => setEditServerId(s.id)}
                    >
                      <Settings2 size={14} /> Редактировать
                    </Button>
                    <small>
                      {s.checkedAt
                        ? relativeDate(s.checkedAt)
                        : connection
                          ? 'Не проверялся'
                          : 'Не проверялся'}
                    </small>
                  </div>
                </section>
              ))}
              {!data.servers.length && (
                <EmptyState
                  title="Подключите первый сервер"
                  description="Понадобятся IP-адрес и доступ по SSH."
                  action={
                    <Button onClick={() => setModal('server')}>
                      Добавить сервер
                    </Button>
                  }
                />
              )}
            </div>
          )}
          {view === 'deployments' && (
            <JobTable jobs={data.jobs} onSelect={showJob} />
          )}
          {view === 'migrations' && (
            <>
              <MigrationQueue
                projects={data.projects}
                servers={data.servers}
                jobs={data.jobs}
                onContinue={(id) => {
                  setMigrationProjectId(id);
                  setModal('migration');
                }}
                onLogs={showJob}
              />

              <details className="migration-guide">
                <summary>Как проходит перенос</summary>
                <div className="migration-explainer">
                  <div className="migration-visual">
                    <span>
                      <ServerIcon size={31} />
                      Исходный сервер
                    </span>
                    <div className="transfer-line">
                      <ArrowDownUp size={25} />
                      <small>SSH · SHA-256</small>
                    </div>
                    <span>
                      <ServerIcon size={31} />
                      Новый сервер
                    </span>
                  </div>
                  <div>
                    <h2>Переезд с сохранением данных</h2>
                    <p>
                      Сначала проверьте состав данных и новый сервер.
                      Исполнитель остановит приложение, передаст файлы, Docker
                      volumes и снимки контейнеров или конфигурацию systemd,
                      затем проверит новую копию.
                    </p>
                    <div className="inline-notice">
                      На время переноса проект недоступен. DNS и внешние базы
                      переключаются отдельно. Исходная копия и резервные архивы
                      сохраняются. После запуска новой копии откат не подменяет
                      её данные старыми.
                    </div>
                    <Button
                      className="primary-button"
                      onClick={() => {
                        setMigrationProjectId(undefined);
                        setModal('migration');
                      }}
                    >
                      Выбрать проект <ArrowUpRight size={15} />
                    </Button>
                  </div>
                </div>
              </details>
              <div className="section-heading">
                <h2>История переносов</h2>
              </div>
              <JobTable
                jobs={data.jobs.filter((j) => j.type === 'migration')}
                onSelect={showJob}
              />
            </>
          )}
          {view === 'logs' && (
            <LogViewer
              key={selectedJob || 'logs'}
              ws={ws}
              selectedJob={selectedJob}
              setSelectedJob={setSelectedJob}
              onProject={(project, tab) => {
                setFilter('all');
                setSearch('');
                go('projects');
                openProject(project, tab);
              }}
            />
          )}
          {view === 'settings' && (
            <div className="settings-panel">
              <span className="settings-icon">
                <Terminal size={30} />
              </span>
              <h2>
                {connection
                  ? 'Исполнитель подключён'
                  : 'Подключите серверную часть'}
              </h2>
              <p>
                Исполнитель — серверная часть MayPlane. Он подключается к вашим
                VPS по SSH, собирает проекты, запускает контейнеры и передаёт
                логи и консоль в панель. Один исполнитель управляет всеми
                серверами.
              </p>
              {connection ? (
                <>
                  <code className="code-block">
                    {connection.url ||
                      'Локальный исполнитель · подключён автоматически'}
                  </code>
                  <Button
                    variant="outline"
                    onClick={() => {
                      ws.disconnect();
                      setProjectId(null);
                    }}
                  >
                    <Unplug size={16} />
                    Отключиться
                  </Button>
                </>
              ) : (
                <Button
                  className="primary-button"
                  onClick={() => setModal('connect')}
                >
                  Указать адрес исполнителя <ArrowUpRight size={15} />
                </Button>
              )}
              <div className="inline-notice">
                При локальном запуске панель подключается автоматически. Для
                удалённого исполнителя укажите HTTPS-адрес и ключ; этот ключ
                остаётся только в памяти вкладки.
              </div>
              <LlmSettings ws={ws} />
              <GitConnections ws={ws} />
              <button className="text-link" onClick={() => go('help')}>
                Инструкция по настройке <ChevronRight size={14} />
              </button>
            </div>
          )}
          {view === 'help' && (
            <div className="help-grid">
              {[
                [
                  '01',
                  'Запустите исполнитель',
                  'В папке проекта выполните npm run runner:setup, затем npm run runner и npm run dev. Локальная панель подключится автоматически. Для удалённой панели нужен исполнитель с HTTPS; его адрес и ключ укажите в настройках.',
                ],
                [
                  '02',
                  'Подключите сервер',
                  'Добавьте IP и root-доступ по SSH. Сравните SHA-256 ключа с консолью провайдера. Если Docker не установлен, нажмите «Настроить сервер». Автоматическая установка рассчитана на Ubuntu 24.04 и 26.04.',
                ],
                [
                  '03',
                  'Добавьте проект',
                  'Укажите HTTPS Git-репозиторий, ветку и Compose-файл. Для приватных репозиториев подключите GitHub в настройках. В репозитории должны быть compose.yaml и Dockerfile, если требуется сборка. Введите .env в карточке проекта или загрузите файл. Приложению добавьте healthcheck, задайте свободные порты и отдельные тома. Домены и TLS настраиваются в вашем прокси.',
                ],
                [
                  '04',
                  'Включите автодеплой',
                  'Откройте проект → CI/CD. Включите автодеплой, создайте секрет и добавьте webhook в GitHub: Settings → Webhooks, тип application/json, событие Push. Исполнитель должен быть доступен GitHub по HTTPS; задайте MAYPLANE_PUBLIC_URL.',
                ],
                [
                  '05',
                  'Управляйте и переносите',
                  'В карточке проекта доступны запуск, перезапуск, остановка, .env и логи. Перенос копирует только данные управляемого проекта. Внешние базы, S3, внешние сети и DNS требуют отдельного плана переноса.',
                ],
                [
                  '06',
                  'Сохраните доступы',
                  'Резервируйте .runner-data и MAYPLANE_ENCRYPTION_KEY вместе. Без ключа нельзя расшифровать сохранённые секреты.',
                ],
              ].map(([n, t, d]) => (
                <section className="help-card" key={n}>
                  <span>{n}</span>
                  <h2>{t}</h2>
                  <p>{d}</p>
                </section>
              ))}
            </div>
          )}
          <footer className="page-footer">
            <span>MayPlane · меньше рутины, больше кода</span>
            <span>
              <span className="online-dot" />
              {connection
                ? 'Данные вашего исполнителя'
                : 'Ожидаем подключения к серверной части'}
            </span>
          </footer>
        </div>
      </main>
      <ServerChat
        ws={ws}
        server={data.servers.find((s) => s.id === chatServerId) || null}
        onClose={() => setChatServerId(null)}
      />
      <ServerConsole
        server={data.servers.find((s) => s.id === consoleServer?.id) || null}
        ws={ws}
        onClose={() => setConsoleServer(null)}
      />
      <EditServer
        server={data.servers.find((s) => s.id === editServerId) || null}
        ws={ws}
        onClose={() => setEditServerId(null)}
        onSaved={() => {
          setEditServerId(null);
          setNotice('Настройки сервера сохранены.');
        }}
      />
      <WorkspaceDialogs
        modal={modal}
        setModal={setModal}
        ws={ws}
        onProject={openProject}
        migrationProjectId={migrationProjectId}
        onJob={showJob}
        confirmServer={confirmServer}
        setConfirmServer={setConfirmServer}
      />
      <ProjectDetail
        project={selectedProject}
        initialTab={projectTab}
        ws={ws}
        onClose={() => setProjectId(null)}
        onJob={(j) => {
          setProjectId(null);
          showJob(j);
        }}
        onMigrate={() => {
          setMigrationProjectId(projectId || undefined);
          setProjectId(null);
          setModal('migration');
        }}
      />
    </SidebarProvider>
  );
}
function ProjectCard({
  p,
  server,
  onClick,
}: {
  p: Project;
  server: string;
  onClick: () => void;
}) {
  const Icon = p.kind === 'web' ? Globe : p.kind === 'bot' ? Bot : Box;
  return (
    <button className="project-card" onClick={onClick}>
      <div className="card-top">
        <span className={`project-icon ${p.color}`}>
          <Icon size={23} />
        </span>
        <StatusBadge status={p.status} />
      </div>
      <h3>{p.name}</h3>
      <span className="instance-label" title="Идентификатор экземпляра">
        Экземпляр {p.id.slice(0, 8)}
      </span>
      <div className="project-domain">
        {p.domain || kindLabels[p.kind]}
        <ArrowUpRight size={13} />
      </div>
      <div className="project-meta">
        <span>
          <GitBranch size={13} />
          {p.branch}
        </span>
        <span>
          <ServerIcon size={13} />
          {server}
        </span>
      </div>
      <div className="card-footer">
        <span>
          <Clock3 size={13} />
          {relativeDate(p.updatedAt)}
        </span>
        <span className={p.autoDeploy ? 'auto-deploy' : 'muted'}>
          {p.autoDeploy && <Zap size={12} />}{' '}
          {p.autoDeploy ? 'Автодеплой' : kindLabels[p.kind]}
        </span>
      </div>
    </button>
  );
}
function Stat({
  label,
  value,
  suffix,
  icon: Icon,
  detail,
  good,
}: {
  label: string;
  value: string;
  suffix?: string;
  icon: typeof Box;
  detail: string;
  good?: boolean;
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">
        {label}
        <Icon size={17} />
      </div>
      <div className="stat-number">
        {value}
        <span>{suffix}</span>
      </div>
      <div className={good ? 'stat-detail good' : 'stat-detail'}>
        {good && <span className="online-dot" />}
        {detail}
      </div>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <span>
        {label} <b>{value === null ? '—' : `${value}%`}</b>
      </span>
      <Progress value={value} aria-label={label} />
    </div>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Empty className="empty-state">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action}
    </Empty>
  );
}
function JobTable({
  jobs,
  onSelect,
}: {
  jobs: Job[];
  onSelect: (j: Job) => void;
}) {
  if (!jobs.length)
    return (
      <EmptyState
        title="Операций пока нет"
        description="Здесь появятся результаты запусков и их логи."
      />
    );
  return (
    <div className="jobs-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Проект / сервер</TableHead>
            <TableHead>Операция</TableHead>
            <TableHead>Источник</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead>Время</TableHead>
            <TableHead>
              <span className="sr-only">Логи</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((j) => (
            <TableRow key={j.id}>
              <TableCell>
                <button className="job-project" onClick={() => onSelect(j)}>
                  <span
                    className={`job-icon ${j.status === 'failed' ? 'failed-icon' : ''}`}
                  >
                    {j.status === 'failed' ? (
                      <AlertCircle size={16} />
                    ) : j.status === 'success' ? (
                      <Check size={16} />
                    ) : (
                      <Clock3 size={16} />
                    )}
                  </span>
                  {j.projectName}
                  {j.projectId && (
                    <span className="instance-label">
                      {j.projectId.slice(0, 8)}
                    </span>
                  )}
                </button>
              </TableCell>
              <TableCell>{jobLabels[j.type]}</TableCell>
              <TableCell className="muted">{j.source || 'Вручную'}</TableCell>
              <TableCell>
                <JobStatusBadge job={j} />
              </TableCell>
              <TableCell className="muted">
                {relativeDate(j.createdAt)}
              </TableCell>
              <TableCell>
                <button
                  className="icon-button"
                  aria-label={`Логи ${j.projectName}`}
                  onClick={() => onSelect(j)}
                >
                  <ChevronRight size={16} />
                </button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
