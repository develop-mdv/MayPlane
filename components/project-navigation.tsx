'use client';
import { useEffect, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  activeSession,
  providerNames,
  type AgentSession,
  type HubProject,
} from '@/lib/hub';
import type { Server } from '@/lib/domain';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export function ChatActions({
  session,
  onRename,
  onMove,
  onArchive,
}: {
  session: AgentSession;
  onRename: () => void;
  onMove: () => void;
  onArchive: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="icon-button chat-actions-trigger"
        aria-label={`Действия с чатом: ${session.title}`}
      >
        <MoreHorizontal size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="workspace-menu" align="end">
        <DropdownMenuItem onClick={onRename} disabled={activeSession(session)}>
          <Pencil />
          Переименовать
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onMove} disabled={activeSession(session)}>
          <FolderInput />
          Переместить в проект
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onArchive} disabled={activeSession(session)}>
          <Archive />
          {session.archived ? 'Восстановить чат' : 'Архивировать чат'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectNavigation({
  projects,
  sessions,
  machines,
  selectedSession,
  scope,
  archive,
  disabled,
  onToggleArchive,
  onNewProject,
  onNewChat,
  onSelectProject,
  onOpenSession,
  onRename,
  onMove,
  onArchive,
  onRenameProject,
  onRemoveProject,
}: {
  projects: HubProject[];
  sessions: AgentSession[];
  machines: Server[];
  selectedSession: string | null;
  scope: string;
  archive: boolean;
  disabled: boolean;
  onToggleArchive: () => void;
  onNewProject: () => void;
  onNewChat: (id: string | null) => void;
  onSelectProject: (id: string | null) => void;
  onOpenSession: (s: AgentSession) => void;
  onRename: (s: AgentSession) => void;
  onMove: (s: AgentSession) => void;
  onArchive: (s: AgentSession) => void;
  onRenameProject: (p: HubProject) => void;
  onRemoveProject: (p: HubProject) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selectedProject = sessions.find(
    (s) => s.id === selectedSession,
  )?.projectId;
  useEffect(() => {
    if (selectedProject)
      setCollapsed((previous) => {
        if (!previous.has(selectedProject)) return previous;
        const next = new Set(previous);
        next.delete(selectedProject);
        return next;
      });
  }, [selectedSession, selectedProject]);
  function toggle(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function chats(projectId: string | null) {
    return sessions.filter(
      (s) => (s.projectId || null) === projectId && !!s.archived === archive,
    );
  }
  function rows(items: AgentSession[]) {
    return items.map((s) => (
      <div
        className={`tree-chat-row ${s.id === selectedSession ? 'selected' : ''}`}
        key={s.id}
      >
        <button className="tree-chat-main" onClick={() => onOpenSession(s)}>
          <i className={`session-dot ${s.status}`} />
          <span>
            <strong>{s.title}</strong>
            <small>
              {providerNames[s.provider]} ·{' '}
              {machines.find((m) => m.id === s.machineId)?.name || 'Машина'}
            </small>
          </span>
          {s.status === 'approval' && <i className="attention-dot" />}
        </button>
        <ChatActions
          session={s}
          onRename={() => onRename(s)}
          onMove={() => onMove(s)}
          onArchive={() => onArchive(s)}
        />
      </div>
    ));
  }
  return (
    <div className="project-tree">
      <div className="sidebar-section-heading">
        <span>{archive ? 'АРХИВ ЧАТОВ' : 'ПРОЕКТЫ И ЧАТЫ'}</span>
        <div>
          <button
            className={`icon-button ${archive ? 'is-active' : ''}`}
            aria-label={
              archive ? 'Показать активные чаты' : 'Показать архив чатов'
            }
            onClick={onToggleArchive}
          >
            <Archive size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Добавить проект"
            disabled={disabled}
            onClick={onNewProject}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      {projects.map((p) => (
        <section className="tree-project" key={p.id}>
          <div
            className={`tree-project-heading ${scope === p.id ? 'selected' : ''}`}
          >
            <button
              className="tree-collapse"
              aria-label={`${collapsed.has(p.id) ? 'Развернуть' : 'Свернуть'} проект ${p.name}`}
              aria-expanded={!collapsed.has(p.id)}
              onClick={() => toggle(p.id)}
            >
              {collapsed.has(p.id) ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}
            </button>
            <button
              className="tree-project-name"
              onClick={() => onSelectProject(p.id)}
              title={`${p.path} · ${machines.find((m) => m.id === p.machineId)?.name}`}
            >
              <Folder size={15} />
              <span>{p.name}</span>
            </button>
            <button
              className="icon-button"
              aria-label={`Новый чат в проекте ${p.name}`}
              disabled={disabled || archive}
              onClick={() => onNewChat(p.id)}
            >
              <Plus size={14} />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="icon-button"
                aria-label={`Действия с проектом ${p.name}`}
              >
                <MoreHorizontal size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="workspace-menu" align="end">
                <DropdownMenuItem onClick={() => onRenameProject(p)}>
                  <Pencil />
                  Переименовать проект
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRemoveProject(p)}>
                  <Trash2 />
                  Убрать проект из списка
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {!collapsed.has(p.id) && (
            <div className="tree-project-chats">
              {chats(p.id).length ? (
                rows(chats(p.id))
              ) : (
                <p className="tree-empty">
                  {archive ? 'Нет архивных чатов' : 'Пока нет чатов'}
                </p>
              )}
            </div>
          )}
        </section>
      ))}
      {!projects.length && (
        <p className="sidebar-empty">
          Добавьте рабочую папку,
          <br />
          чтобы собрать её чаты вместе.
        </p>
      )}
      <section className="tree-project loose-chats">
        <div
          className={`tree-project-heading ${scope === 'loose' ? 'selected' : ''}`}
        >
          <button
            className="tree-collapse"
            aria-label="Свернуть или развернуть чаты без проекта"
            aria-expanded={!collapsed.has('loose')}
            onClick={() => toggle('loose')}
          >
            {collapsed.has('loose') ? (
              <ChevronRight size={13} />
            ) : (
              <ChevronDown size={13} />
            )}
          </button>
          <button
            className="tree-project-name"
            onClick={() => onSelectProject(null)}
          >
            <MessageSquare size={15} />
            <span>Без проекта</span>
          </button>
          <button
            className="icon-button"
            disabled={disabled || archive}
            aria-label="Новый чат без проекта"
            onClick={() => onNewChat(null)}
          >
            <Plus size={14} />
          </button>
        </div>
        {!collapsed.has('loose') && (
          <div className="tree-project-chats">
            {chats(null).length ? (
              rows(chats(null))
            ) : (
              <p className="tree-empty">
                {archive ? 'Архив пуст' : 'Можно начать с обычного чата'}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
