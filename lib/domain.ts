export type Status =
  | 'running'
  | 'stopped'
  | 'deploying'
  | 'failed'
  | 'pending'
  | 'success'
  | 'online'
  | 'offline'
  | 'needs_setup';
export type Server = {
  agentAccounts?: { codex?: string | null; opencode?: string | null };
  transport?: 'ssh' | 'local' | 'connector';
  platform?: string;
  homePath?: string;
  consoleUrl?: string;
  ipv4?: string;
  ipv6?: string;
  uptime?: number;
  networkRx?: number | null;
  networkTx?: number | null;
  history?: {
    at: string;
    cpu: number | null;
    memory: number | null;
    disk: number | null;
    networkRx?: number | null;
    networkTx?: number | null;
  }[];
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  status: Status;
  region: string;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  specs: string;
  fingerprint?: string;
  checkedAt?: string;
};
export type EnvDefinition = {
  name: string;
  required: boolean | null;
  description: string;
  defaultValue?: string;
};
export type AssistantPlan = {
  id: string;
  createdAt: string;
  commit: string;
  source: string;
  usage: { input: number; output: number } | null;
  summary: string;
  runtime: string;
  workdir: string;
  composeFile: string;
  appPort: number;
  notes: string[];
  blockers: string[];
  env: EnvDefinition[];
  files: string[];
  inspectedFiles: string[];
  omitted: number;
  appliedAt?: string;
};
export type LlmModel = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  configured: boolean;
  updatedAt?: string;
};
export type LlmConfig = {
  baseUrl: string;
  model: string;
  enabled: boolean;
  configured: boolean;
  updatedAt?: string;
  defaultModelId?: string;
  models: LlmModel[];
};
export type AdoptionCandidate = {
  id: string;
  runtime: 'compose' | 'docker' | 'systemd' | 'directory';
  name: string;
  directory: string;
  resources: string[];
  status: Status;
  images: string[];
  ports: string[];
  configFiles: string[];
  mounts: {
    type: string;
    source: string;
    target: string;
    name: string;
    readOnly: boolean;
  }[];
  git?: { root: string; repo: string; branch: string; commit: string } | null;
  repoMatch?: boolean;
  linkedProject?: string;
  unit?: string;
  description?: string;
};
export type Adoption = AdoptionCandidate & {
  linkedAt: string;
  checkedAt: string;
  envFile: string;
  environmentSource: string;
  environmentConflicts: string[];
  warnings: string[];
  sourceFiles: { path: string; bytes: number; sha256: string }[];
};
export type Discovery = {
  id: string;
  createdAt: string;
  directory: string;
  warnings: string[];
  candidates: AdoptionCandidate[];
};
export type Project = {
  adoption?: Adoption;
  discovery?: { id: string; createdAt: string; count: number };
  id: string;
  name: string;
  repo: string;
  branch: string;
  serverId: string;
  kind: 'web' | 'bot' | 'service';
  status: Status;
  domain: string;
  composeFile: string;
  autoDeploy: boolean;
  updatedAt: string;
  commit: string;
  color: string;
  envKeys: string[];
  envDefinitions?: EnvDefinition[];
  filledEnvKeys?: string[];
  gitConnectionId?: string;
  assistant?: AssistantPlan;
  workflow?: {
    id: string;
    summary: string;
    source: string;
    createdAt: string;
    verifiedAt?: string;
    stale?: boolean;
  };
  migrationDraft?: {
    choice?: 'manual';
    sourceId: string;
    targetId: string;
    jobId: string;
    mode: 'standard' | 'llm';
    updatedAt: string;
    conflictPolicy?: string;
  };
  migrationPlan?: MigrationPlan;
  savedMigrationPlan?: MigrationPlan;
  migrationArchives?: {
    serverId: string;
    path: string;
    createdAt: string;
    jobId: string;
    status?: 'creating' | 'complete' | 'failed';
  }[];
  migrationRepairPlan?: {
    id: string;
    jobId: string;
    expiresAt: string;
    assistant: {
      summary: string;
      model: string;
      configure: { description: string; command: string }[];
      check: string;
      questions: string[];
    };
  };
  migration?: MigrationState;
  removedAt?: string;
  diagnosis?: { summary: string; steps: string[] };
  publicUrl?: string;
  deploymentChecks?: { httpStatus: number | null; steps: string[] };
  requiredEnvKeys?: string[];
  missingEnvKeys?: string[];
};
export type MigrationPlan = {
  draftOptions?: {
    intent: string;
    paths: string[];
    units: string[];
    stopSignal: string;
  };

  conflictResolution?: {
    requiresStop?: boolean;
    policy?: 'ask' | 'archive-stopped' | 'stop-archive';
    available: boolean;
    selected: boolean;
    reason?: string;
    resources: string[];
    paths: string[];
    bytes?: number;
  };
  savedPlanId?: string;
  stopSignal?: string;
  id: string;
  jobId: string;
  sourceId: string;
  targetId: string;
  createdAt: string;
  expiresAt: string;
  runtime?: 'docker' | 'systemd';
  bytes: number;
  paths: { path: string; volume?: string; bytes: number }[];
  resources: string[];
  blockers: string[];
  warnings: string[];
  hasCustomCheck: boolean;
  mode?: 'standard' | 'llm';
  preparationIssues?: string[];
  assistant?: {
    summary: string;
    model: string;
    prepare: { description: string; command: string }[];
    configure: { description: string; command: string }[];
    questions: string[];
    notes: string[];
    check: string;
  } | null;
};
export type MigrationState = {
  jobId: string;
  sourceId: string;
  targetId: string;
  phase: string;
  locked: boolean;
  needsRecovery: boolean;
  targetMayHaveWritten: boolean;
  backupPath: string;
  finishedAt?: string;
};
export type Job = {
  id: string;
  projectId?: string;
  serverId?: string;
  modelId?: string;
  projectName: string;
  type:
    | 'discover'
    | 'adopt'
    | 'check'
    | 'analyze'
    | 'auto-deploy'
    | 'apply-plan'
    | 'diagnose'
    | 'domain'
    | 'build'
    | 'deploy'
    | 'restart'
    | 'stop'
    | 'migration'
    | 'migration-plan'
    | 'migration-recover'
    | 'migration-repair-plan'
    | 'provision'
    | 'chat'
    | 'remove'
    | 'project-forget';
  status: Status;
  createdAt: string;
  finishedAt?: string;
  source?: string;
  target?: string;
  cancelRequested?: boolean;
  outcome?: 'complete' | 'cancelled' | 'failed' | 'needs_input' | 'limit';
  usage?: { input: number; output: number; calls: number };
  logs: string[];
};
export type GitConnection = {
  id: string;
  login: string;
  name: string;
  createdAt: string;
};
export type Snapshot = {
  gitConnections?: GitConnection[];
  llm?: LlmConfig;
  projects: Project[];
  servers: Server[];
  jobs: Job[];
};
export const statusLabels: Record<Status, string> = {
  running: 'Работает',
  stopped: 'Остановлен',
  deploying: 'Выполняется',
  failed: 'Ошибка',
  pending: 'В очереди',
  success: 'Успешно',
  online: 'Доступен',
  offline: 'Недоступен',
  needs_setup: 'Нужна настройка',
};
export const jobLabels = {
  discover: 'Поиск на сервере',
  adopt: 'Привязка приложения',
  check: 'Проверка состояния',
  analyze: 'Анализ проекта',
  'auto-deploy': 'Автоматический деплой',
  'apply-plan': 'Деплой по плану',
  diagnose: 'Разбор ошибки',
  domain: 'Настройка домена',
  build: 'Сборка',
  deploy: 'Деплой',
  restart: 'Перезапуск',
  stop: 'Остановка',
  migration: 'Перенос',
  'migration-plan': 'Проверка переноса',
  'migration-recover': 'Восстановление переноса',
  'migration-repair-plan': 'План восстановления с LLM',
  provision: 'Настройка сервера',
  chat: 'Задача из чата',
  remove: 'Удаление развёртывания',
  'project-forget': 'Удаление из панели',
};
export const kindLabels = { web: 'Сайт', bot: 'Бот', service: 'Сервис' };
export function projectLabel(project: Project, servers: Server[]) {
  return `${project.name} · ${servers.find((s) => s.id === project.serverId)?.name || 'Сервер'} · ${project.id.slice(0, 8)}`;
}
export function relativeDate(value: string) {
  const m = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  return m < 1
    ? 'только что'
    : m < 60
      ? `${m} мин назад`
      : m < 1440
        ? `${Math.floor(m / 60)} ч назад`
        : `${Math.floor(m / 1440)} дн назад`;
}

export type Workflow = {
  id: string;
  summary: string;
  source: string;
  createdAt: string;
  deploy: string;
  stop: string;
  remove: string;
  check: string;
  logs: string;
  files: Record<string, string>;
};
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'command' | 'result' | 'system';
  content: string;
  createdAt: string;
  jobId?: string;
  success?: boolean;
};
