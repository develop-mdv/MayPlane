'use client';
import { WorkspaceSelect } from './workspace-select';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ChevronRight,
  LoaderCircle,
  Monitor,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { Server } from '@/lib/domain';
import {
  agentProviders,
  providerNames,
  type AgentProvider,
  type AgentSession,
  type Hub,
} from '@/lib/hub';
import { ErrorText } from './hub-ui';

type NativeSession = {
  nativeId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  active: boolean;
  importedSessionId: string | null;
};
type Page = { sessions: NativeSession[]; nextCursor: string | null };
export type MachineChatSource = { machineId?: string; provider: AgentProvider };

type MachineChatsProps = {
  hub: Hub;
  machines: Server[];
  source: MachineChatSource;
  disabled: boolean;
  onSourceChange: (source: MachineChatSource) => void;
  onConnect: () => void;
  onOpened: (session: AgentSession) => void;
};

export function MachineChats(props: MachineChatsProps) {
  const { machines, source, disabled, onConnect } = props;
  const machine =
    machines.find((item) => item.id === source.machineId) ||
    machines.find(
      (item) => item.transport === 'connector' && item.status === 'online',
    ) ||
    machines.find((item) => item.status === 'online') ||
    machines[0];

  if (!machine)
    return (
      <div className="machine-chat-empty">
        <p>Подключите машину, чтобы открыть сохранённые на ней чаты.</p>
        <button
          type="button"
          className="hub-button"
          disabled={disabled}
          onClick={onConnect}
        >
          <Monitor size={15} /> Подключить машину
        </button>
      </div>
    );

  return (
    <MachineChatList
      key={`${machine.id}:${source.provider}`}
      machine={machine}
      {...props}
    />
  );
}

function MachineChatList({
  hub: { api, mutate },
  machines,
  machine,
  source: { provider },
  disabled,
  onSourceChange,
  onOpened,
}: MachineChatsProps & { machine: Server }) {
  const [page, setPage] = useState<Page | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState('');
  const requests = useRef({ revision: 0 });
  const canLoad = !disabled && machine.status !== 'offline';
  const busy = loading || opening !== null;
  const machineInputId = useId();
  const agentInputId = useId();
  const machineId = machine.id;
  const load = useCallback(
    async (cursor: string | null = null) => {
      const request = ++requests.current.revision;
      setLoading(true);
      setError('');
      try {
        const next = await api<Page>(
          `/hub/machines/${machineId}/agents/${provider}/native-sessions`,
          'POST',
          { cursor },
        );
        if (request !== requests.current.revision) return;
        setPage((previous) => ({
          sessions: Array.from(
            new Map(
              [
                ...(cursor ? previous?.sessions || [] : []),
                ...next.sessions,
              ].map((session) => [session.nativeId, session]),
            ).values(),
          ),
          nextCursor: next.nextCursor === cursor ? null : next.nextCursor,
        }));
      } catch (reason) {
        if (request === requests.current.revision)
          setError((reason as Error).message);
      } finally {
        if (request === requests.current.revision) setLoading(false);
      }
    },
    [api, machineId, provider],
  );

  useEffect(() => {
    const state = requests.current;
    const revision = state.revision;
    if (canLoad) {
      queueMicrotask(() => {
        if (state.revision === revision) void load();
      });
    }
    return () => {
      state.revision++;
    };
  }, [canLoad, load]);

  async function open(row: NativeSession) {
    const request = requests.current.revision;
    setOpening(row.nativeId);
    setError('');
    try {
      const session = await mutate<AgentSession>('/sessions/import', {
        machineId,
        provider,
        nativeId: row.nativeId,
        cwd: row.cwd,
        openForReading: true,
      });
      if (request === requests.current.revision) onOpened(session);
    } catch (reason) {
      if (request === requests.current.revision)
        setError((reason as Error).message);
    } finally {
      setOpening(null);
    }
  }

  const filter = query.trim().toLowerCase();
  const rows = (page?.sessions || []).filter((row) =>
    `${row.title} ${row.cwd}`.toLowerCase().includes(filter),
  );
  return (
    <section className="machine-chats" aria-label="Чаты на машине">
      <div className="machine-chats-toolbar">
        <label htmlFor={machineInputId} className="machine-chat-field">
          <span>Машина</span>
          <WorkspaceSelect
            id={machineInputId}
            aria-label="Машина"
            value={machineId}
            onValueChange={(choice) =>
              onSourceChange({ machineId: choice, provider })
            }
            options={machines.map((item) => ({
              value: item.id,
              label:
                item.name + (item.status === 'offline' ? ' · Не в сети' : ''),
            }))}
          />
        </label>
        <label htmlFor={agentInputId} className="machine-chat-field">
          <span>Агент</span>
          <WorkspaceSelect
            id={agentInputId}
            aria-label="Агент"
            value={provider}
            onValueChange={(choice) =>
              onSourceChange({
                machineId,
                provider: choice as AgentProvider,
              })
            }
            options={agentProviders.map((agent) => ({
              value: agent,
              label: providerNames[agent],
            }))}
          />
        </label>
        {!!page?.sessions.length && (
          <label className="machine-chat-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="Поиск в загруженных чатах"
              placeholder="Поиск по названию или папке"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        <button
          type="button"
          className="hub-button machine-chat-refresh"
          disabled={!canLoad || busy}
          aria-label="Обновить список чатов на машине"
          title="Обновить список"
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={canLoad && loading ? 'spin' : ''} />
        </button>
      </div>
      {!canLoad && (
        <output className="machine-chat-status">
          {disabled
            ? 'Подключитесь к панели, чтобы загрузить чаты.'
            : 'Машина не в сети. Список обновится после подключения.'}
        </output>
      )}
      <ErrorText error={canLoad ? error : ''} />
      {canLoad && !page && !error && (
        <output className="machine-chat-status">
          <LoaderCircle size={15} className="spin" /> Загружаем чаты…
        </output>
      )}
      {canLoad && page && !loading && !error && !rows.length && (
        <output className="machine-chat-status">
          {filter
            ? 'Среди загруженных чатов совпадений нет.'
            : 'Сохранённых чатов у этого агента нет.'}
        </output>
      )}
      {!!rows.length && (
        <div className="chat-home-list">
          {rows.map((row) => (
            <article
              className="chat-list-row machine-chat-row"
              key={row.nativeId}
            >
              <button
                type="button"
                disabled={!canLoad || busy}
                aria-busy={opening === row.nativeId}
                onClick={() => void open(row)}
              >
                <i
                  className={`session-dot ${row.active ? 'running' : 'idle'}`}
                  aria-hidden="true"
                />
                <span>
                  <strong title={row.title}>{row.title}</strong>
                  <small>
                    <code title={row.cwd}>{row.cwd}</code>
                    {row.active && <span>Выполняется</span>}
                    {row.importedSessionId && <span>В панели</span>}
                  </small>
                </span>
                <time
                  dateTime={row.updatedAt}
                  title={new Date(row.updatedAt).toLocaleString('ru-RU')}
                >
                  {new Date(row.updatedAt).toLocaleDateString('ru-RU', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </time>
                {opening === row.nativeId ? (
                  <LoaderCircle className="spin" size={15} aria-hidden="true" />
                ) : (
                  <ChevronRight size={15} aria-hidden="true" />
                )}
              </button>
            </article>
          ))}
        </div>
      )}
      {page?.nextCursor && (
        <button
          type="button"
          className="text-button machine-chat-more"
          disabled={!canLoad || busy}
          onClick={() => void load(page.nextCursor)}
        >
          Показать ещё
        </button>
      )}
    </section>
  );
}
