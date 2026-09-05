'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  makeDemo,
  type Snapshot,
  type Job,
  type Project,
  type Server,
} from './domain';
export function useWorkspace() {
  const [data, setData] = useState<Snapshot>(makeDemo);
  const [connection, setConnection] = useState<{
    url: string;
    token: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const generation = useRef(0);
  const request = useCallback(
    async <T>(
      path: string,
      method = 'GET',
      body?: unknown,
      custom = connection,
    ): Promise<T> => {
      if (!custom) throw new Error('Исполнитель не подключён');
      const r = await fetch(custom.url + '/api' + path, {
        method,
        headers: {
          Authorization: `Bearer ${custom.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method !== 'GET' && body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(30000),
      });
      const result = (await r
        .json()
        .catch(() => ({ error: 'Адрес не является API ezdeploy' }))) as T & {
        error?: string;
      };
      if (!r.ok) throw new Error(result.error || `Ошибка ${r.status}`);
      if (path === '/state') {
        const state = result as unknown as Snapshot;
        if (
          !Array.isArray(state.projects) ||
          !Array.isArray(state.servers) ||
          !Array.isArray(state.jobs)
        )
          throw new Error('Адрес не является API ezdeploy');
      }
      return result;
    },
    [connection],
  );
  useEffect(() => {
    if (!connection) return;
    let active = true;
    const expected = generation.current;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const state = await request<Snapshot>('/state');
        if (active && generation.current === expected) {
          setData(state);
          setError('');
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(refresh, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connection, request]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  function resetTimers() {
    generation.current++;
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }
  async function connect(url: string, token: string) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('Укажите адрес без параметров и паролей');
    if (
      parsed.protocol !== 'https:' &&
      !(
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      )
    )
      throw new Error('Для удалённого исполнителя требуется HTTPS');
    const next = { url: parsed.href.replace(/\/$/, ''), token };
    const state = await request<Snapshot>('/state', 'GET', undefined, next);
    resetTimers();
    setData(state);
    setConnection(next);
    setError('');
  }
  function disconnect() {
    resetTimers();
    setConnection(null);
    setData(makeDemo());
    setError('');
  }
  function demoJob(
    type: Job['type'],
    p?: Project,
    s?: Server,
    target?: string,
  ) {
    if (
      data.jobs.some(
        (j) =>
          ['pending', 'deploying'].includes(j.status) &&
          ((p && j.projectId === p.id) || (s && j.serverId === s.id)),
      )
    )
      throw new Error('Дождитесь текущей операции');
    const job: Job = {
      id: crypto.randomUUID(),
      type,
      projectId: p?.id,
      serverId: s?.id || p?.serverId,
      projectName: p?.name || s?.name || '',
      status: 'deploying',
      createdAt: new Date().toISOString(),
      logs: ['[demo] Операция запущена. Реальный сервер не изменяется.'],
      source: 'Вручную',
      target,
    };
    setData((d) => ({
      ...d,
      jobs: [job, ...d.jobs],
      projects: d.projects.map((x) =>
        x.id === p?.id ? { ...x, status: 'deploying' } : x,
      ),
    }));
    timers.current.push(
      setTimeout(
        () =>
          setData((d) => ({
            ...d,
            jobs: d.jobs.map((j) =>
              j.id === job.id
                ? {
                    ...j,
                    status: 'success',
                    finishedAt: new Date().toISOString(),
                    logs: [
                      ...j.logs,
                      ...(type === 'migration'
                        ? [
                            '[demo] Исходный проект остановлен',
                            '[demo] Данные скопированы, SHA-256 совпадает',
                            '[demo] Копия запущена на новом сервере',
                          ]
                        : [
                            '[demo] Команда выполнена',
                            '[demo] Проверка состояния пройдена',
                          ]),
                    ],
                  }
                : j,
            ),
            projects: d.projects.map((x) =>
              x.id === p?.id
                ? {
                    ...x,
                    status: type === 'stop' ? 'stopped' : 'running',
                    serverId: target || x.serverId,
                    updatedAt: new Date().toISOString(),
                  }
                : x,
            ),
            servers: d.servers.map((x) =>
              x.id === s?.id
                ? {
                    ...x,
                    status: 'online',
                    cpu: 3,
                    memory: 12,
                    disk: 8,
                    specs: '2 vCPU · 4 GB RAM · Ubuntu 24.04',
                  }
                : x,
            ),
          })),
        2200,
      ),
    );
    return job;
  }
  async function executeAction(
    path: string,
    body: Record<string, unknown> = {},
    method = 'POST',
  ) {
    const expected = generation.current;
    setBusy(true);
    try {
      if (connection) {
        const result = await request(path, method, body);
        const snapshot = await request<Snapshot>('/state');
        if (generation.current !== expected)
          throw new Error('Подключение изменилось во время запроса');
        setData(snapshot);
        return result;
      }
      if (path === '/servers/fingerprint')
        return {
          fingerprint: 'SHA256:DEMO000000000000000000000000000000000000000',
        };
      if (path === '/servers') {
        if (data.servers.some((s) => s.host === body.host))
          throw new Error('Этот сервер уже добавлен');
        const s = {
          ...body,
          id: crypto.randomUUID(),
          status: 'needs_setup',
          cpu: null,
          memory: null,
          disk: null,
          specs: 'Нужна настройка',
        } as Server;
        delete (s as unknown as Record<string, unknown>).password;
        delete (s as unknown as Record<string, unknown>).privateKey;
        setData((d) => ({ ...d, servers: [...d.servers, s] }));
        return s;
      }
      if (path === '/projects') {
        if (data.projects.some((p) => p.name === body.name))
          throw new Error('Такое имя уже занято');
        const p = {
          ...body,
          id: crypto.randomUUID(),
          status: 'stopped',
          updatedAt: new Date().toISOString(),
          commit: '—',
          color: 'mint',
          envKeys: keys(typeof body.env === 'string' ? body.env : ''),
        } as unknown as Project;
        delete (p as unknown as Record<string, unknown>).env;
        setData((d) => ({ ...d, projects: [p, ...d.projects] }));
        return p;
      }
      const parts = path.split('/');
      if (parts[1] === 'servers') {
        const s = data.servers.find((x) => x.id === parts[2]);
        if (parts[3] === 'provision') return demoJob('provision', undefined, s);
        return { ok: true };
      }
      const p = data.projects.find((x) => x.id === parts[2]);
      if (!p) throw new Error('Проект не найден');
      if (method === 'PATCH') {
        setData((d) => ({
          ...d,
          projects: d.projects.map((x) =>
            x.id === p.id
              ? {
                  ...x,
                  ...(body.autoDeploy !== undefined
                    ? { autoDeploy: !!body.autoDeploy }
                    : {}),
                  ...(body.env !== undefined
                    ? {
                        envKeys: keys(
                          typeof body.env === 'string' ? body.env : '',
                        ),
                      }
                    : {}),
                }
              : x,
          ),
        }));
        return { ok: true };
      }
      if (parts[3] === 'webhook')
        return {
          url: `https://runner.example.com/api/webhooks/github/${p.id}`,
          secret: 'demo-secret-do-not-use-in-production',
        };
      return demoJob(
        parts[3] === 'migrate' ? 'migration' : (parts[3] as Job['type']),
        p,
        undefined,
        body.target as string | undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  async function runtimeLogs(id: string) {
    if (connection)
      return (await request<{ logs: string[] }>(`/projects/${id}/logs`))
        .logs as string[];
    return [
      '[demo] Пример логов приложения',
      '2026-09-05T12:00:01 INFO Application started',
      '2026-09-05T12:00:02 INFO Listening on 0.0.0.0:3000',
      '2026-09-05T12:00:10 INFO GET /health 200 3ms',
    ];
  }
  async function action<T = Job>(
    path: string,
    body: Record<string, unknown> = {},
    method = 'POST',
  ): Promise<T> {
    return (await executeAction(path, body, method)) as T;
  }
  return {
    data,
    connection,
    error,
    busy,
    action,
    connect,
    disconnect,
    runtimeLogs,
  };
}
export function keys(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter((v): v is string => !!v);
}
export type Workspace = ReturnType<typeof useWorkspace>;

