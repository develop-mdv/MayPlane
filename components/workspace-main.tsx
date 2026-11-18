'use client';
import { WorkspaceSelect } from './workspace-select';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  ChevronRight,
  FileDiff,
  FolderGit2,
  FolderInput,
  FolderOpen,
  Menu,
  MessageSquare,
  Monitor,
  Pencil,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SquarePen,
  LoaderCircle,
  X,
} from 'lucide-react';
import { Dialog as Drawer } from '@base-ui/react/dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePanelAuth } from './panel-auth';
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
import {
  NewProject,
  SettingsPanel,
  type SettingsSection,
} from './workspace-forms';
import { MachinesPanel, PairComputer, ServerForm } from './machines-panel';
import {
  ProjectNavigation,
  ProjectActions,
  ChatActions,
} from './project-navigation';
import {
  ProjectServices,
  ServicesPanel,
  type ServiceView,
} from './services-panel';
import { MachineChats, type MachineChatSource } from './machine-chats';
import { CopyButton, ErrorText, Field, Modal, Submit, Toast } from './hub-ui';
import { RemoveObject } from './remove-object';
import { WorkspaceBrowser } from './workspace-browser';
import type { WorkspaceMode } from '@/lib/workspace-files';

type View = 'chat' | 'projects' | 'services' | 'servers' | 'settings';
type ChatTab = 'panel' | 'machine';
const sections = [
  { id: 'chat', label: 'Чаты', icon: MessageSquare },
  { id: 'projects', label: 'Проекты', icon: FolderGit2 },
  { id: 'services', label: 'Сервисы', icon: Boxes },
  { id: 'servers', label: 'Серверы', icon: Server },
] as const;
const chatPlural = new Intl.PluralRules('ru');
function chatCount(count: number) {
  const form = chatPlural.select(count);
  return `${count} ${form === 'one' ? 'чат' : form === 'few' ? 'чата' : 'чатов'}`;
}
export default function WorkspaceMain() {
  const ws = useWorkspace(),
    hub = useHub(ws);
  const [view, setView] = useState<View>('chat'),
    [selectedSession, setSelectedSession] = useState<string | null>(null),
    [selectedMachine, setSelectedMachine] = useState<string | null>(null),
    [scope, setScope] = useState('all');
  const mobile = useIsMobile();
  const shellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const { session: owner } = usePanelAuth();
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>('accounts');
  const listOrigin = useRef({
    scope: 'all',
    archive: false,
    tab: 'panel' as ChatTab,
  });
  const [chatTab, setChatTab] = useState<ChatTab>('panel');
  const [machineChatSource, setMachineChatSource] = useState<MachineChatSource>(
    { provider: 'codex' },
  );
  const [serviceRoute, setServiceRoute] = useState({
    scope: {} as ServiceView,
    visit: 0,
  });
  const [sessionService, setSessionService] = useState<{
    service: HubService;
    customize: boolean;
  } | null>(null);
  const [sessionMachine, setSessionMachine] = useState<Machine | undefined>();
  const [chatCustomizationId, setChatCustomizationId] = useState<string>();
  const [newProject, setNewProject] = useState(false),
    [newSession, setNewSession] = useState(false),
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
  const [browser, setBrowser] = useState<{
    id: string;
    session: boolean;
    mode: WorkspaceMode;
    turn?: string;
  } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const session = hub.data.sessions.find((s) => s.id === selectedSession);
  const project = hub.data.projects.find(
    (p) => p.id === (session ? session.projectId : scope),
  );
  const machine = ws.data.servers.find(
    (m) => m.id === (session?.machineId || project?.machineId),
  );
  const browserChat = browser?.session
    ? hub.data.sessions.find((s) => s.id === browser.id)
    : undefined;
  const browserProject = browser
    ? hub.data.projects.find(
        (p) => p.id === (browser.session ? browserChat?.projectId : browser.id),
      )
    : undefined;
  const browserMachineId = browserChat?.machineId || browserProject?.machineId;
  const connected = !!ws.connection && !ws.error;
  const inConversation = view === 'chat' && !!session;
  const sectionName =
    sections.find((item) => item.id === view)?.label || 'Настройки';
  const ownerName = owner.user?.username || 'Владелец';
  const listLoading =
    ws.initializing || (connected && !hub.ready && !hub.error);
  const closeToast = useCallback(() => setToast(''), []);
  const allChats = scope === 'all' && !archive;
  const showMachineChats = allChats && chatTab === 'machine';
  const visible = hub.data.sessions.filter(
    (s) =>
      !!s.archived === archive &&
      (scope === 'all' ||
        (scope === 'loose' ? !s.projectId : s.projectId === scope)),
  );
  const running = hub.data.sessions.filter(activeSession).length;
  const showCreateChat =
    view === 'chat' &&
    !session &&
    !archive &&
    (visible.length > 0 || showMachineChats);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.code === 'KeyK' || e.key.toLowerCase() === 'k')
      ) {
        if (document.querySelector('[role="dialog"]') && !search) return;
        e.preventDefault();
        setSidebar(false);
        setQuery('');
        setSearch((value) => !value);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [search]);
  useEffect(() => {
    if (search) searchInput.current?.focus();
  }, [search]);
  function navigate(next: View, services: ServiceView = {}) {
    setView(next);
    setInfo(false);
    if (next === 'services')
      setServiceRoute(({ visit }) => ({ scope: services, visit: visit + 1 }));
    setSidebar(false);
    setError('');
  }
  function focusSearchResult(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const button = event.currentTarget;
    const next =
      event.key === 'ArrowDown'
        ? button.nextElementSibling
        : button.previousElementSibling;
    if (next instanceof HTMLButtonElement) next.focus();
    else if (event.key === 'ArrowUp') searchInput.current?.focus();
  }
  function openSearch() {
    setSidebar(false);
    setQuery('');
    setSearch(true);
  }
  function openAccounts() {
    setSettingsSection('accounts');
    navigate('settings');
  }
  function openSection(next: View) {
    if (next === 'chat') return openChatList();
    if (next === 'servers') setSelectedMachine(null);
    navigate(next);
  }
  function backToChats() {
    const origin = listOrigin.current;
    setScope(origin.scope);
    setArchive(origin.archive);
    setChatTab(origin.tab);
    setSelectedSession(null);
    navigate('chat');
  }
  function openChatList(tab: ChatTab = 'panel') {
    setScope('all');
    setArchive(false);
    setSelectedSession(null);
    setChatTab(tab);
    navigate('chat');
  }
  function openSession(
    s: AgentSession,
    customizeServiceId?: string,
    tab: ChatTab = 'panel',
  ) {
    listOrigin.current =
      tab === 'machine'
        ? { scope: 'all', archive: false, tab }
        : view === 'chat' && !session
          ? { scope, archive, tab: chatTab }
          : { scope: s.projectId || 'all', archive: s.archived, tab: 'panel' };
    setSelectedSession(s.id);
    setChatCustomizationId(customizeServiceId);
    setChatTab(tab);
    setScope(s.projectId || 'loose');
    setArchive(s.archived);
    setSearch(false);
    setQuery('');
    navigate('chat');
  }
  function selectProject(id: string | null, archived = false) {
    setArchive(archived);
    setScope(id || 'loose');
    setSelectedSession(null);
    setChatTab('panel');
    navigate('chat');
  }
  function startSession(id?: string | null) {
    setSidebar(false);
    setSessionService(null);
    setSessionMachine(undefined);
    setSessionProject(
      id === undefined ? (view === 'chat' ? project?.id || null : null) : id,
    );
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
    return hub.data.services.filter(
      (service) =>
        serviceProjects(
          service,
          [project],
          ws.data.servers.find((item) => item.id === service.machineId)
            ?.platform,
        ).length > 0,
    );
  }
  function renameChat(s: AgentSession) {
    setSidebar(false);
    setEdit({ kind: 'chat', id: s.id, title: s.title });
    setEditTitle(s.title);
    setModalError('');
  }
  function renameProject(p: HubProject) {
    setSidebar(false);
    setEdit({ kind: 'project', id: p.id, title: p.name });
    setEditTitle(p.name);
    setModalError('');
  }
  function moveChat(s: AgentSession) {
    setSidebar(false);
    setInfo(false);
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
    setSidebar(false);
    setRemoval({ kind: 'project', id: p.id, name: p.name });
  }
  function deleteChat(s: AgentSession) {
    setSidebar(false);
    setRemoval({ kind: 'chat', id: s.id, name: s.title });
  }
  const contextPath = session?.cwd || project?.path;
  const scopeTitle =
    (archive && project ? `Архив · ${project.name}` : project?.name) ||
    (scope === 'loose' ? 'Чаты без проекта' : archive ? 'Архив чатов' : 'Чаты');
  const searchTerm = query.trim().toLocaleLowerCase('ru');
  const searchProjects = hub.data.projects.filter((p) =>
    p.name.toLocaleLowerCase('ru').includes(searchTerm),
  );
  const searchChats = hub.data.sessions.filter((s) =>
    s.title.toLocaleLowerCase('ru').includes(searchTerm),
  );
  const searchMachines = ws.data.servers.filter((m) =>
    m.name.toLocaleLowerCase('ru').includes(searchTerm),
  );
  const searchServices = hub.data.services.filter((s) =>
    s.name.toLocaleLowerCase('ru').includes(searchTerm),
  );
  const inspectorBody =
    info && session ? (
      <>
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
      </>
    ) : null;
  const sidebarContents = (
    <>
      <div className="brand-row">
        <button
          className="brand"
          aria-label="MayPlane — главная"
          onClick={() => openChatList()}
        >
          <span className="workspace-brand-mark" aria-hidden="true" />
          <span>
            MayPlane<span className="brand-period">.</span>
          </span>
        </button>
        <button
          className="icon-button sidebar-close"
          aria-label="Закрыть меню"
          onClick={() => setSidebar(false)}
        >
          <X size={18} />
        </button>
      </div>
      <button
        className={`new-chat-button${showCreateChat ? ' is-primary' : ''}`}
        disabled={!connected}
        onClick={() => startSession()}
      >
        <SquarePen size={17} />
        Новый чат
      </button>
      {!mobile && (
        <nav className="main-nav" aria-label="Главная навигация">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={view === id ? 'active' : ''}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => openSection(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === 'servers' && <small>{ws.data.servers.length}</small>}
              {id === 'chat' && running > 0 && (
                <span className="running-count" title="Активные чаты">
                  {running}
                </span>
              )}
            </button>
          ))}
        </nav>
      )}
      <ProjectNavigation
        projects={hub.data.projects}
        sessions={hub.data.sessions}
        machines={ws.data.servers}
        selectedSession={view === 'chat' ? selectedSession : null}
        scope={view === 'chat' ? scope : ''}
        archive={archive}
        disabled={!connected}
        onToggleArchive={() => {
          setScope('all');
          setArchive((v) => !v);
          setSelectedSession(null);
          navigate('chat');
        }}
        onNewProject={() => {
          setSidebar(false);
          setNewProject(true);
        }}
        onNewChat={startSession}
        onSelectProject={(id) => selectProject(id, archive)}
        onOpenSession={openSession}
        onRename={renameChat}
        onMove={moveChat}
        onArchive={(s) => void archiveChat(s)}
        onRenameProject={renameProject}
        onRemoveProject={removeFolder}
        onDeleteChat={deleteChat}
      />
      <div className="sidebar-bottom">
        <button
          className={`workspace-owner ${view === 'settings' ? 'active' : ''}`}
          aria-label="Настройки"
          aria-current={view === 'settings' ? 'page' : undefined}
          onClick={() => navigate('settings')}
        >
          <span className="owner-avatar" aria-hidden="true">
            {ownerName.slice(0, 1).toLocaleUpperCase('ru')}
          </span>
          <span className="owner-summary">
            <strong>{ownerName}</strong>
            <small>
              <i className={connected ? 'live-dot' : 'offline-dot'} />
              {ws.initializing
                ? 'Подключение…'
                : connected
                  ? 'Панель на связи'
                  : 'Нет подключения'}
            </small>
          </span>
          <Settings2 size={17} />
        </button>
      </div>
    </>
  );
  return (
    <div className="workspace-app" ref={shellRef}>
      {mobile ? (
        <Drawer.Root open={sidebar} onOpenChange={setSidebar}>
          <Drawer.Portal container={shellRef}>
            <Drawer.Backdrop className="sidebar-scrim" />
            <Drawer.Popup
              className="workspace-sidebar mobile-open"
              finalFocus={menuRef}
            >
              <Drawer.Title className="sr-only">
                Меню рабочего пространства
              </Drawer.Title>
              {sidebarContents}
            </Drawer.Popup>
          </Drawer.Portal>
        </Drawer.Root>
      ) : (
        <aside className="workspace-sidebar">{sidebarContents}</aside>
      )}
      <main className="workspace-main">
        <header className="workspace-header">
          <div className="header-breadcrumb">
            {inConversation ? (
              <button
                type="button"
                className="icon-button chat-back"
                aria-label="Вернуться к списку чатов"
                title="К списку чатов"
                onClick={backToChats}
              >
                <ArrowLeft size={18} />
              </button>
            ) : (
              <button
                ref={menuRef}
                className="icon-button mobile-menu"
                aria-label="Открыть меню"
                aria-expanded={sidebar}
                aria-haspopup="dialog"
                onClick={() => setSidebar(true)}
              >
                <Menu size={20} />
              </button>
            )}
            <span className="breadcrumb-home">
              {inConversation
                ? project?.name || 'Чаты'
                : 'Рабочее пространство'}
            </span>
            <ChevronRight size={13} aria-hidden="true" />
            {inConversation ? (
              <h1 className="conversation-title" title={session.title}>
                {session.title}
              </h1>
            ) : (
              <strong className="section-crumb">
                {mobile
                  ? 'MayPlane'
                  : view === 'chat'
                    ? scopeTitle
                    : sectionName}
              </strong>
            )}
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
                <button
                  type="button"
                  className="icon-button workspace-header-files"
                  aria-label="Файлы чата"
                  title="Файлы чата"
                  disabled={!connected}
                  onClick={() =>
                    setBrowser({ id: session.id, session: true, mode: 'files' })
                  }
                >
                  <FolderOpen size={17} />
                  <span>Файлы</span>
                </button>
                {!mobile && (
                  <button
                    type="button"
                    className="icon-button workspace-header-files"
                    aria-label="Изменения в чате"
                    title="Изменения в чате"
                    disabled={!connected}
                    onClick={() =>
                      setBrowser({
                        id: session.id,
                        session: true,
                        mode: 'agent',
                      })
                    }
                  >
                    <FileDiff size={17} />
                    <span>Изменения</span>
                  </button>
                )}
                <ChatActions
                  session={session}
                  onInfo={() => setInfo(true)}
                  onChanges={
                    mobile && connected
                      ? () =>
                          setBrowser({
                            id: session.id,
                            session: true,
                            mode: 'agent',
                          })
                      : undefined
                  }
                  onRename={() => renameChat(session)}
                  onMove={() => moveChat(session)}
                  onArchive={() => void archiveChat(session)}
                  onDelete={() => deleteChat(session)}
                />
              </>
            ) : (
              <button
                type="button"
                className="workspace-search"
                aria-label="Поиск по пространству"
                aria-keyshortcuts="Control+K Meta+K"
                title="Поиск по пространству (Ctrl или ⌘ + K)"
                onClick={openSearch}
              >
                <Search size={16} />
                <span>Поиск по пространству</span>
                <kbd>Ctrl / ⌘ K</kbd>
              </button>
            )}
          </div>
        </header>
        {(ws.error || hub.error) && (
          <div className="connection-banner" role="alert">
            <Activity size={16} />
            <span>{ws.error || hub.error}</span>
            <button
              onClick={() => {
                if (ws.error)
                  void ws
                    .connect('', '')
                    .catch((reason: Error) => setError(reason.message));
                else
                  void hub
                    .refresh()
                    .catch((reason: Error) => setError(reason.message));
              }}
            >
              Повторить <ArrowUpRight size={13} />
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
          {listLoading && view !== 'settings' ? (
            <output className="workspace-loading">
              <LoaderCircle className="spin" size={19} /> Загружаем рабочее
              пространство…
            </output>
          ) : view === 'servers' ? (
            <MachinesPanel
              onAccounts={openAccounts}
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
            <SettingsPanel
              ws={ws}
              hub={hub}
              section={settingsSection}
              onSection={setSettingsSection}
            />
          ) : view === 'services' ? (
            <ServicesPanel
              key={serviceRoute.visit}
              hub={hub}
              machines={ws.data.servers}
              scope={serviceRoute.scope}
              onProject={selectProject}
              onMachines={() => openSection('servers')}
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
                  <h1>
                    Проекты
                    <span className="heading-count">
                      {hub.data.projects.length}
                    </span>
                  </h1>
                </div>
                {hub.data.projects.length > 0 && (
                  <button
                    className="hub-button primary"
                    disabled={!connected}
                    onClick={() => setNewProject(true)}
                  >
                    <Plus size={16} />
                    Добавить проект
                  </button>
                )}
              </div>
              {hub.data.projects.length ? (
                <div className="projects-grid">
                  {hub.data.projects.map((p) => (
                    <article className="project-card" key={p.id}>
                      <div className="project-card-heading">
                        <span className="project-icon">
                          <FolderGit2 size={22} />
                        </span>
                        <h2>{p.name}</h2>
                        <span className="connection-pill">
                          <Monitor size={12} />
                          {
                            ws.data.servers.find((m) => m.id === p.machineId)
                              ?.name
                          }
                        </span>
                      </div>
                      <div className="project-path">
                        <code>{p.path}</code>
                        <CopyButton value={p.path} />
                      </div>
                      <div className="project-links">
                        <span className="project-dialogs">
                          <MessageSquare size={14} />
                          {chatCount(
                            hub.data.sessions.filter(
                              (s) => s.projectId === p.id && !s.archived,
                            ).length,
                          )}
                        </span>
                        <button
                          type="button"
                          className="text-button project-service-link"
                          onClick={() =>
                            navigate('services', { projectId: p.id })
                          }
                        >
                          <Boxes size={14} /> Сервисы
                          <span>{servicesInProject(p).length}</span>
                        </button>
                        {/^https:\/\//i.test(p.repo) && (
                          <a
                            className="text-button project-repo"
                            href={p.repo}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Репозиторий <ArrowUpRight size={14} />
                          </a>
                        )}
                      </div>
                      <footer>
                        <button
                          className="hub-button"
                          onClick={() => selectProject(p.id)}
                        >
                          Открыть чаты
                          <ChevronRight size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title="Файлы и Git"
                          aria-label={`Файлы проекта ${p.name}`}
                          disabled={!connected}
                          onClick={() =>
                            setBrowser({
                              id: p.id,
                              session: false,
                              mode: 'files',
                            })
                          }
                        >
                          <FolderOpen size={16} />
                        </button>
                        <ProjectActions
                          project={p}
                          onRename={() => renameProject(p)}
                          onRemove={() => removeFolder(p)}
                        />
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
                  <p>У проекта будут свои чаты с любыми агентами.</p>
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
              onAccounts={openAccounts}
              onOpenService={(serviceId) => navigate('services', { serviceId })}
              onOpenChanges={(turn) =>
                setBrowser({
                  id: session.id,
                  session: true,
                  mode: 'agent',
                  turn,
                })
              }
              disabled={!connected}
            />
          ) : (
            <div className="hub-page chat-home" key={scope + String(archive)}>
              <div className="page-heading">
                <div>
                  <h1>
                    {scopeTitle}
                    {!showMachineChats && (
                      <span className="heading-count">{visible.length}</span>
                    )}
                  </h1>
                  {project ? (
                    <p className="context-path">
                      <Monitor size={12} />
                      {machine?.name} · <code>{project.path}</code>
                      <CopyButton value={project.path} />
                    </p>
                  ) : archive && visible.length > 0 ? (
                    <p>Восстановите чат, чтобы продолжить диалог.</p>
                  ) : null}
                </div>
                <div className="heading-actions">
                  {project && (
                    <button
                      type="button"
                      className="hub-button"
                      disabled={!connected}
                      onClick={() =>
                        setBrowser({
                          id: project.id,
                          session: false,
                          mode: 'files',
                        })
                      }
                    >
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
                  {mobile && showCreateChat && (
                    <button
                      className="hub-button primary"
                      disabled={!connected}
                      onClick={() => startSession()}
                    >
                      <Plus size={16} /> Новый чат
                    </button>
                  )}
                </div>
              </div>
              {project && (
                <ProjectServices
                  services={servicesInProject(project)}
                  machines={ws.data.servers}
                  disabled={!connected}
                  onOpen={(serviceId) =>
                    navigate('services', { projectId: project.id, serviceId })
                  }
                  onAdd={() =>
                    navigate('services', {
                      projectId: project.id,
                      create: true,
                    })
                  }
                  onAll={() => navigate('services', { projectId: project.id })}
                />
              )}
              {allChats && (
                <fieldset className="chat-source-bar">
                  <legend className="sr-only">Источник чатов</legend>
                  <button
                    type="button"
                    aria-pressed={chatTab === 'panel'}
                    onClick={() => setChatTab('panel')}
                  >
                    В панели
                  </button>
                  <button
                    type="button"
                    aria-pressed={chatTab === 'machine'}
                    onClick={() => setChatTab('machine')}
                  >
                    <Monitor size={15} aria-hidden="true" /> На машинах
                  </button>
                </fieldset>
              )}
              {showMachineChats ? (
                <MachineChats
                  hub={hub}
                  machines={ws.data.servers}
                  source={machineChatSource}
                  disabled={!connected}
                  onSourceChange={setMachineChatSource}
                  onConnect={() => setPair(true)}
                  onOpened={(s) => openSession(s, undefined, 'machine')}
                />
              ) : visible.length ? (
                <div className="chat-home-list">
                  {visible.map((s) => (
                    <article key={s.id} className="chat-list-row">
                      <button onClick={() => openSession(s)}>
                        <span
                          className={`chat-row-icon ${s.status}`}
                          aria-hidden="true"
                        >
                          <MessageSquare size={18} />
                        </span>
                        <span className="chat-row-copy">
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
                        {s.status !== 'idle' && (
                          <span className={`row-status ${s.status}`}>
                            {sessionLabels[s.status]}
                          </span>
                        )}
                        <time
                          dateTime={s.updatedAt}
                          title={new Date(s.updatedAt).toLocaleString('ru')}
                        >
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
                    {archive
                      ? 'В архиве пусто'
                      : project
                        ? 'Первый чат в проекте'
                        : 'Начните первый чат'}
                  </h2>
                  <p>
                    {archive
                      ? 'Здесь появятся чаты, которые вы отправите в архив.'
                      : project
                        ? 'Агент будет работать в папке этого проекта.'
                        : 'Для обычного чата проект создавать не обязательно.'}
                  </p>
                  <button
                    className="hub-button primary"
                    disabled={!connected}
                    onClick={() => (archive ? openChatList() : startSession())}
                  >
                    {archive ? (
                      <ArrowLeft size={16} />
                    ) : (
                      <SquarePen size={16} />
                    )}
                    {archive ? 'К списку чатов' : 'Начать чат'}
                  </button>
                  {!project && !archive && (
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
          {info &&
            inConversation &&
            (mobile ? (
              <Modal title="Контекст чата" onClose={() => setInfo(false)}>
                <div className="project-inspector inspector-dialog">
                  {inspectorBody}
                </div>
              </Modal>
            ) : (
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
                {inspectorBody}
              </aside>
            ))}
        </div>
        {!inConversation && (
          <nav className="mobile-sections" aria-label="Разделы пространства">
            {[
              ...sections,
              { id: 'settings', label: 'Настройки', icon: Settings2 } as const,
            ].map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-current={view === id ? 'page' : undefined}
                onClick={() => openSection(id)}
              >
                <Icon size={19} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}
      </main>
      {browser && (browser.session ? browserChat : browserProject) && (
        <WorkspaceBrowser
          key={`${browser.id}:${browserChat?.cwd || browserProject?.path || ''}`}
          api={hub.api}
          id={browser.id}
          session={browser.session}
          title={browserChat?.title || browserProject?.name || 'Рабочая папка'}
          path={browserChat?.cwd || browserProject?.path}
          active={activeSession(browserChat)}
          machineName={
            ws.data.servers.find((m) => m.id === browserMachineId)?.name
          }
          initialMode={browser.mode}
          initialTurn={browser.turn}
          onClose={() => setBrowser(null)}
        />
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
            openAccounts();
          }}
          onCreated={(s) => {
            setNewSession(false);
            openSession(
              s,
              sessionService?.customize ? sessionService.service.id : undefined,
            );
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
              <WorkspaceSelect
                aria-label="Проект"
                value={moveProject}
                onValueChange={setMoveProject}
                options={[
                  { value: '', label: 'Без проекта' },
                  ...hub.data.projects
                    .filter((p) => p.machineId === move.machineId)
                    .map((p) => ({
                      value: p.id,
                      label: `${p.name} · ${p.path}`,
                    })),
                ]}
              />
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
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                const first = searchResults.current?.querySelector('button');
                if (!first) return;
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  first.focus();
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  first.click();
                }
              }}
              placeholder="Название или часть названия…"
              aria-label="Поиск"
            />
          </div>
          <div className="search-results" ref={searchResults}>
            {searchProjects.map((p) => (
              <button
                onKeyDown={focusSearchResult}
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
              <button
                key={s.id}
                onKeyDown={focusSearchResult}
                onClick={() => openSession(s)}
              >
                <MessageSquare size={17} />
                <span>{s.title}</span>
                <small>
                  {s.archived ? 'Архив' : providerNames[s.provider]}
                </small>
              </button>
            ))}
            {searchMachines.map((m) => (
              <button
                onKeyDown={focusSearchResult}
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
              <button
                key={s.id}
                onKeyDown={focusSearchResult}
                onClick={() => {
                  setSearch(false);
                  setQuery('');
                  navigate('services', { serviceId: s.id });
                }}
              >
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
