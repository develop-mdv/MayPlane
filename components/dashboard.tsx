'use client';
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
import { WorkspaceDialogs, ProjectDetail, LogViewer } from './workspace-flows';
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
export default function Dashboard() {
  const ws = useWorkspace();
  const { data, connection } = ws;
  const [view, setView] = useState('overview');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [confirmServer, setConfirmServer] = useState<Server | null>(null);
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
  const showJob = (job: Job) => {
    setSelectedJob(job.id);
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
              onClick={() => setProjectId(p.id)}
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
            ezdeploy<span className="brand-dot">.</span>
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
              {connection
                ? 'Подключён исполнитель'
                : 'Демонстрационное пространство'}
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
              {connection ? 'Исполнитель подключён' : 'Деморежим'}
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
                onClick={() =>
                  setModal(
                    view === 'servers'
                      ? 'server'
                      : view === 'migrations'
                        ? 'migration'
                        : 'project',
                  )
                }
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
                        <button key={p.id} onClick={() => setProjectId(p.id)}>
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
                    <small>
                      {s.checkedAt
                        ? relativeDate(s.checkedAt)
                        : connection
                          ? 'Не проверялся'
                          : 'Пример метрик'}
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
                    Исполнитель остановит контейнеры, скопирует проект,
                    Docker-образы и тома, проверит контрольные суммы и запустит
                    копию. Исходные данные останутся на месте.
                  </p>
                  <div className="inline-notice">
                    На время переноса проект недоступен. DNS и внешние базы
                    переключаются отдельно. Поддерживаются управляемые локальные
                    тома и файлы внутри каталога проекта.
                  </div>
                  <Button
                    className="primary-button"
                    onClick={() => setModal('migration')}
                  >
                    Выбрать проект <ArrowUpRight size={15} />
                  </Button>
                </div>
              </div>
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
                  : 'Подключите свой исполнитель'}
              </h2>
              <p>
                Исполнитель работает на вашем компьютере или сервере. В нём
                хранятся проекты, зашифрованные SSH-доступы, переменные
                окружения и история операций.
              </p>
              {connection ? (
                <>
                  <code className="code-block">{connection.url}</code>
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
                  Подключить исполнитель <ArrowUpRight size={15} />
                </Button>
              )}
              <div className="inline-notice">
                Ключ доступа действует для владельца пространства и хранится
                только в памяти вкладки. После обновления страницы подключитесь
                снова.
              </div>
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
                  'В папке проекта выполните npm run runner:setup, затем npm run runner. В файле .env.runner найдите EZDEPLOY_TOKEN. Через «Настройки» укажите http://localhost:8788 и этот ключ. Для удалённой панели нужен исполнитель с HTTPS; разрешите адрес панели в ALLOWED_ORIGINS.',
                ],
                [
                  '02',
                  'Подключите сервер',
                  'Добавьте IP и root-доступ по SSH. Сравните SHA-256 ключа с консолью провайдера. Если Docker не установлен, нажмите «Настроить сервер». Автоматическая установка рассчитана на Ubuntu 24.04.',
                ],
                [
                  '03',
                  'Добавьте проект',
                  'Укажите публичный HTTPS Git-репозиторий, ветку и Compose-файл. В репозитории должны быть compose.yaml и Dockerfile, если требуется сборка. Загрузите .env отдельно. Приложению добавьте healthcheck, задайте свободные порты и отдельные тома. Домены и TLS настраиваются в вашем прокси.',
                ],
                [
                  '04',
                  'Включите автодеплой',
                  'Откройте проект → CI/CD. Включите автодеплой, создайте секрет и добавьте webhook в GitHub: Settings → Webhooks, тип application/json, событие Push. Исполнитель должен быть доступен GitHub по HTTPS; задайте EZDEPLOY_PUBLIC_URL.',
                ],
                [
                  '05',
                  'Управляйте и переносите',
                  'В карточке проекта доступны запуск, перезапуск, остановка, .env и логи. Перенос копирует только данные управляемого проекта. Внешние базы, S3, внешние сети и DNS требуют отдельного плана переноса.',
                ],
                [
                  '06',
                  'Сохраните доступы',
                  'Резервируйте .runner-data и EZDEPLOY_ENCRYPTION_KEY вместе. Без ключа нельзя расшифровать сохранённые секреты. В деморежиме используются примеры: изменения сбрасываются при обновлении страницы.',
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
            <span>ezdeploy · меньше рутины, больше кода</span>
            <span>
              <span className="online-dot" />
              {connection
                ? 'Данные вашего исполнителя'
                : 'Демоданные · изменения до обновления страницы'}
            </span>
          </footer>
        </div>
      </main>
      <WorkspaceDialogs
        modal={modal}
        setModal={setModal}
        ws={ws}
        onProject={(p) => setProjectId(p.id)}
        onJob={showJob}
        confirmServer={confirmServer}
        setConfirmServer={setConfirmServer}
      />
      <ProjectDetail
        project={selectedProject}
        ws={ws}
        onClose={() => setProjectId(null)}
        onJob={(j) => {
          setProjectId(null);
          showJob(j);
        }}
        onMigrate={() => {
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
                </button>
              </TableCell>
              <TableCell>{jobLabels[j.type]}</TableCell>
              <TableCell className="muted">{j.source || 'Вручную'}</TableCell>
              <TableCell>
                <StatusBadge status={j.status} />
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
