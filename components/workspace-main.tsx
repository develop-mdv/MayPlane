'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowUpRight,
  Boxes,
  ChevronRight,
  Command,
  FileDiff,
  FolderGit2,
  FolderInput,
  FolderOpen,
  GitBranch,
  LayoutGrid,
  Menu,
  MessageSquare,
  Monitor,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { useWorkspace } from '@/lib/use-workspace';
import type { Server as Machine } from '@/lib/domain';
import {
  activeSession,
  providerNames,
  sessionLabels,
  useHub,
  type AgentSession,
  type HubProject,
  type HubService,
  type RemovalTarget,
} from '@/lib/hub';
import { serviceProjects } from '@/lib/service-workspace.mjs';
import { AgentChat, NewSession } from './agent-chat';
import { NewProject, SettingsPanel } from './workspace-forms';
import { MachinesPanel, PairComputer, ServerForm } from './machines-panel';
import { ProjectNavigation, ChatActions } from './project-navigation';
import { ProjectServices, ServicesPanel, type ServiceView } from './services-panel';
import { NativeSessionImport } from './native-session-import';
import { CopyButton, ErrorText, Field, Modal, Submit, Toast } from './hub-ui';
import { RemoveObject } from './remove-object';
import { WorkspaceBrowser } from './workspace-browser';
import type { WorkspaceMode } from '@/lib/workspace-files';

type View = 'chat' | 'projects' | 'services' | 'servers' | 'settings';
export default function WorkspaceMain() {
  const ws = useWorkspace(),
    hub = useHub(ws);
  const [view, setView] = useState<View>('chat'),
    [selectedSession, setSelectedSession] = useState<string | null>(null),
    [selectedMachine, setSelectedMachine] = useState<string | null>(null),
    [scope, setScope] = useState('all');
  const [serviceView, setServiceView] = useState<ServiceView>({});
  const [sessionService, setSessionService] = useState<{ service: HubService; customize: boolean } | null>(null);
  const [sessionMachine, setSessionMachine] = useState<Machine | undefined>();
  const [chatCustomizationId, setChatCustomizationId] = useState<string>();
  const [newProject, setNewProject] = useState(false),
    [newSession, setNewSession] = useState(false),
    [importSession, setImportSession] = useState(false),
    [sessionProject, setSessionProject] = useState<string | null>(null),
    [serverForm, setServerForm] = useState<Machine | 'new' | null>(null),
    [pair, setPair] = useState(false),
    [sidebar, setSidebar] = useState(false),
    [info, setInfo] = useState(false),
    [search, setSearch] = useState(false),
    [query, setQuery] = useState(''),
    [archive, setArchive] = useState(false);
  const [toast, setToast] = useState(''),
    [error, setError] = useState(''),
    [edit, setEdit] = useState<{
      kind: 'chat' | 'project';
      id: string;
      title: string;
    } | null>(null),
    [editTitle, setEditTitle] = useState(''),
    [move, setMove] = useState<AgentSession | null>(null),
    [moveProject, setMoveProject] = useState(''),
    [removal, setRemoval] = useState<RemovalTarget | null>(null),
    [modalBusy, setModalBusy] = useState(false),
    [modalError, setModalError] = useState('');
  const [browser, setBrowser] = useState<{ id: string; session: boolean; mode: WorkspaceMode; turn?: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const session = hub.data.sessions.find((s) => s.id === selectedSession);
  const project = hub.data.projects.find(
    (p) => p.id === (session ? session.projectId : scope),
  );
  const machine = ws.data.servers.find(
    (m) => m.id === (session?.machineId || project?.machineId),
  );
  const browserChat = browser?.session ? hub.data.sessions.find((s) => s.id === browser.id) : undefined;
  const browserProject = browser ? hub.data.projects.find((p) => p.id === (browser.session ? browserChat?.projectId : browser.id)) : undefined;
  const browserMachineId = browserChat?.machineId || browserProject?.machineId;
  const connected = !!ws.connection && !ws.error;
  const closeToast = useCallback(() => setToast(''), []);
  const visible = hub.data.sessions.filter(
    (s) =>
      !!s.archived === archive &&
      (scope === 'all' ||
        (scope === 'loose' ? !s.projectId : s.projectId === scope)),
  );
  const running = hub.data.sessions.filter(activeSession).length;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearch((v) => !v);
      }
      if (e.key === 'Escape') {
        setSidebar(false);
        setSearch(false);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    if (search) searchInput.current?.focus();
  }, [search]);
  function navigate(next: View, services: ServiceView = {}) {
    setView(next);
    if (next === 'services') setServiceView(services);
    setSidebar(false);
    setError('');
  }
  function openSession(s: AgentSession, customizeServiceId?: string) {
    setSelectedSession(s.id);
    setChatCustomizationId(customizeServiceId);
    setScope(s.projectId || 'loose');
    setArchive(s.archived);
    setSearch(false);
    setQuery('');
    navigate('chat');
  }
  function selectProject(id: string | null) {
    setScope(id || 'loose');
    setSelectedSession(null);
    navigate('chat');
  }
  function startSession(id?: string | null) {
    setSessionService(null);
    setSessionMachine(undefined);
    setSessionProject(id === undefined ? project?.id || null : id);
    setNewSession(true);
  }
  function startServiceChat(service: HubService, customize = false) {
    setSessionProject(null);
    setSessionMachine(undefined);
    setSessionService({ service, customize });
    setNewSession(true);
  }
  function startMachineChat(machine: Machine) {
    setSessionProject(null);
    setSessionService(null);
    setSessionMachine(machine);
    setNewSession(true);
  }
  function servicesInProject(project: HubProject) {
    return hub.data.services.filter((service) => serviceProjects(
      service, [project], ws.data.servers.find((item) => item.id === service.machineId)?.platform,
    ).length > 0);
  }
  function renameChat(s: AgentSession) {
    setEdit({ kind: 'chat', id: s.id, title: s.title });
    setEditTitle(s.title);
    setModalError('');
  }
  function renameProject(p: HubProject) {
    setEdit({ kind: 'project', id: p.id, title: p.name });
    setEditTitle(p.name);
    setModalError('');
  }
  function moveChat(s: AgentSession) {
    setMove(s);
    setMoveProject(s.projectId || '');
    setModalError('');
  }
  async function archiveChat(s: AgentSession) {
    try {
      await hub.mutate(`/sessions/${s.id}`, { archived: !s.archived }, 'PATCH');
      setToast(s.archived ? 'Чат восстановлен' : 'Чат в архиве');
      if (s.id === selectedSession) setSelectedSession(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function removeFolder(p: HubProject) {
    setRemoval({ kind: 'project', id: p.id, name: p.name });
  }
  function deleteChat(s: AgentSession) {
    setRemoval({ kind: 'chat', id: s.id, name: s.title });
  }
  const contextPath = session?.cwd || project?.path;
  const scopeTitle =
    project?.name ||
    (scope === 'loose'
      ? 'Чаты без проекта'
      : archive
        ? 'Архив чатов'
        : 'Все чаты');
  const searchProjects = hub.data.projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );
  const searchChats = hub.data.sessions.filter((s) =>
    s.title.toLowerCase().includes(query.toLowerCase()),
  );
  const searchMachines = ws.data.servers.filter((m) =>
    m.name.toLowerCase().includes(query.toLowerCase()),
  );
  const searchServices = hub.data.services.filter((s) =>
    s.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="workspace-app">
      <aside className={`workspace-sidebar ${sidebar ? 'mobile-open' : ''}`}>
        <div className="brand-row">
          <button
            className="brand"
            aria-label="MayPlane — главная"
            onClick={() => {
              setSelectedSession(null);
              setScope('all');
              navigate('chat');
            }}
          >
            <span className="brand-icon">
              <Command size={19} />
            </span>
            <span>
              MayPlane<span className="brand-period">.</span>
            </span>
          </button>
          <button
            className="icon-button sidebar-close"
            aria-label="Закрыть меню"
            onClick={() => setSidebar(false)}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button
          className="new-chat-button"
          disabled={!connected}
          onClick={() => startSession()}
        >
          <SquarePen size={17} />
          Новый чат<span>+</span>
        </button>
        <button className="sidebar-search" onClick={() => setSearch(true)}>
          <Search size={15} />
          <span>Поиск по пространству</span>
          <kbd>⌃ K</kbd>
        </button>
        <nav className="main-nav" aria-label="Главная навигация">
          {(
            [
              { id: 'chat', label: 'Чаты', icon: MessageSquare },
              { id: 'projects', label: 'Проекты', icon: FolderGit2 },
              { id: 'services', label: 'Сервисы', icon: Boxes },
              { id: 'servers', label: 'Серверы', icon: Server },
            ] as const
          ).map((n) => (
            <button
              key={n.id}
              className={view === n.id ? 'active' : ''}
              onClick={() => {
                if (n.id === 'chat') {
                  setScope('all');
                  setSelectedSession(null);
                }
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
        <ProjectNavigation
          projects={hub.data.projects}
          sessions={hub.data.sessions}
          machines={ws.data.servers}
          selectedSession={selectedSession}
          scope={scope}
          archive={archive}
          disabled={!connected}
          onToggleArchive={() => {
            setArchive((v) => !v);
            setSelectedSession(null);
            navigate('chat');
          }}
          onNewProject={() => setNewProject(true)}
          onNewChat={startSession}
          onSelectProject={selectProject}
          onOpenSession={openSession}
          onRename={renameChat}
          onMove={moveChat}
          onArchive={(s) => void archiveChat(s)}
          onRenameProject={renameProject}
          onRemoveProject={removeFolder}
          onDeleteChat={deleteChat}
        />
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
              <span>Ваши машины, проекты и чаты</span>
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
                ? session
                  ? project?.name || 'Без проекта'
                  : scopeTitle
                : view === 'projects'
                  ? 'Проекты'
                  : view === 'services'
                    ? 'Сервисы'
                    : view === 'servers'
                      ? 'Серверы'
                      : 'Настройки'}
            </strong>
            {view === 'chat' && machine && (
              <span className="header-machine">
                <Monitor size={13} />
                {machine.name}
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
                <button type="button" className="icon-button workspace-header-files" aria-label="Файлы чата" title="Файлы чата"
                  disabled={!connected} onClick={() => setBrowser({ id: session.id, session: true, mode: 'files' })}>
                  <FolderOpen size={17} /><span>Файлы</span>
                </button>
                <button type="button" className="icon-button workspace-header-files" aria-label="Изменения в чате" title="Изменения в чате"
                  disabled={!connected} onClick={() => setBrowser({ id: session.id, session: true, mode: 'agent' })}>
                  <FileDiff size={17} /><span>Изменения</span>
                </button>
                <button
                  className="icon-button"
                  aria-label="Переместить чат в проект"
                  disabled={activeSession(session)}
                  onClick={() => moveChat(session)}
                >
                  <FolderInput size={16} />
                </button>
                <ChatActions
                  session={session}
                  onRename={() => renameChat(session)}
                  onMove={() => moveChat(session)}
                  onArchive={() => void archiveChat(session)}
                  onDelete={() => deleteChat(session)}
                />
                <button
                  className={`icon-button ${info ? 'is-active' : ''}`}
                  aria-label="Информация о чате"
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
            <button aria-label="Закрыть ошибку" onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        )}
        <div
          className={`workspace-content ${info && view === 'chat' && session ? 'with-info' : ''}`}
        >
          {view === 'servers' ? (
            <MachinesPanel
              onAccounts={() => setView('settings')}
              ws={ws}
              hub={hub}
              selectedId={selectedMachine}
              onSelect={setSelectedMachine}
              onAdd={(s) => setServerForm(s || 'new')}
              onPair={() => setPair(true)}
              onNewChat={startMachineChat}
              onServices={(machineId) => navigate('services', { machineId })}
              onRemove={(m) =>
                setRemoval({ kind: 'machine', id: m.id, name: m.name })
              }
            />
          ) : view === 'settings' ? (
            <SettingsPanel ws={ws} hub={hub} />
          ) : view === 'services' ? (
            <ServicesPanel
              key={JSON.stringify(serviceView)}
              hub={hub}
              machines={ws.data.servers}
              scope={serviceView}
              onProject={selectProject}
              onOpenChat={openSession}
              onNewChat={startServiceChat}
              connected={connected}
              onMachine={(id) => {
                setSelectedMachine(id);
                navigate('servers');
              }}
              onRemove={(s) =>
                setRemoval({ kind: 'service', id: s.id, name: s.name })
              }
            />
          ) : view === 'projects' ? (
            <div className="hub-page projects-page">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">РАБОЧИЕ ПАПКИ АГЕНТОВ</span>
                  <h1>
                    Проекты
                    <span className="heading-count">
                      {hub.data.projects.length}
                    </span>
                  </h1>
                  <p>
                    Одна папка на машине — общий контекст для чатов Codex и
                    OpenCode.
                  </p>
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
                  {hub.data.projects.map((p) => (
                    <article className="project-card" key={p.id}>
                      <div className="project-card-heading">
                        <span className="project-icon">
                          <FolderGit2 size={22} />
                        </span>
                        <span className="connection-pill">
                          <Monitor size={12} />
                          {
                            ws.data.servers.find((m) => m.id === p.machineId)
                              ?.name
                          }
                        </span>
                      </div>
                      <h2>{p.name}</h2>
                      <div className="project-path">
                        <code>{p.path}</code>
                        <CopyButton value={p.path} />
                      </div>
                      <p className="project-dialogs">
                        <MessageSquare size={14} />
                        {
                          hub.data.sessions.filter(
                            (s) => s.projectId === p.id && !s.archived,
                          ).length
                        }{' '}
                        чатов
                      </p>
                      <button
                        type="button"
                        className="text-button project-service-link"
                        onClick={() => navigate('services', { projectId: p.id })}
                      >
                        <Boxes size={14} /> Сервисы
                        <span>{servicesInProject(p).length}</span>
                      </button>
                      <footer>
                        <button
                          className="hub-button"
                          onClick={() => selectProject(p.id)}
                        >
                          Открыть чаты
                          <ChevronRight size={14} />
                        </button>
                        <button type="button" className="icon-button" title="Файлы и Git" aria-label={`Файлы проекта ${p.name}`}
                          disabled={!connected} onClick={() => setBrowser({ id: p.id, session: false, mode: 'files' })}>
                          <FolderOpen size={16} />
                        </button>
                        <button
                          className="icon-button"
                          title="Переименовать проект"
                          aria-label={`Переименовать проект ${p.name}`}
                          onClick={() => renameProject(p)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button"
                          title="Удалить проект"
                          aria-label={`Удалить проект ${p.name}`}
                          onClick={() => removeFolder(p)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </footer>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">
                    <FolderGit2 size={30} />
                  </div>
                  <h2>Добавьте рабочую папку</h2>
                  <p>
                    У проекта будут свои чаты с любыми агентами.
                  </p>
                  <button
                    className="hub-button primary"
                    disabled={!connected}
                    onClick={() => setNewProject(true)}
                  >
                    <Plus size={16} />
                    Добавить проект
                  </button>
                  <button
                    className="text-button"
                    disabled={!connected}
                    onClick={() => startSession(null)}
                  >
                    Начать чат без проекта
                  </button>
                </div>
              )}
            </div>
          ) : session ? (
            <AgentChat
              key={session.id}
              session={session}
              project={project}
              machine={machine}
              machines={ws.data.servers}
              initialCustomizeServiceId={chatCustomizationId}
              hub={hub}
              onNewProject={() => setNewProject(true)}
              onNewSession={() => startSession()}
              onAccounts={() => setView('settings')}
              onOpenService={(serviceId) => navigate('services', { serviceId })}
              onOpenChanges={(turn) => setBrowser({ id: session.id, session: true, mode: 'agent', turn })}
              disabled={!connected}
            />
          ) : (
            <div className="hub-page chat-home">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {project ? 'РАБОЧАЯ ПАПКА' : 'РАБОЧЕЕ ПРОСТРАНСТВО'}
                  </span>
                  <h1>
                    {scopeTitle}
                    <span className="heading-count">{visible.length}</span>
                  </h1>
                  {project ? (
                    <p className="context-path">
                      <Monitor size={12} />
                      {machine?.name} · <code>{project.path}</code>
                      <CopyButton value={project.path} />
                    </p>
                  ) : (
                    <p>
                      {archive
                        ? 'История сохранена. Восстановите чат, чтобы продолжить.'
                        : 'Начните новый чат или продолжите работу.'}
                    </p>
                  )}
                </div>
                <div className="heading-actions">
                  {project && (
                    <button type="button" className="hub-button" disabled={!connected}
                      onClick={() => setBrowser({ id: project.id, session: false, mode: 'files' })}>
                      <FolderOpen size={16} /> Файлы и Git
                    </button>
                  )}
                  {project && (
                    <button
                      className="hub-button"
                      onClick={() => renameProject(project)}
                    >
                      <Pencil size={14} />
                      Переименовать
                    </button>
                  )}
                  <button
                    className="hub-button"
                    disabled={!connected || !ws.data.servers.length}
                    onClick={() => setImportSession(true)}
                  >
                    <Monitor size={15} />
                    Продолжить с компьютера
                  </button>
                  <button
                    className="hub-button primary"
                    disabled={!connected}
                    onClick={() => startSession()}
                  >
                    <Plus size={16} />
                    Новый чат
                  </button>
                </div>
              </div>
              {project && (
                <ProjectServices
                  services={servicesInProject(project)}
                  machines={ws.data.servers}
                  disabled={!connected}
                  onOpen={(serviceId) => navigate('services', { projectId: project.id, serviceId })}
                  onAdd={() => navigate('services', { projectId: project.id, create: true })}
                  onAll={() => navigate('services', { projectId: project.id })}
                />
              )}
              {visible.length ? (
                <div className="chat-home-list">
                  {visible.map((s) => (
                    <article key={s.id} className="chat-list-row">
                      <button onClick={() => openSession(s)}>
                        <i className={`session-dot ${s.status}`} />
                        <span>
                          <strong>{s.title}</strong>
                          <small>
                            {providerNames[s.provider]} ·{' '}
                            {hub.data.projects.find((p) => p.id === s.projectId)
                              ?.name || 'Без проекта'}{' '}
                            ·{' '}
                            {
                              ws.data.servers.find((m) => m.id === s.machineId)
                                ?.name
                            }
                          </small>
                        </span>
                        <time>
                          {new Date(s.updatedAt).toLocaleDateString('ru', {
                            day: 'numeric',
                            month: 'short',
                          })}
                        </time>
                      </button>
                      <ChatActions
                        session={s}
                        onRename={() => renameChat(s)}
                        onMove={() => moveChat(s)}
                        onArchive={() => void archiveChat(s)}
                        onDelete={() => deleteChat(s)}
                      />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">
                    <MessageSquare size={30} />
                  </div>
                  <h2>
                    {project
                      ? 'Первый чат в проекте'
                      : archive
                        ? 'В архиве пусто'
                        : 'С чего начнём?'}
                  </h2>
                  <p>
                    {project
                      ? 'Агент будет работать в папке этого проекта.'
                      : 'Для обычного чата проект создавать не обязательно.'}
                  </p>
                  <button
                    className="hub-button primary"
                    disabled={!connected}
                    onClick={() => startSession()}
                  >
                    <SquarePen size={16} />
                    Начать чат
                  </button>
                  {!project && (
                    <button
                      className="text-button"
                      disabled={!connected}
                      onClick={() => setNewProject(true)}
                    >
                      Добавить рабочую папку проекта
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {info && view === 'chat' && session && (
            <aside className="project-inspector">
              <div className="inspector-heading">
                <h2>Контекст чата</h2>
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
              <h3>{project?.name || 'Без проекта'}</h3>
              <div className="inspector-field">
                <span>Машина</span>
                <button
                  className="text-button"
                  onClick={() => {
                    setSelectedMachine(session.machineId);
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
                  <code>{contextPath}</code>
                  {contextPath && <CopyButton value={contextPath} />}
                </div>
              </div>
              <div className="inspector-field">
                <span>Агент</span>
                <strong>{providerNames[session.provider]}</strong>
              </div>
              <div className="inspector-field">
                <span>Доступ</span>
                <p>
                  <ShieldCheck size={14} />
                  {session.mode === 'read-only'
                    ? 'Только чтение'
                    : 'Дополнительные права по запросу'}
                </p>
              </div>
              <button
                className="hub-button"
                disabled={activeSession(session)}
                onClick={() => moveChat(session)}
              >
                <FolderInput size={14} />
                Изменить проект
              </button>
              <p className="inspector-note">
                Проект определяет рабочую папку. Для переноса на другую машину
                создайте новый чат.
              </p>
            </aside>
          )}
        </div>
      </main>
      {browser && (browser.session ? browserChat : browserProject) && (
        <WorkspaceBrowser key={`${browser.id}:${browserChat?.cwd || browserProject?.path || ''}`} api={hub.api}
          id={browser.id} session={browser.session} title={browserChat?.title || browserProject?.name || 'Рабочая папка'}
          path={browserChat?.cwd || browserProject?.path} active={activeSession(browserChat)}
          machineName={ws.data.servers.find((m) => m.id === browserMachineId)?.name}
          initialMode={browser.mode} initialTurn={browser.turn} onClose={() => setBrowser(null)} />
      )}
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
            selectProject(p.id);
            setToast('Проект добавлен');
          }}
        />
      )}
      {newSession && (
        <NewSession
          hub={hub}
          projects={hub.data.projects}
          machines={ws.data.servers}
          initialProject={sessionProject || undefined}
          initialMachine={sessionMachine}
          service={sessionService?.service}
          onClose={() => setNewSession(false)}
          onAccounts={() => {
            setNewSession(false);
            setView('settings');
          }}
          onCreated={(s) => {
            setNewSession(false);
            openSession(s, sessionService?.customize ? sessionService.service.id : undefined);
          }}
        />
      )}
      {importSession && (
        <NativeSessionImport
          hub={hub}
          machines={ws.data.servers}
          onClose={() => setImportSession(false)}
          onOpened={(s) => {
            setImportSession(false);
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
      {edit && (
        <Modal
          title={
            edit.kind === 'chat' ? 'Переименовать чат' : 'Переименовать проект'
          }
          onClose={() => setEdit(null)}
        >
          <form
            className="hub-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setModalBusy(true);
              setModalError('');
              try {
                await hub.mutate(
                  edit.kind === 'chat'
                    ? `/sessions/${edit.id}`
                    : `/projects/${edit.id}`,
                  edit.kind === 'chat'
                    ? { title: editTitle }
                    : { name: editTitle },
                  'PATCH',
                );
                setEdit(null);
              } catch (e) {
                setModalError((e as Error).message);
              } finally {
                setModalBusy(false);
              }
            }}
          >
            <Field label="Название">
              <input
                autoFocus
                required
                maxLength={edit.kind === 'chat' ? 100 : 80}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </Field>
            <ErrorText error={modalError} />
            <Submit busy={modalBusy}>Сохранить</Submit>
          </form>
        </Modal>
      )}
      {move && (
        <Modal
          title="Изменить проект чата"
          description="История и агент сохранятся. Проект можно выбрать только на той же машине."
          onClose={() => setMove(null)}
        >
          <form
            className="hub-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setModalBusy(true);
              setModalError('');
              try {
                const next = await hub.mutate<AgentSession>(
                  `/sessions/${move.id}`,
                  { projectId: moveProject || null },
                  'PATCH',
                );
                setMove(null);
                openSession(next);
                setToast('Проект чата изменён');
              } catch (e) {
                setModalError((e as Error).message);
              } finally {
                setModalBusy(false);
              }
            }}
          >
            <Field label="Проект">
              <select
                aria-label="Проект"
                value={moveProject}
                onChange={(e) => setMoveProject(e.target.value)}
              >
                <option value="">Без проекта</option>
                {hub.data.projects
                  .filter((p) => p.machineId === move.machineId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.path}
                    </option>
                  ))}
              </select>
            </Field>
            <p className="hub-note">
              {moveProject
                ? 'Следующие сообщения будут выполняться в папке выбранного проекта.'
                : 'Чат останется в текущей рабочей папке и переместится в «Без проекта».'}
            </p>
            <ErrorText error={modalError} />
            <Submit busy={modalBusy}>Переместить чат</Submit>
          </form>
        </Modal>
      )}
      {removal && (
        <RemoveObject
          key={`${removal.kind}/${removal.id}`}
          target={removal}
          ws={ws}
          hub={hub}
          onClose={() => setRemoval(null)}
          onRemoved={(result) => {
            setRemoval(null);
            if (
              selectedSession &&
              result.deletedChats.includes(selectedSession)
            )
              setSelectedSession(null);
            if (result.deletedProjects.includes(scope)) setScope('loose');
            if (
              selectedMachine &&
              result.deletedMachines.includes(selectedMachine)
            )
              setSelectedMachine(null);
            setToast('Удалено из панели');
          }}
        />
      )}
      {search && (
        <Modal
          title="Поиск"
          description="Проекты, чаты, сервисы и машины"
          onClose={() => setSearch(false)}
        >
          <div className="command-search">
            <Search size={18} />
            <input
              ref={searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по рабочему пространству…"
              aria-label="Поиск"
            />
          </div>
          <div className="search-results">
            {searchProjects.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setSearch(false);
                  selectProject(p.id);
                }}
              >
                <FolderGit2 size={17} />
                <span>{p.name}</span>
                <small>Проект</small>
              </button>
            ))}
            {searchChats.map((s) => (
              <button key={s.id} onClick={() => openSession(s)}>
                <MessageSquare size={17} />
                <span>{s.title}</span>
                <small>
                  {s.archived ? 'Архив' : providerNames[s.provider]}
                </small>
              </button>
            ))}
            {searchMachines.map((m) => (
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
            {searchServices.map((s) => (
              <button key={s.id} onClick={() => {
                setSearch(false);
                setQuery('');
                navigate('services', { serviceId: s.id });
              }}>
                <Boxes size={17} />
                <span>{s.name}</span>
                <small>Сервис</small>
              </button>
            ))}
            {!searchProjects.length &&
              !searchChats.length &&
              !searchMachines.length &&
              !searchServices.length && (
                <p className="muted">Ничего не найдено</p>
              )}
          </div>
        </Modal>
      )}
      <Toast message={toast} onClose={closeToast} />
    </div>
  );
}
