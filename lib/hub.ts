'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from './use-workspace';

export type HubProject = {
  id: string;
  name: string;
  machineId: string;
  path: string;
  repo: string;
  createdAt: string;
};
export type AgentProvider = 'codex' | 'opencode';
export type RemovalKind = 'chat' | 'project' | 'service' | 'machine';
export type RemovalTarget = { kind: RemovalKind; id: string; name: string };
export type RemovalPreview = RemovalTarget & {
  revision: string;
  projects: number;
  chats: number;
  services: number;
  pendingCredentials: number;
};
export type RemovalResult = {
  ok: boolean;
  removedId: string;
  deletedChats: string[];
  deletedProjects: string[];
  deletedServices: string[];
  deletedMachines: string[];
};
export type AgentSession = {
  id: string;
  projectId: string | null;
  cwd?: string;
  machineId: string;
  provider: AgentProvider;
  title: string;
  model: string;
  reasoning?: string;
  accountId?: string | null;
  profileId?: string;
  nativeSource?: boolean;
  nativeSyncedAt?: string;
  authError?: string | null;
  mode: string;
  status:
    | 'idle'
    | 'connecting'
    | 'running'
    | 'approval'
    | 'error'
    | 'interrupted';
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: string;
};
export type AgentApproval = {
  id: string;
  kind: 'permission' | 'input';
  method: string;
  params: {
    command?: string | string[];
    reason?: string;
    grantRoot?: string;
    networkApprovalContext?: { host?: string; protocol?: string };
    toolCall?: unknown;
    changes?: unknown;
    questions?: {
      id: string;
      header?: string;
      question: string;
      options?: { label: string; description?: string }[];
    }[];
    options?: { optionId: string; name: string; kind: string }[];
  };
};
export type SessionDetail = AgentSession & {
  usage?: {
    used: number;
    size: number;
    cost: { amount: number; currency: string } | null;
    updatedAt: string;
  } | null;
  errorMessage?: string | null;
  messages: AgentMessage[];
  approvals: AgentApproval[];
};
export type LimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
};
export type AgentLimits = {
  machineId: string;
  provider: AgentProvider;
  accountId: string | null;
  status: 'available' | 'unsupported' | 'unauthenticated' | 'unavailable';
  reason?: 'provider' | 'api-key' | 'sign-in' | 'unavailable';
  fetchedAt: string;
  stale?: boolean;
  availableResets: number | null;
  buckets: {
    id: string;
    name: string;
    planType: string | null;
    primary: LimitWindow | null;
    secondary: LimitWindow | null;
    credits: {
      unlimited: boolean;
      hasCredits: boolean | null;
      balance: number | null;
    } | null;
  }[];
};
export type HubSnapshot = {
  accounts?: AgentAccount[];
  services: {
    id: string;
    name: string;
    machineId: string;
    repo: string;
    kind: string;
    status: string;
    domain?: string;
  }[];
  projects: HubProject[];
  sessions: AgentSession[];
  localMachineId?: string;
  host?: { name: string; platform: string; username: string };
  connection?: { connectorUrl: string | null };
};
export type AgentAccount = {
  id: string;
  provider: AgentProvider;
  vendor: string;
  name: string;
  status: 'pending' | 'connected' | 'disconnected' | 'error';
  authType?: 'api' | 'oauth';
  methodName?: string;
  email?: string | null;
  planType?: string | null;
  error?: string;
  pendingCleanup?: number;
  createdAt: string;
  updatedAt: string;
};
export type AccountLogin = AgentAccount & {
  login?: {
    url: string;
    userCode?: string;
    instructions?: string;
    mode: string;
  };
};
export type ModelChoice = { id: string; name: string; description?: string };
export type AgentModel = ModelChoice & {
  group?: string;
  isDefault?: boolean;
  reasoning: ModelChoice[];
  defaultReasoning: string;
};
export type ModelCatalog = {
  models: AgentModel[];
  defaultModelId: string;
  updatedAt: string;
};
export type AgentStatus = {
  installed: boolean;
  version?: string;
  ready?: boolean;
  missing?: boolean;
  error?: string;
  account: { type: string; email?: string; planType?: string } | null;
  models: AgentModel[];
  login?: { completed?: boolean; success?: boolean; error?: string };
};
export const providerNames = { codex: 'Codex', opencode: 'OpenCode' };
export const sessionLabels: Record<AgentSession['status'], string> = {
  idle: 'Готов',
  connecting: 'Подключение',
  running: 'Работает',
  approval: 'Нужен ответ',
  error: 'Ошибка',
  interrupted: 'Прерван',
};
export const activeSession = (session?: AgentSession | null) =>
  !!session && ['running', 'connecting', 'approval'].includes(session.status);

export function useHub(ws: Workspace) {
  const [data, setData] = useState<HubSnapshot>({
    projects: [],
    sessions: [],
    services: [],
  });
  const [error, setError] = useState('');
  const api = ws.api;
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const expected = ++revision.current;
    const next = await api<HubSnapshot>('/hub');
    if (expected === revision.current) {
      setData(next);
      setError('');
    }
    return next;
  }, [api]);
  useEffect(() => {
    setData({ projects: [], sessions: [], services: [] });
    if (!ws.connection) return;
    let alive = true,
      loading = false;
    const poll = async () => {
      if (loading) return;
      loading = true;
      const expected = revision.current;
      try {
        const next = await api<HubSnapshot>('/hub');
        if (alive && expected === revision.current) {
          setData(next);
          setError('');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ws.connection, api]);
  const mutate = useCallback(
    async <T>(
      path: string,
      body: Record<string, unknown> = {},
      method = 'POST',
    ) => {
      const result = await api<T>('/hub' + path, method, body);
      await refresh();
      return result;
    },
    [api, refresh],
  );
  return { data, error, refresh, mutate, api };
}
export type Hub = ReturnType<typeof useHub>;
