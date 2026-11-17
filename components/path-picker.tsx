'use client';
import { useEffect, useId, useState } from 'react';
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  House,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  pathJoin,
  type MachineDirectory,
  type WorkspaceApi,
} from '@/lib/workspace-files';
import { Modal } from './hub-ui';
import { ReadStatus, useWorkspaceRead } from './workspace-read';

type PathMode = 'directory' | 'file' | 'any';
type PickerProps = {
  api: WorkspaceApi;
  machineId: string;
  machineName?: string;
  platform?: string;
  initialPath?: string;
  mode?: PathMode;
  onSelect: (path: string) => void;
  onClose: () => void;
};

function crumbs(path: string, separator: string) {
  const root = separator === '\\' ? path.slice(0, 3) : '/';
  const parts = [{ label: root, path: root }];
  let parent = root;
  for (const name of path.slice(root.length).split(separator).filter(Boolean)) {
    parent = pathJoin(parent, name, separator);
    parts.push({ label: name, path: parent });
  }
  return parts;
}

export function PathPicker({
  api,
  machineId,
  machineName,
  platform,
  initialPath,
  mode = 'directory',
  onSelect,
  onClose,
}: PickerProps) {
  const endpoint = `/hub/machines/${machineId}/files`;
  const [path, setPath] = useState(initialPath || undefined);
  const [selection, setSelection] = useState<string | null>();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [showRoots, setShowRoots] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 180);
    return () => clearTimeout(timer);
  }, [query]);
  const body = {
    path,
    query: search,
    offset,
    foldersOnly: mode === 'directory',
  };
  const list = useWorkspaceRead<MachineDirectory>(
    api,
    showRoots ? null : `${endpoint}/browse`,
    body,
    revision,
  );
  const drives = useWorkspaceRead<{ roots: string[] }>(
    api,
    showRoots ? `${endpoint}/roots` : null,
    {},
    revision,
  );
  const directory = list.data;
  const file = selection === undefined ? directory?.selected : selection;
  const chosen = mode === 'file' ? file : file || directory?.path;
  const windows = directory
    ? directory.separator === '\\'
    : platform === 'win32';
  const refresh = () => setRevision((previous) => previous + 1);
  function navigate(next?: string) {
    setPath(next);
    setOffset(0);
    setQuery('');
    setSearch('');
    setSelection(undefined);
    setShowRoots(false);
  }
  return (
    <Modal
      title={
        mode === 'directory'
          ? 'Выбрать папку'
          : mode === 'file'
            ? 'Выбрать файл'
            : 'Выбрать папку или файл'
      }
      description={
        machineName
          ? `Файлы на машине «${machineName}»`
          : 'Файлы на выбранной машине'
      }
      className="path-picker"
      onClose={onClose}
    >
      <div className="path-picker-body">
        <div className="path-picker-toolbar">
          <button
            type="button"
            className="hub-button"
            onClick={() => navigate()}
          >
            <House size={15} /> Домой
          </button>
          <button
            type="button"
            className="hub-button"
            onClick={() => (windows ? setShowRoots(true) : navigate('/'))}
          >
            <HardDrive size={15} /> {windows ? 'Диски' : 'Корень'}
          </button>
          <button
            type="button"
            className="icon-button"
            title="На папку выше"
            aria-label="На папку выше"
            disabled={showRoots || !directory?.parent}
            onClick={() => navigate(directory?.parent || undefined)}
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Обновить список"
            aria-label="Обновить список"
            onClick={refresh}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {directory && !showRoots && (
          <nav className="path-picker-crumbs" aria-label="Текущий путь">
            {crumbs(directory.path, directory.separator).map((crumb) => (
              <button
                key={crumb.path}
                type="button"
                title={crumb.path}
                aria-current={
                  crumb.path === directory.path ? 'location' : undefined
                }
                onClick={() => navigate(crumb.path)}
              >
                {crumb.label}
              </button>
            ))}
          </nav>
        )}
        {!showRoots && (
          <div className="files-filter">
            <Search size={15} />
            <input
              type="search"
              placeholder="Фильтр в этой папке"
              aria-label="Фильтр в этой папке"
              maxLength={160}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
          </div>
        )}
        <div
          className="path-picker-list"
          aria-busy={showRoots ? drives.loading : list.loading}
        >
          {showRoots ? (
            <>
              <ReadStatus {...drives} />
              {drives.data?.roots.map((root) => (
                <button
                  type="button"
                  className="file-row"
                  key={root}
                  onClick={() => navigate(root)}
                >
                  <HardDrive size={16} />
                  <span>{root}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
              {drives.data?.roots.length === 0 && (
                <p className="files-note">Доступных дисков не найдено.</p>
              )}
            </>
          ) : (
            <>
              <ReadStatus {...list} />
              {directory?.entries.map((entry) => {
                const target = pathJoin(
                  directory.path,
                  entry.name,
                  directory.separator,
                );
                return (
                  <button
                    type="button"
                    className="file-row"
                    key={entry.name}
                    title={target}
                    aria-pressed={
                      entry.kind === 'file' ? file === target : undefined
                    }
                    onClick={() =>
                      entry.kind === 'directory'
                        ? navigate(target)
                        : setSelection(file === target ? null : target)
                    }
                    onDoubleClick={
                      entry.kind === 'file' ? () => onSelect(target) : undefined
                    }
                  >
                    {entry.kind === 'directory' ? (
                      <Folder size={16} className="files-folder-icon" />
                    ) : (
                      <File size={16} />
                    )}
                    <span>{entry.name}</span>
                    {entry.kind === 'directory' && <ChevronRight size={14} />}
                  </button>
                );
              })}
              {directory && !directory.entries.length && (
                <p className="files-note">
                  {search
                    ? 'По этому фильтру ничего не найдено.'
                    : mode === 'directory'
                      ? 'Вложенных папок нет.'
                      : 'Папка пуста.'}
                </p>
              )}
            </>
          )}
        </div>
        {directory?.limited && (
          <p className="files-note">
            Папка очень большая. Если нужного пути нет в списке, укажите его в
            форме вручную.
          </p>
        )}
        {directory && (offset > 0 || directory.next !== null) && (
          <div className="path-picker-pages">
            <button
              type="button"
              className="icon-button"
              aria-label="Предыдущая страница"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 150))}
            >
              <ChevronLeft size={15} />
            </button>
            <span>
              {offset + 1}–{offset + directory.entries.length}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Следующая страница"
              disabled={directory.next === null}
              onClick={() => {
                if (directory.next !== null) setOffset(directory.next);
              }}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
        <div className="path-picker-footer">
          <code title={chosen || undefined}>{chosen || 'Путь не выбран'}</code>
          <div className="form-actions">
            <button type="button" className="hub-button" onClick={onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="hub-button primary"
              disabled={showRoots || !!list.error || list.loading || !chosen}
              onClick={() => {
                if (chosen) onSelect(chosen);
              }}
            >
              {file ? 'Выбрать файл' : 'Выбрать эту папку'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function PathField({
  api,
  machineId,
  machineName,
  platform,
  mode = 'directory',
  startPath,
  label,
  hint,
  value,
  onChange,
  placeholder,
  disabled,
  required,
}: {
  api: WorkspaceApi;
  machineId?: string;
  machineName?: string;
  platform?: string;
  mode?: PathMode;
  startPath?: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="hub-field path-field">
      <label htmlFor={id}>{label}</label>
      <div className="path-field-controls">
        <button
          type="button"
          className="hub-button"
          disabled={!machineId || disabled}
          onClick={() => setOpen(true)}
        >
          <FolderOpen size={15} />
          {mode === 'directory'
            ? 'Выбрать папку'
            : mode === 'file'
              ? 'Выбрать файл'
              : 'Выбрать путь'}
        </button>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={1024}
          aria-describedby={hint ? `${id}-hint` : undefined}
          required={required}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder ?? 'Или введите полный путь'}
        />
      </div>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {open && machineId && (
        <PathPicker
          key={machineId}
          api={api}
          machineId={machineId}
          machineName={machineName}
          platform={platform}
          mode={mode}
          initialPath={value.trim() || startPath}
          onClose={() => setOpen(false)}
          onSelect={(path) => {
            onChange(path);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
