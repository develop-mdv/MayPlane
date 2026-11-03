'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  Folder,
  FolderGit2,
  GitBranch,
  Globe,
  LayoutGrid,
  LoaderCircle,
  Menu,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SquarePen,
  Terminal,
  X,
  Pencil,
} from 'lucide-react';
import { useWorkspace } from '@/lib/use-workspace';
import type { Server as Machine } from '@/lib/domain';
import {
  activeSession,
  providerNames,
  sessionLabels,
  useHub,
  type AgentSession,
  type Hub,
  type HubProject,
} from '@/lib/hub';
import type { Workspace } from '@/lib/use-workspace';
import { AgentChat, NewSession } from './agent-chat';
import { MachinesPanel, PairComputer, ServerForm } from './machines-panel';
import { CopyButton, ErrorText, Field, Modal, Submit, Toast } from './hub-ui';

type View = 'chat' | 'projects' | 'servers' | 'settings';
function NewProject({
  hub,
  machines,
  onClose,
  onSaved,
  onAddMachine,
}: {
  hub: Hub;
  machines: Machine[];
  onClose: () => void;
  onSaved: (p: HubProject) => void;
  onAddMachine: () => void;
}) {
  const [name, setName] = useState(''),
    [machineId, setMachineId] = useState(machines[0]?.id || ''),
    [path, setPath] = useState(''),
    [repo, setRepo] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const machine = machines.find((m) => m.id === machineId);
  return (
    <Modal
      title="Добавить проект"
      description="Проект — это рабочая папка на одной из ваших машин. Все диалоги сохраняют её контекст."
      onClose={onClose}
    >
      <form
        className="hub-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const p = await hub.mutate<HubProject>('/projects', {
              name,
              machineId,
              path,
              repo,
            });
            onSaved(p);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Название проекта">
          <input
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Мой проект"
            maxLength={80}
          />
        </Field>
        <Field label="Машина">
          <select
            required
            value={machineId}
            onChange={(e) => {
              setMachineId(e.target.value);
              setPath('');
            }}
          >
            <option value="" disabled>
              Выберите машину
            </option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ·{' '}
                {m.transport === 'local'
                  ? 'Этот компьютер'
                  : m.region || m.host}
              </option>
            ))}
          </select>
        </Field>
        {!machines.length && (
          <button type="button" className="hub-button" onClick={onAddMachine}>
            <Plus size={15} />
            Сначала подключить машину
          </button>
        )}
        <Field
          label="Путь к рабочей папке"
          hint="Укажите существующую папку на выбранной машине. Панель не клонирует репозиторий и не меняет её содержимое при добавлении."
        >
          <input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={
              machine?.platform === 'win32'
                ? 'D:\\Projects\\my-app'
                : '/home/deploy/projects/my-app'
            }
            maxLength={1024}
          />
        </Field>
        <Field
          label="Git-репозиторий · необязательно"
          hint="Ссылка для быстрого перехода. Git использует доступы, настроенные на машине проекта."
        >
          <input
            type="url"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="https://github.com/owner/project"
          />
        </Field>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="hub-button" onClick={onClose}>
            Отмена
          </button>
          <Submit busy={busy}>Добавить проект</Submit>
        </div>
      </form>
    </Modal>
  );
}
function SettingsPanel({ ws }: { ws: Workspace }) {
  const [url, setUrl] = useState(ws.connection?.url || ''),
    [token, setToken] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="hub-page settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span>
          <h1>Настройки</h1>
          <p>Подключение панели и границы доступа.</p>
        </div>
      </div>
      <section className="detail-card">
        <div className="section-title">
          <h2>Серверная часть</h2>
          <span
            className={`state-badge ${ws.connection && !ws.error ? 'online' : ''}`}
          >
            <i />
            {ws.connection && !ws.error ? 'Подключена' : 'Нет соединения'}
          </span>
        </div>
        <p className="muted">
          Runner хранит проекты и зашифрованные секреты, соединяет панель с
          вашими машинами.
        </p>
        <form
          className="hub-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await ws.connect(url, token);
              setToken('');
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Адрес API"
            hint="Пустое поле — локальный прокси панели. Для удалённого API нужен HTTPS."
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Локальное подключение / https://control.example.com"
            />
          </Field>
          <Field
            label="Ключ доступа"
            hint="Хранится в памяти этой вкладки. Не записывается в localStorage."
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              placeholder="EZDEPLOY_TOKEN — для прямого подключения"
            />
          </Field>
          <ErrorText error={error} />
          <div className="form-actions">
            {ws.connection && (
              <button
                type="button"
                className="hub-button"
                onClick={() => {
                  ws.disconnect();
                  setToken('');
                }}
              >
                Отключить
              </button>
            )}
            <Submit busy={busy}>Подключить</Submit>
          </div>
        </form>
      </section>
      <section className="detail-card">
        <div className="section-title">
          <h2>Безопасность</h2>
          <ShieldCheck size={18} />
        </div>
        <div className="security-item">
          <Check size={16} />
          <div>
            <strong>Секреты зашифрованы</strong>
            <p>
              SSH-пароли, ключи и история диалогов защищены AES-256-GCM. Ключ
              шифрования хранится отдельно от базы.
            </p>
          </div>
        </div>
        <div className="security-item">
          <Check size={16} />
          <div>
            <strong>Личные аккаунты агентов</strong>
            <p>
              Вход выполняется на машине агента. Данные аккаунта не переносятся
              между серверами автоматически.
            </p>
          </div>
        </div>
        <div className="security-item">
          <Check size={16} />
          <div>
            <strong>Контроль действий в диалоге</strong>
            <p>
              Codex использует песочницу проекта и запросы дополнительных прав.
              OpenCode спрашивает разрешение на инструменты; его действия
              выполняются с правами пользователя ОС.
            </p>
          </div>
        </div>
        <div className="security-item">
          <Check size={16} />
          <div>
            <strong>Личная панель</strong>
            <p>
              Текущая версия рассчитана на одного владельца. Для доступа через
              интернет используйте HTTPS и аутентификацию reverse proxy или VPN.
              Локальный dev-сервер доступен на 127.0.0.1.
            </p>
          </div>
        </div>
      </section>
      <div className="settings-footer">
        <span>
          ezdeploy <code>0.2.0</code>
        </span>
        <a
          href="https://github.com/develop-mdv/ezdeploy"
          target="_blank"
          rel="noreferrer"
        >
          Репозиторий проекта <ArrowUpRight size={14} />
        </a>
      </div>
    </div>
  );
}

export default function WorkspaceShell() {
  const ws = useWorkspace(),
    hub = useHub(ws);
  const [view, setView] = useState<View>('chat'),
    [selectedSession, setSelectedSession] = useState<string | null>(null),
    [selectedMachine, setSelectedMachine] = useState<string | null>(null),
    [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [newProject, setNewProject] = useState(false),
    [newSession, setNewSession] = useState(false),
    [serverForm, setServerForm] = useState<Machine | 'new' | null>(null),
    [pair, setPair] = useState(false),
    [sidebar, setSidebar] = useState(false),
    [info, setInfo] = useState(false),
    [search, setSearch] = useState(false),
    [query, setQuery] = useState(''),
    [archive, setArchive] = useState(false);
  const [toast, setToast] = useState(''),
    [error, setError] = useState(''),
    [rename, setRename] = useState<AgentSession | null>(null),
    [title, setTitle] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const session = hub.data.sessions.find((s) => s.id === selectedSession),
    project = hub.data.projects.find(
      (p) => p.id === (session?.projectId || projectFilter),
    ),
    machine = ws.data.servers.find((m) => m.id === project?.machineId);
  const connected = !!ws.connection && !ws.error;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearch((v) => !v);
      }
      if (e.key === 'Escape') {
        setSidebar(false);
        setSearch(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (search) setTimeout(() => searchInput.current?.focus(), 30);
  }, [search]);
  const closeToast = useCallback(() => setToast(''), []);
  function navigate(v: View) {
    setView(v);
    setSidebar(false);
    setError('');
  }
  function openSession(s: AgentSession) {
    setSelectedSession(s.id);
    setProjectFilter(s.projectId);
    setView('chat');
    setSidebar(false);
    setSearch(false);
    setQuery('');
  }
  function startSession(projectId?: string) {
    if (projectId) setProjectFilter(projectId);
    if (!hub.data.projects.length) {
      setNewProject(true);
      return;
    }
    setNewSession(true);
  }
  const visibleSessions = hub.data.sessions.filter(
    (s) =>
      !!s.archived === archive &&
      (!projectFilter || s.projectId === projectFilter),
  );
  const running = hub.data.sessions.filter(activeSession).length;
  return (
    <div className="workspace-app">
      <aside className={`workspace-sidebar ${sidebar ? 'mobile-open' : ''}`}>
        <div className="brand-row">
          <button
            className="brand"
            onClick={() => {
              setSelectedSession(null);
              setProjectFilter(null);
              navigate('chat');
            }}
            aria-label="ezdeploy — главная"
          >
            <span className="brand-icon">
              <Command size={19} />
            </span>
            <span>
              ezdeploy<span className="brand-period">.</span>
            </span>
          </button>
          <button
            className="icon-button sidebar-close"
            title="Закрыть меню"
            aria-label="Закрыть меню"
            onClick={() => setSidebar(false)}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button
          className="new-chat-button"
          onClick={() => startSession()}
          disabled={!connected}
        >
          <SquarePen size={17} />
          Новый диалог<span>+</span>
        </button>
        <button className="sidebar-search" onClick={() => setSearch(true)}>
          <Search size={15} />
          <span>Поиск по пространству</span>
          <kbd>⌃ K</kbd>
        </button>
        <nav className="main-nav" aria-label="Главная навигация">
          {(
            [
              { id: 'chat', label: 'Диалоги', icon: MessageSquare },
              { id: 'projects', label: 'Проекты', icon: FolderGit2 },
              { id: 'servers', label: 'Серверы', icon: Server },
            ] as const
          ).map((n) => (
            <button
              key={n.id}
              className={view === n.id ? 'active' : ''}
              onClick={() => {
                if (n.id === 'chat') setProjectFilter(null);
                navigate(n.id);
              }}
            >
              <n.icon size={17} />
              <span>{n.label}</span>
              {n.id === 'servers' && <small>{ws.data.servers.length}</small>}
              {n.id === 'chat' && running > 0 && (
                <span className="running-count">{running}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-section-heading">
          <span>ПРОЕКТЫ</span>
          <button
            className="icon-button"
            aria-label="Добавить проект"
            onClick={() => setNewProject(true)}
            disabled={!connected}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="sidebar-projects">
          {hub.data.projects.length ? (
            hub.data.projects.map((p) => (
              <button
                key={p.id}
                className={projectFilter === p.id ? 'selected' : ''}
                onClick={() => {
                  setProjectFilter(p.id);
                  setSelectedSession(null);
                  navigate('chat');
                }}
              >
                <Folder size={15} />
                <span>
                  {p.name}
                  <small>
                    {ws.data.servers.find((m) => m.id === p.machineId)?.name ||
                      'Машина'}
                  </small>
                </span>
                <ChevronRight size={13} />
              </button>
            ))
          ) : (
            <p className="sidebar-empty">
              Здесь будут ваши проекты.
              <br />
              Начните с подключения машины.
            </p>
          )}
        </div>
        <div className="sidebar-section-heading">
          <span>{archive ? 'АРХИВ ДИАЛОГОВ' : 'НЕДАВНИЕ ДИАЛОГИ'}</span>
          <button
            className={`icon-button ${archive ? 'is-active' : ''}`}
            aria-label={
              archive ? 'Показать активные диалоги' : 'Показать архив'
            }
            onClick={() => setArchive((v) => !v)}
          >
            <Archive size={14} />
          </button>
        </div>
        <div className="sidebar-sessions">
          {visibleSessions.length ? (
            visibleSessions.map((s) => (
              <button
                key={s.id}
                className={
                  selectedSession === s.id && view === 'chat' ? 'selected' : ''
                }
                onClick={() => openSession(s)}
              >
                <span className={`session-dot ${s.status}`} />
                <span>
                  {s.title}
                  <small>
                    {providerNames[s.provider]}
                    <span>·</span>
                    {hub.data.projects.find((p) => p.id === s.projectId)?.name}
                  </small>
                </span>
                {s.status === 'approval' && <i className="attention-dot" />}
              </button>
            ))
          ) : (
            <p className="sidebar-empty">
              {archive
                ? 'В архиве пока пусто.'
                : 'Диалоги появятся после первой задачи агенту.'}
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="runner-state">
            <i className={connected ? 'live-dot' : 'offline-dot'} />
            <span>
              {ws.initializing
                ? 'Подключаемся…'
                : connected
                  ? 'Рабочее пространство на связи'
                  : 'Нет подключения'}
            </span>
            {connected && <ShieldCheck size={13} />}
          </div>
          <button
            className={view === 'settings' ? 'active' : ''}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={17} />
            <span>Настройки</span>
            <span className="version-label">v0.2</span>
          </button>
          <div className="owner-row">
            <span className="owner-avatar">D</span>
            <div>
              <strong>Личное пространство</strong>
              <span>Ваши машины и проекты</span>
            </div>
            <ShieldCheck size={15} />
          </div>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Закрыть меню"
          onClick={() => setSidebar(false)}
        />
      )}
      <main className="workspace-main">
        <header className="workspace-header">
          <div className="header-breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Открыть меню"
              onClick={() => setSidebar(true)}
            >
              <Menu size={19} />
            </button>
            <span className="breadcrumb-home">Рабочее пространство</span>
            <ChevronRight size={13} />
            <strong>
              {view === 'chat'
                ? project?.name || 'Диалоги'
                : view === 'projects'
                  ? 'Проекты'
                  : view === 'servers'
                    ? 'Серверы'
                    : 'Настройки'}
            </strong>
            {view === 'chat' && project && (
              <span className="header-machine">
                <Monitor size={13} />
                {machine?.name}
              </span>
            )}
          </div>
          <div className="header-actions">
            {view === 'chat' && session ? (
              <>
                <span className={`session-state ${session.status}`}>
                  <i />
                  {sessionLabels[session.status]}
                </span>
                <button
                  className="icon-button"
                  title="Переименовать диалог"
                  aria-label="Переименовать диалог"
                  onClick={() => {
                    setRename(session);
                    setTitle(session.title);
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button"
                  title={
                    session.archived
                      ? 'Восстановить диалог'
                      : 'Архивировать диалог'
                  }
                  aria-label={
                    session.archived
                      ? 'Восстановить диалог'
                      : 'Архивировать диалог'
                  }
                  disabled={activeSession(session)}
                  onClick={async () => {
                    try {
                      await hub.mutate(
                        `/sessions/${session.id}`,
                        { archived: !session.archived },
                        'PATCH',
                      );
                      setToast(
                        session.archived
                          ? 'Диалог восстановлен'
                          : 'Диалог в архиве',
                      );
                      setSelectedSession(null);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Archive size={16} />
                </button>
                <button
                  className={`icon-button ${info ? 'is-active' : ''}`}
                  aria-label="Информация о проекте"
                  title="Информация о проекте"
                  onClick={() => setInfo((v) => !v)}
                >
                  <LayoutGrid size={17} />
                </button>
              </>
            ) : (
              <span className="private-label">
                <ShieldCheck size={14} />
                Личное пространство
              </span>
            )}
          </div>
        </header>
        {(ws.error || hub.error) && (
          <div className="connection-banner" role="alert">
            <Activity size={16} />
            <span>{ws.error || hub.error}</span>
            <button onClick={() => navigate('settings')}>
              Настроить подключение <ArrowUpRight size={13} />
            </button>
          </div>
        )}
        {error && (
          <div className="connection-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError('')} aria-label="Закрыть ошибку">
              <X size={15} />
            </button>
          </div>
        )}
        <div
          className={`workspace-content ${info && view === 'chat' && project ? 'with-info' : ''}`}
        >
          {view === 'chat' ? (
            <AgentChat
              session={session}
              project={project}
              machine={machine}
              hub={hub}
              onNewProject={() => setNewProject(true)}
              onNewSession={() => startSession()}
              disabled={!connected}
            />
          ) : view === 'servers' ? (
            <MachinesPanel
              ws={ws}
              hub={hub}
              selectedId={selectedMachine}
              onSelect={setSelectedMachine}
              onAdd={(s) => setServerForm(s || 'new')}
              onPair={() => setPair(true)}
            />
          ) : view === 'settings' ? (
            <SettingsPanel ws={ws} />
          ) : (
            <div className="hub-page projects-page">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">ВАШ КОД, ГДЕ БЫ ОН НИ БЫЛ</span>
                  <h1>
                    Проекты
                    <span className="heading-count">
                      {hub.data.projects.length}
                    </span>
                  </h1>
                  <p>Рабочие папки, машины и диалоги с агентами.</p>
                </div>
                <button
                  className="hub-button primary"
                  disabled={!connected}
                  onClick={() => setNewProject(true)}
                >
                  <Plus size={16} />
                  Добавить проект
                </button>
              </div>
              {hub.data.projects.length ? (
                <div className="projects-grid">
                  {hub.data.projects.map((p) => {
                    const m = ws.data.servers.find((s) => s.id === p.machineId),
                      ss = hub.data.sessions.filter(
                        (s) => s.projectId === p.id && !s.archived,
                      );
                    return (
                      <article className="project-card" key={p.id}>
                        <div className="project-card-heading">
                          <span className="project-icon">
                            <FolderGit2 size={22} />
                          </span>
                          <span className="connection-pill">
                            <Monitor size={12} />
                            {m?.name || 'Машина'}
                          </span>
                        </div>
                        <h2>{p.name}</h2>
                        <div className="project-path">
                          <code>{p.path}</code>
                          <CopyButton value={p.path} />
                        </div>
                        <div className="project-dialogs">
                          <MessageSquare size={14} />
                          {ss.length} диалогов
                          <span>
                            {ss.filter(activeSession).length
                              ? '· ' +
                                ss.filter(activeSession).length +
                                ' в работе'
                              : ''}
                          </span>
                        </div>
                        {p.repo && (
                          <a
                            className="project-repo"
                            href={p.repo}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <GitBranch size={13} />
                            {p.repo
                              .replace('https://github.com/', '')
                              .replace(/\.git$/, '')}
                            <ArrowUpRight size={13} />
                          </a>
                        )}
                        <footer>
                          <button
                            className="hub-button"
                            onClick={() => {
                              setProjectFilter(p.id);
                              setSelectedSession(null);
                              navigate('chat');
                            }}
                          >
                            Открыть проект <ChevronRight size={14} />
                          </button>
                          <button
                            className="icon-button"
                            title="Новый диалог в проекте"
                            aria-label={`Новый диалог: ${p.name}`}
                            onClick={() => startSession(p.id)}
                          >
                            <SquarePen size={18} />
                          </button>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">
                    <FolderGit2 size={30} />
                  </div>
                  <h2>У каждого проекта своё место</h2>
                  <p>
                    Добавьте папку с кодом на любой подключённой машине.
                    <br />
                    Codex и OpenCode будут работать в её контексте.
                  </p>
                  <button
                    className="hub-button primary"
                    disabled={!connected}
                    onClick={() => setNewProject(true)}
                  >
                    <Plus size={16} />
                    Добавить проект
                  </button>
                </div>
              )}
            </div>
          )}
          {view === 'chat' && project && !session && (
            <div className="project-floating-context">
              <div>
                <FolderGit2 size={18} />
                <span>
                  <strong>{project.name}</strong>
                  <code>{project.path}</code>
                </span>
              </div>
              <button
                className="hub-button primary"
                disabled={!connected}
                onClick={() => startSession(project.id)}
              >
                <Plus size={15} />
                Новый диалог
              </button>
            </div>
          )}
          {info && view === 'chat' && project && (
            <aside className="project-inspector">
              <div className="inspector-heading">
                <h2>Контекст проекта</h2>
                <button
                  className="icon-button"
                  aria-label="Закрыть информацию"
                  onClick={() => setInfo(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <span className="inspector-project-icon">
                <FolderGit2 size={27} />
              </span>
              <h3>{project.name}</h3>
              <div className="inspector-field">
                <span>Машина</span>
                <button
                  className="text-button"
                  onClick={() => {
                    setSelectedMachine(project.machineId);
                    navigate('servers');
                  }}
                >
                  <Monitor size={14} />
                  {machine?.name}
                  <ArrowUpRight size={13} />
                </button>
              </div>
              <div className="inspector-field">
                <span>Рабочая папка</span>
                <div className="copy-code">
                  <code>{project.path}</code>
                  <CopyButton value={project.path} />
                </div>
              </div>
              {project.repo && (
                <div className="inspector-field">
                  <span>Репозиторий</span>
                  <a href={project.repo} target="_blank" rel="noreferrer">
                    GitHub <ArrowUpRight size={13} />
                  </a>
                </div>
              )}
              <div className="inspector-field">
                <span>Агент</span>
                <strong>{session && providerNames[session.provider]}</strong>
              </div>
              <div className="inspector-field">
                <span>Доступ</span>
                <p>
                  <ShieldCheck size={14} />
                  {session?.mode === 'read-only'
                    ? 'Только чтение'
                    : 'Изменения в папке проекта'}
                </p>
              </div>
              <p className="inspector-note">
                Каждый диалог привязан к одной машине и агенту. Переключение
                проекта сохраняет историю.
              </p>
            </aside>
          )}
        </div>
      </main>
      {newProject && (
        <NewProject
          hub={hub}
          machines={ws.data.servers}
          onClose={() => setNewProject(false)}
          onAddMachine={() => {
            setNewProject(false);
            setPair(true);
          }}
          onSaved={(p) => {
            setNewProject(false);
            setProjectFilter(p.id);
            setSelectedSession(null);
            navigate('chat');
            setToast('Проект добавлен');
          }}
        />
      )}
      {newSession && (
        <NewSession
          hub={hub}
          projects={hub.data.projects}
          machines={ws.data.servers}
          initialProject={projectFilter || undefined}
          onClose={() => setNewSession(false)}
          onCreated={(s) => {
            setNewSession(false);
            openSession(s);
          }}
        />
      )}
      {serverForm && (
        <ServerForm
          ws={ws}
          existing={serverForm === 'new' ? undefined : serverForm}
          onClose={() => setServerForm(null)}
          onSaved={() => {
            setServerForm(null);
            navigate('servers');
            setToast('Подключение сохранено');
            void hub.refresh();
          }}
        />
      )}
      {pair && (
        <PairComputer
          hub={hub}
          ws={ws}
          onClose={() => setPair(false)}
          onPaired={() => {
            setPair(false);
            navigate('servers');
            setToast('Компьютер добавлен');
          }}
        />
      )}
      {search && (
        <Modal
          title="Найти в рабочем пространстве"
          description="Проекты, машины и диалоги"
          onClose={() => {
            setSearch(false);
            setQuery('');
          }}
        >
          <div className="command-search">
            <Search size={18} />
            <input
              ref={searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Название проекта, машины или диалога…"
              aria-label="Поиск"
            />
          </div>
          <div className="search-results">
            {hub.data.projects
              .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setProjectFilter(p.id);
                    setSelectedSession(null);
                    setSearch(false);
                    navigate('chat');
                  }}
                >
                  <FolderGit2 size={17} />
                  <span>{p.name}</span>
                  <small>Проект</small>
                </button>
              ))}
            {ws.data.servers
              .filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
              .map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setSelectedMachine(m.id);
                    setSearch(false);
                    navigate('servers');
                  }}
                >
                  <Server size={17} />
                  <span>{m.name}</span>
                  <small>Машина</small>
                </button>
              ))}
            {hub.data.sessions
              .filter((s) =>
                s.title.toLowerCase().includes(query.toLowerCase()),
              )
              .map((s) => (
                <button key={s.id} onClick={() => openSession(s)}>
                  <MessageSquare size={17} />
                  <span>{s.title}</span>
                  <small>{providerNames[s.provider]}</small>
                </button>
              ))}
            {!hub.data.projects.length &&
              !ws.data.servers.length &&
              !hub.data.sessions.length && (
                <p className="muted">Пока нет проектов, машин и диалогов.</p>
              )}
          </div>
        </Modal>
      )}
      {rename && (
        <Modal title="Название диалога" onClose={() => setRename(null)}>
          <form
            className="hub-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await hub.mutate(`/sessions/${rename.id}`, { title }, 'PATCH');
                setRename(null);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Field label="Название">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                required
              />
            </Field>
            <Submit busy={false}>Сохранить</Submit>
          </form>
        </Modal>
      )}
      <Toast message={toast} onClose={closeToast} />
    </div>
  );
}
