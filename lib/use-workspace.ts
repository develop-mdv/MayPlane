'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot, Job } from './domain';
import { panelCsrf, notifySignedOut } from './panel-session';
export type Connection = { url: string; token: string };
const empty: Snapshot = {
  servers: [],
  projects: [],
  jobs: [],
  gitConnections: [],
};
async function apiRequest<T>(
  custom: Connection | null,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  if (!custom)
    throw new Error(
      'Нет соединения с панелью. Проверьте её запуск и обновите страницу.',
    );
  if (
    custom.url &&
    new URL(custom.url, window.location.origin).origin !==
      window.location.origin
  )
    throw new Error(
      'Откройте нужную панель по её адресу и войдите там. Доступ между разными панелями не передаётся.',
    );
  const response = await fetch(custom.url + '/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD'].includes(method)
        ? { 'X-MayPlane-CSRF': panelCsrf() }
        : {}),
    },
    ...(method !== 'GET' && body !== undefined
      ? { body: JSON.stringify(body) }
      : {}),
    signal: AbortSignal.timeout(30000),
  });
  const result = (await response
    .json()
    .catch(() => ({ error: 'Адрес не является API mayplane' }))) as T & {
    error?: string;
  };
  if (response.status === 401) notifySignedOut();
  if (!response.ok)
    throw new Error(result.error || `Ошибка ${response.status}`);
  if (path === '/state') {
    const state = result as unknown as Snapshot;
    if (
      !Array.isArray(state.projects) ||
      !Array.isArray(state.servers) ||
      !Array.isArray(state.jobs)
    )
      throw new Error('Адрес не является API mayplane');
  }
  return result;
}
export function useWorkspace() {
  const [data, setData] = useState<Snapshot>(empty);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const generation = useRef(0);
  const stateRevision = useRef(0);
  const request = useCallback(
    <T>(path: string, method = 'GET', body?: unknown, custom = connection) =>
      apiRequest<T>(custom, path, method, body),
    [connection],
  );
  useEffect(() => {
    let active = true;
    const expected = generation.current;
    const local = { url: '', token: '' };
    void apiRequest<Snapshot>(local, '/state')
      .then((state) => {
        if (active && generation.current === expected) {
          setData(state);
          setConnection(local);
          setError('');
        }
      })
      .catch(() => {
        if (active && generation.current === expected)
          setError(
            'Не удалось подключиться к серверной части. Проверьте запуск MayPlane и обновите страницу.',
          );
      })
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
    };
    // Workspace mounts only after owner login; requests use its same-origin cookie.
  }, []);
  useEffect(() => {
    if (!connection) return;
    let active = true,
      inFlight = false;
    const expected = generation.current;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      const version = stateRevision.current;
      try {
        const state = await request<Snapshot>('/state');
        if (
          active &&
          expected === generation.current &&
          version === stateRevision.current
        ) {
          setData(state);
          setError('');
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connection, request]);
  async function connect(url: string, token: string) {
    let normalized = '';
    if (url) {
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
      normalized = parsed.href.replace(/\/$/, '');
    }
    const next = { url: normalized, token };
    const state = await request<Snapshot>('/state', 'GET', undefined, next);
    generation.current++;
    setData(state);
    setConnection(next);
    setError('');
    setInitializing(false);
  }
  function disconnect() {
    generation.current++;
    setConnection(null);
    setData(empty);
    setError('Серверная часть отключена. Подключитесь в настройках.');
  }
  async function action<T = Job>(
    path: string,
    body: Record<string, unknown> = {},
    method = 'POST',
  ): Promise<T> {
    const expected = generation.current;
    setBusy(true);
    try {
      const result = await request<T>(path, method, body);
      ++stateRevision.current;
      const state = await request<Snapshot>('/state');
      if (expected !== generation.current)
        throw new Error('Подключение изменилось во время запроса');
      setData(state);
      return result;
    } finally {
      setBusy(false);
    }
  }
  async function runtimeLogs(id: string) {
    return (await request<{ logs: string[] }>(`/projects/${id}/logs`)).logs;
  }
  const terminalTicket = useCallback(
    (id: string) =>
      request<{ ticket: string }>(`/servers/${id}/terminal-ticket`, 'POST', {}),
    [request],
  );
  return {
    data,
    connection,
    error,
    busy,
    initializing,
    action,
    connect,
    disconnect,
    runtimeLogs,
    terminalTicket,
    api: request,
  };
}
export function keys(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter((v): v is string => !!v);
}
export type Workspace = ReturnType<typeof useWorkspace>;
