'use client';
import { WorkspaceSelect } from './workspace-select';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FileDiff,
  Folder,
  FolderOpen,
  GitBranch,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  pathJoin,
  type AgentChangeReport,
  type AgentEdit,
  type ChangeTurn,
  type DirectoryPage,
  type FileEntry,
  type FilePreview,
  type GitFile,
  type GitPatch,
  type GitStatus,
  type Patch,
  type WorkspaceApi,
  type WorkspaceMode,
} from '@/lib/workspace-files';
import {
  beforeAfterRows,
  codeLineLimit,
  patchFiles,
  textLines,
  unifiedRows,
  wholeFileRows,
} from '@/lib/workspace-diff';
import { CopyButton, Modal } from './hub-ui';
import { ReadStatus, useWorkspaceRead } from './workspace-read';

type PaneProps = { api: WorkspaceApi; endpoint: string; revision: number };
type TreeProps = PaneProps & {
  path: string;
  selected: string | null;
  onSelect: (path: string) => void;
};

function TreeItem({ entry, ...props }: TreeProps & { entry: FileEntry }) {
  const [open, setOpen] = useState(false);
  const { path, selected, onSelect } = props;
  if (entry.kind === 'file')
    return (
      <button
        type="button"
        className="file-row"
        title={path}
        aria-pressed={selected === path}
        onClick={() => onSelect(path)}
      >
        <File size={15} />
        <span>{entry.name}</span>
      </button>
    );
  return (
    <div>
      <button
        type="button"
        className="file-row"
        title={path}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {open ? (
          <FolderOpen size={15} className="files-folder-icon" />
        ) : (
          <Folder size={15} className="files-folder-icon" />
        )}
        <span>{entry.name}</span>
      </button>
      {open && (
        <div className="tree-children">
          <TreeDirectory {...props} />
        </div>
      )}
    </div>
  );
}

function TreeDirectory({
  offset = 0,
  ...props
}: TreeProps & { offset?: number }) {
  const { api, endpoint, path, revision } = props;
  const list = useWorkspaceRead<DirectoryPage>(
    api,
    `${endpoint}/tree`,
    { path, offset },
    revision,
  );
  const [more, setMore] = useState<number | null>(null);
  return (
    <div className="tree-directory" aria-busy={list.loading}>
      <ReadStatus loading={list.loading && !list.data} error={list.error} />
      {list.data?.entries.map((entry) => (
        <TreeItem
          key={entry.name}
          {...props}
          entry={entry}
          path={pathJoin(path, entry.name)}
        />
      ))}
      {list.data?.entries.length === 0 && offset === 0 && (
        <p className="files-note">Нет файлов и папок для просмотра.</p>
      )}
      {more !== null ? (
        <TreeDirectory {...props} offset={more} />
      ) : (
        list.data?.next != null && (
          <button
            type="button"
            className="text-button tree-more"
            onClick={() => setMore(list.data?.next ?? null)}
          >
            Показать ещё
          </button>
        )
      )}
      {offset === 0 && list.data?.limited && (
        <p className="files-note">Показана часть большого каталога.</p>
      )}
    </div>
  );
}

function FileText({
  value,
  added = false,
}: {
  value: FilePreview;
  added?: boolean;
}) {
  if (value.kind === 'binary')
    return (
      <p className="files-note">
        Двоичный файл · {new Intl.NumberFormat('ru').format(value.size)} байт.
        Текстовый предпросмотр недоступен.
      </p>
    );
  if (added)
    return value.text ? (
      <DiffRows
        rows={wholeFileRows(value.text, 'add')}
        truncated={value.truncated}
      />
    ) : (
      <p className="files-note">Новый пустой файл.</p>
    );
  const lines = textLines(value.text);
  const visible = lines.slice(0, codeLineLimit);
  if (!visible.length) return <p className="files-note">Пустой файл.</p>;
  return (
    <>
      {(value.truncated || lines.length > codeLineLimit) && (
        <p className="files-note">Показана начальная часть файла.</p>
      )}
      <div className="file-source">
        <pre aria-hidden="true" className="file-line-numbers">
          {visible.map((_, index) => index + 1).join('\n')}
        </pre>
        <pre aria-label="Содержимое файла">
          {visible.map((line) => line || ' ').join('\n')}
        </pre>
      </div>
    </>
  );
}

function PreviewHeader({
  path,
  onBack,
  title = path,
}: {
  path: string;
  onBack: () => void;
  title?: string;
}) {
  return (
    <div className="file-preview-title">
      <button
        type="button"
        className="icon-button files-back"
        aria-label="Вернуться к списку"
        onClick={onBack}
      >
        <ArrowLeft size={16} />
      </button>
      <code title={title}>{title}</code>
      <CopyButton value={path} label="Скопировать путь к файлу" />
    </div>
  );
}

function FilesPane(props: PaneProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const { api, endpoint, revision } = props;
  const file = useWorkspaceRead<FilePreview>(
    api,
    selected ? `${endpoint}/file` : null,
    { path: selected },
    revision,
  );
  return (
    <div className="workspace-file-pane" data-preview={!!selected}>
      <div className="files-sidebar" aria-label="Дерево файлов">
        <div className="files-sidebar-title">
          <FolderOpen size={15} /> Рабочая папка
        </div>
        <TreeDirectory
          {...props}
          path=""
          selected={selected}
          onSelect={setSelected}
        />
      </div>
      <div className="files-preview">
        {selected ? (
          <>
            <PreviewHeader path={selected} onBack={() => setSelected(null)} />
            <ReadStatus
              loading={file.loading && !file.data}
              error={file.error}
            />
            {file.data && <FileText value={file.data} />}
          </>
        ) : (
          <PaneEmpty icon="file">
            Выберите файл в дереве, чтобы посмотреть его содержимое.
          </PaneEmpty>
        )}
      </div>
    </div>
  );
}

function DiffRows({
  rows,
  truncated,
}: {
  rows: ReturnType<typeof unifiedRows>;
  truncated?: boolean;
}) {
  return (
    <>
      {(truncated || rows.length > codeLineLimit) && (
        <p className="files-note">Показана часть изменений.</p>
      )}
      {rows.length ? (
        <div className="diff-rows" aria-label="Сравнение строк">
          {rows.slice(0, codeLineLimit).map((row, i) => (
            <div key={i} className={`diff-line diff-${row.kind}`}>
              <span className="diff-number" aria-hidden="true">
                {row.old}
              </span>
              <span className="diff-number" aria-hidden="true">
                {row.new}
              </span>
              <span
                className="diff-symbol"
                aria-label={
                  row.kind === 'add'
                    ? 'Добавлено'
                    : row.kind === 'delete'
                      ? 'Удалено'
                      : undefined
                }
              >
                {row.kind === 'add' ? '+' : row.kind === 'delete' ? '−' : ''}
              </span>
              <code>{row.text || ' '}</code>
            </div>
          ))}
        </div>
      ) : (
        <p className="files-note">Нет изменений строк.</p>
      )}
    </>
  );
}

function DiffText({ patch, kind }: { patch: Patch; kind?: AgentEdit['kind'] }) {
  const rows = unifiedRows(patch.text);
  const rawFile =
    kind &&
    kind !== 'update' &&
    !rows.some((row) => /^(?:diff --git |@@ |--- |\+\+\+ )/.test(row.text));
  return (
    <DiffRows
      rows={rawFile ? wholeFileRows(patch.text, kind) : rows}
      truncated={patch.truncated}
    />
  );
}

function PaneEmpty({
  children,
  icon = 'diff',
}: {
  children: string;
  icon?: 'file' | 'diff';
}) {
  const Icon = icon === 'file' ? File : FileDiff;
  return (
    <div className="files-pane-empty">
      <Icon size={29} />
      <p>{children}</p>
    </div>
  );
}

function Filter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="files-filter">
      <Search size={14} />
      <input
        type="search"
        aria-label="Фильтр по пути"
        placeholder="Фильтр по пути"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ChangeRow({
  path,
  old,
  status,
  pressed,
  onClick,
}: {
  path: string;
  old?: string;
  status: string;
  pressed: boolean;
  onClick: () => void;
}) {
  const title = old ? `${old} → ${path}` : path;
  return (
    <button
      type="button"
      className="file-row change-row"
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span className="changed-path">
        {path}
        {old && <small>из {old}</small>}
      </span>
      <span className="file-status" data-status={status}>
        {status}
      </span>
    </button>
  );
}

const gitMissing = (reason: 'no-git' | 'not-repo') =>
  reason === 'no-git'
    ? 'На выбранной машине не установлен Git или он недоступен из PATH.'
    : 'Эта рабочая папка не находится в репозитории Git.';

function GitDiff({ value }: { value: GitPatch }) {
  if ('reason' in value)
    return <p className="files-note">{gitMissing(value.reason)}</p>;
  return (
    <>
      {value.staged && (
        <section className="diff-block">
          <h3>В индексе</h3>
          <DiffText patch={value.staged} />
        </section>
      )}
      {value.working && (
        <section className="diff-block">
          <h3>В рабочей копии</h3>
          <DiffText patch={value.working} />
        </section>
      )}
      {value.untracked && (
        <section className="diff-block">
          <h3>Новый файл</h3>
          <FileText value={value.untracked} added />
        </section>
      )}
      {!value.staged && !value.working && !value.untracked && (
        <p className="files-note">
          Изменения уже исчезли из рабочей копии либо доступны только как
          метаданные Git.
        </p>
      )}
    </>
  );
}

function gitCode(entry: GitFile) {
  if (entry.status === '??') return 'A';
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(entry.status))
    return 'U';
  return entry.status.trim();
}

function GitPane({ api, endpoint, revision }: PaneProps) {
  const [selected, setSelected] = useState<string | null>(null),
    [query, setQuery] = useState('');
  const status = useWorkspaceRead<GitStatus>(
    api,
    `${endpoint}/git`,
    {},
    revision,
  );
  const git = status.data && 'files' in status.data ? status.data : null;
  const entry =
    git?.files.find((file) => file.path === selected) || git?.files[0];
  const patch = useWorkspaceRead<GitPatch>(
    api,
    entry ? `${endpoint}/patch` : null,
    { path: entry?.path, oldPath: entry?.oldPath },
    revision,
  );
  const matches = git?.files.filter((item) =>
    `${item.path} ${item.oldPath || ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="workspace-files-content">
      <p className="files-view-note">
        Все незакоммиченные изменения в этой папке, включая ручные правки.
      </p>
      <div
        className="workspace-file-pane"
        data-preview={!!selected && entry?.path === selected}
      >
        <div className="files-sidebar" aria-label="Изменённые файлы Git">
          <div className="files-sidebar-title">
            <GitBranch size={15} /> Файлы Git{' '}
            {git ? (
              <span>
                {git.files.length}
                {git.limited ? '+' : ''}
              </span>
            ) : null}
          </div>
          <ReadStatus
            loading={status.loading && !status.data}
            error={status.error}
          />
          {!!git?.files.length && <Filter value={query} onChange={setQuery} />}
          {matches?.map((item) => (
            <ChangeRow
              key={item.path + ':' + item.status}
              path={item.path}
              old={item.oldPath}
              status={gitCode(item)}
              pressed={entry?.path === item.path}
              onClick={() => setSelected(item.path)}
            />
          ))}
          {matches?.length === 0 && !!git?.files.length && (
            <p className="files-note">Файлы не найдены.</p>
          )}
          {git?.limited && (
            <p className="files-note">Показана часть списка Git.</p>
          )}
          {status.data &&
            ('reason' in status.data || !status.data.files.length) && (
              <p className="files-note files-mobile-message">
                {'reason' in status.data
                  ? gitMissing(status.data.reason)
                  : 'Незакоммиченных изменений нет.'}
              </p>
            )}
        </div>
        <div className="files-preview">
          {entry ? (
            <>
              <PreviewHeader
                path={entry.path}
                title={
                  entry.oldPath
                    ? `${entry.oldPath} → ${entry.path}`
                    : entry.path
                }
                onBack={() => setSelected(null)}
              />
              <ReadStatus
                loading={patch.loading && !patch.data}
                error={patch.error}
              />
              {patch.data && <GitDiff value={patch.data} />}
            </>
          ) : (
            <PaneEmpty>
              {status.data && 'reason' in status.data
                ? gitMissing(status.data.reason)
                : git
                  ? 'Незакоммиченных изменений нет.'
                  : 'Здесь появится сравнение после чтения Git.'}
            </PaneEmpty>
          )}
        </div>
      </div>
    </div>
  );
}

function agentReportFiles(report?: AgentChangeReport) {
  if (!report) return [];
  const reported = report.aggregate
    ? patchFiles(report.aggregate)
    : report.edits;
  if (!report.workspaceEdits?.length) return reported;
  const windows = /^[a-z]:[\\/]/i.test(report.cwd);
  const normalize = (path: string) =>
    (windows ? path.replaceAll('\\', '/').toLowerCase() : path).replace(
      /^\.\//,
      '',
    );
  const root = normalize(report.cwd).replace(/\/+$/, '') + '/';
  const key = (path: string) => {
    const normalized = normalize(path);
    return normalized.startsWith(root)
      ? normalized.slice(root.length)
      : normalized;
  };
  const edits = new Map(
    report.workspaceEdits.map((edit) => [key(edit.path), edit]),
  );
  for (const edit of reported) {
    const path = key(edit.path);
    const compared = edits.get(path);
    if (!compared || compared.previewUnavailable) edits.set(path, edit);
  }
  return [...edits.values()];
}

const noAgentChanges =
  'Пока нет сохранённых правок. Они появятся после запроса, который изменит файлы.';

function AgentPane({
  api,
  endpoint,
  revision,
  initialTurn,
}: PaneProps & { initialTurn?: string }) {
  const [requestedTurn, setRequestedTurn] = useState(initialTurn);
  const [selection, setSelection] = useState<{ turn: string; edit: string }>();
  const turns = useWorkspaceRead<{ turns: ChangeTurn[] }>(
    api,
    endpoint,
    undefined,
    revision,
  );
  const turn =
    turns.data?.turns.find((item) => item.id === requestedTurn) ||
    turns.data?.turns[0];
  const report = useWorkspaceRead<AgentChangeReport>(
    api,
    turn ? `${endpoint}/${turn.id}` : null,
    undefined,
    revision,
  );
  const payload = report.data;
  const files = agentReportFiles(payload);
  const explicit = selection?.turn === turn?.id ? selection?.edit : undefined;
  const current = files.find((edit) => edit.id === explicit) || files[0];
  return (
    <div className="workspace-files-content">
      <p className="files-view-note">
        Изменения рабочей папки за время запроса, в том числе сделанные через
        команды.
      </p>
      {turn && (
        <div className="files-turn-picker">
          <label>
            Запрос{' '}
            <WorkspaceSelect
              aria-label="Запрос"
              value={turn.id}
              onValueChange={setRequestedTurn}
              options={(turns.data?.turns || []).map((item) => ({
                value: item.id,
                label: `${new Date(item.at).toLocaleString('ru', { dateStyle: 'short', timeStyle: 'short' })} · ${item.title || 'Запрос агента'}`,
              }))}
            />
          </label>
          <code title={turn.cwd}>{turn.cwd}</code>
        </div>
      )}
      <div
        className="workspace-file-pane"
        data-preview={!!explicit && current?.id === explicit}
      >
        <div
          className="files-sidebar"
          aria-label="Файлы, изменённые за время запроса"
        >
          <div className="files-sidebar-title">
            <FileDiff size={15} /> Правки{' '}
            {files.length > 0 && <span>{files.length}</span>}
          </div>
          <ReadStatus
            loading={
              (turns.loading && !turns.data) || (report.loading && !payload)
            }
            error={turns.error || report.error}
          />
          {files.map((edit) => (
            <ChangeRow
              key={edit.id}
              path={edit.path}
              old={edit.move}
              status={
                edit.move
                  ? 'R'
                  : edit.kind === 'add'
                    ? 'A'
                    : edit.kind === 'delete'
                      ? 'D'
                      : 'M'
              }
              pressed={current?.id === edit.id}
              onClick={() => {
                if (turn) setSelection({ turn: turn.id, edit: edit.id });
              }}
            />
          ))}
          {payload?.limited && (
            <p className="files-note">Сохранена часть правок этого запроса.</p>
          )}
          {turns.data?.turns.length === 0 && (
            <p className="files-note files-mobile-message">{noAgentChanges}</p>
          )}
        </div>
        <div className="files-preview">
          {current ? (
            <>
              <PreviewHeader
                path={current.path}
                title={
                  current.move
                    ? `${current.move} → ${current.path}`
                    : current.path
                }
                onBack={() => setSelection(undefined)}
              />
              {current.previewUnavailable ? (
                <p className="files-note">
                  Панель зафиксировала изменение файла. Построчное сравнение
                  недоступно.
                </p>
              ) : current.patch ? (
                <DiffText patch={current.patch} kind={current.kind} />
              ) : (
                <DiffRows
                  rows={beforeAfterRows(
                    current.before?.text ?? '',
                    current.after?.text ?? '',
                  )}
                  truncated={
                    current.before?.truncated || current.after?.truncated
                  }
                />
              )}
            </>
          ) : (
            <PaneEmpty>
              {turns.data?.turns.length === 0
                ? noAgentChanges
                : 'Здесь появится сравнение для выбранного запроса.'}
            </PaneEmpty>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceBrowser({
  api,
  session,
  id,
  title,
  path,
  machineName,
  active,
  initialMode,
  initialTurn,
  onClose,
}: {
  api: WorkspaceApi;
  session: boolean;
  id: string;
  title: string;
  path?: string;
  machineName?: string;
  active: boolean;
  initialMode: WorkspaceMode;
  initialTurn?: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [visited, setVisited] = useState<WorkspaceMode[]>([initialMode]);
  const [revision, setRevision] = useState(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) setRevision((n) => n + 1);
    wasActive.current = active;
  }, [active]);
  const endpoint = `/hub/${session ? 'sessions' : 'projects'}/${id}`;
  const props = { api, endpoint: `${endpoint}/files`, revision };
  const modes = [
    { id: 'files', label: 'Файлы', icon: FolderOpen },
    ...(session
      ? ([{ id: 'agent', label: 'Правки агента', icon: FileDiff }] as const)
      : []),
    { id: 'git', label: 'Git', icon: GitBranch },
  ] as const;
  return (
    <Modal
      title="Рабочая папка"
      description={`${title}${machineName ? ` · ${machineName}` : ''}`}
      onClose={onClose}
      className="workspace-files-modal"
    >
      <div className="workspace-files-toolbar">
        <fieldset
          className="workspace-mode-buttons"
          aria-label="Просмотр рабочей папки"
        >
          {modes.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              aria-pressed={mode === id}
              onClick={() => {
                setMode(id);
                if (!visited.includes(id)) setVisited([...visited, id]);
              }}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </fieldset>
        {path && <code title={path}>{path}</code>}
        <button
          type="button"
          className="icon-button"
          aria-label="Обновить содержимое"
          title="Обновить содержимое"
          onClick={() => setRevision((n) => n + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {visited.includes('files') && (
        <div className="workspace-files-view" hidden={mode !== 'files'}>
          <FilesPane {...props} />
        </div>
      )}
      {visited.includes('agent') && (
        <div className="workspace-files-view" hidden={mode !== 'agent'}>
          <AgentPane
            {...props}
            endpoint={`${endpoint}/changes`}
            initialTurn={initialTurn}
          />
        </div>
      )}
      {visited.includes('git') && (
        <div className="workspace-files-view" hidden={mode !== 'git'}>
          <GitPane {...props} />
        </div>
      )}
    </Modal>
  );
}
