'use client';
import { useEffect, useRef, useState } from 'react';
import { MigrationDecisions } from './migration-progress';
import { cancellableJobs, jobStatus } from '@/lib/job-actions.mjs';
import { projectNamePattern, projectNameHint } from '@/lib/project-name.mjs';
import { ExistingProjectPanel, runtimeLabels } from './adopt-project';
import type { GitRepo } from './git-connections';
import { OperationsChat } from './operations-chat';
import { WorkflowPanel } from './workflow-panel';
import { DeploymentAssistant } from './deployment-assistant';
import { getEnvDefinitions } from '@/lib/env-requirements.mjs';
import {
  EnvironmentFields,
  EnvRequirement,
  EnvExplanation,
} from './environment-fields';
import { parseEnvDocument, serializeEnvDocument } from '@/lib/environment.mjs';
import {
  ArrowDownUp,
  ArrowRight,
  Check,
  Copy,
  Download,
  FileKey2,
  GitBranch,
  LockKeyhole,
  Play,
  RefreshCw,
  Server as ServerIcon,
  Square,
  Terminal,
  Trash2,
  Pencil,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetHeader,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { StatusBadge, JobStatusBadge, EmptyState } from './dashboard';
import { type Workspace } from '@/lib/use-workspace';
import {
  kindLabels,
  projectLabel,
  jobLabels,
  relativeDate,
  type Project,
  type Job,
  type Server,
} from '@/lib/domain';
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Picker({
  value,
  onChange,
  items,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (s: string) => void;
  items: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
}) {
  return (
    <Select
      disabled={disabled}
      value={value || null}
      items={items}
      onValueChange={(v) => onChange(String(v || ''))}
    >
      <SelectTrigger aria-label={label} className="picker">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function FormError({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="form-error">
      {error}
    </p>
  ) : null;
}
function ConnectionNote({ ws }: { ws: Workspace }) {
  return !ws.connection ? (
    <div className="inline-notice">
      Нет соединения с серверной частью. Подключитесь в настройках.
    </div>
  ) : null;
}

export function WorkspaceDialogs({
  modal,
  setModal,
  ws,
  onProject,
  onJob,
  confirmServer,
  setConfirmServer,
  migrationProjectId,
}: {
  modal: string;
  migrationProjectId?: string;
  setModal: (s: string) => void;
  ws: Workspace;
  onProject: (p: Project) => void;
  onJob: (j: Job) => void;
  confirmServer: Server | null;
  setConfirmServer: (s: Server | null) => void;
}) {
  const [error, setError] = useState('');
  return (
    <>
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open) setModal('');
        }}
      >
        <DialogContent
          className={
            'flow-dialog' + (modal === 'migration' ? ' migration-dialog' : '')
          }
        >
          <DialogHeader>
            <DialogTitle>
              {
                (
                  {
                    project: 'Новый проект',
                    server: 'Подключить сервер',
                    migration: 'Перенести проект',
                    connect: 'Подключить исполнитель',
                  } as Record<string, string>
                )[modal]
              }
            </DialogTitle>
            <DialogDescription>
              {
                (
                  {
                    project:
                      'Репозиторий, сервер и переменные — всё для первого запуска.',
                    server: 'Подключение по SSH с проверкой ключа сервера.',
                    migration:
                      'Проверка, копирование данных и запуск проекта на новом сервере.',
                    connect: 'Укажите адрес API и ключ вашего пространства.',
                  } as Record<string, string>
                )[modal]
              }
            </DialogDescription>
          </DialogHeader>
          {modal === 'project' && (
            <AddProject
              ws={ws}
              onServer={() => setModal('server')}
              onDone={(p) => {
                setModal('');
                onProject(p);
              }}
            />
          )}
          {modal === 'server' && (
            <ServerForm ws={ws} onDone={() => setModal('')} />
          )}{' '}
          {modal === 'migration' && (
            <MigrationForm
              ws={ws}
              initialProjectId={migrationProjectId}
              onDone={(j) => {
                setModal('');
                onJob(j);
              }}
            />
          )}
          {modal === 'connect' && (
            <ConnectionForm ws={ws} onDone={() => setModal('')} />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!confirmServer}
        onOpenChange={(v) => {
          if (!v) {
            setConfirmServer(null);
            setError('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Настроить {confirmServer?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            На Ubuntu 24.04 и 26.04 будут установлены Docker, Docker Compose и
            Git. Существующие проекты сохранятся. Сервер не будет перезагружен.
          </AlertDialogDescription>
          <FormError error={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ws.busy}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={ws.busy}
              onClick={async () => {
                try {
                  const j = await ws.action(
                    `/servers/${confirmServer?.id}/provision`,
                  );
                  setConfirmServer(null);
                  onJob(j);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {ws.busy ? 'Запускаем…' : 'Установить и настроить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
function AddProject({
  ws,
  onDone,
  onServer,
}: {
  ws: Workspace;
  onDone: (p: Project) => void;
  onServer: () => void;
}) {
  const [serverId, setServerId] = useState(
    ws.data.servers.find((s) => s.status === 'online')?.id || '',
  );
  const [kind, setKind] = useState('web');
  const [env, setEnv] = useState(() => parseEnvDocument(''));
  const [auto, setAuto] = useState(false);
  const [gitConnectionId, setGitConnectionId] = useState('');
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [projectName, setProjectName] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  async function loadRepos(id: string, nextPage = 1) {
    setGitConnectionId(id);
    setError('');
    setLoadingRepos(true);
    try {
      if (!id) {
        setRepos([]);
        setHasMore(false);
        return;
      }
      const result = await ws.api<{ repos: GitRepo[]; hasMore: boolean }>(
        `/git/connections/${id}/repos?page=${nextPage}`,
      );
      setRepos((previous) =>
        nextPage === 1 ? result.repos : [...previous, ...result.repos],
      );
      setHasMore(result.hasMore);
      setPage(nextPage);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingRepos(false);
    }
  }
  const [error, setError] = useState('');
  if (!ws.data.servers.length)
    return (
      <EmptyState
        title="Сначала подключите сервер"
        description="Проекту нужно место для запуска."
        action={<Button onClick={onServer}>Подключить сервер</Button>}
      />
    );
  return (
    <form
      className="flow-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        if (!serverId) return setError('Выберите сервер');
        const fields = Object.fromEntries(new FormData(e.currentTarget));
        try {
          const p = await ws.action<Project>('/projects', {
            ...fields,
            serverId,
            kind,
            env: serializeEnvDocument(env),
            autoDeploy: auto,
            gitConnectionId,
            resolveDefaultBranch: true,
          });
          setEnv(parseEnvDocument(''));
          onDone(p);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <ConnectionNote ws={ws} />
      <p className="inline-notice">
        Сначала создадим карточку. Затем можно проверить настройки, подготовить
        план и запустить деплой. Уже работающее приложение можно привязать во
        вкладке «Обзор».
      </p>
      <Field
        label="Доступ к GitHub"
        hint="Аккаунты подключаются в Настройках → GitHub."
      >
        <Picker
          label="GitHub-аккаунт"
          value={gitConnectionId || 'public'}
          onChange={(id) => void loadRepos(id === 'public' ? '' : id)}
          items={[
            { value: 'public', label: 'Публичный репозиторий' },
            ...(ws.data.gitConnections || []).map((c) => ({
              value: c.id,
              label: c.login,
            })),
          ]}
        />
      </Field>
      {gitConnectionId && (
        <div className="form-field">
          <span>Репозитории аккаунта</span>
          {loadingRepos ? (
            <small>Загружаем…</small>
          ) : (
            <Picker
              value={repo}
              label="Выберите репозиторий"
              onChange={(url) => {
                setRepo(url);
                setBranch(repos.find((r) => r.repo === url)?.branch || 'main');
              }}
              items={repos.map((r) => ({
                value: r.repo,
                label: r.fullName + (r.private ? ' · приватный' : ''),
              }))}
            />
          )}{' '}
          {hasMore && (
            <Button
              type="button"
              variant="outline"
              disabled={loadingRepos}
              onClick={() => void loadRepos(gitConnectionId, page + 1)}
            >
              Загрузить ещё
            </Button>
          )}
        </div>
      )}
      <Field
        label="Git-репозиторий"
        hint="Ссылка на сам репозиторий, например https://github.com/owner/repo, без /tree/ или /blob/. Один репозиторий можно добавить несколько раз. Для приватного выберите GitHub-аккаунт."
      >
        <Input
          name="repo"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          type="url"
          placeholder="https://github.com/username/project"
          required
        />
      </Field>
      <div className="form-row">
        <Field label="Имя проекта" hint={projectNameHint}>
          <Input
            name="name"
            value={
              projectName ??
              (repo.split('/').filter(Boolean).at(-1) || '')
                .replace(/\.git$/, '')
                .replace(/[^\p{L}\p{N} ._-]/gu, '-')
                .replace(/^[^\p{L}\p{N}]/u, 'app-')
                .slice(0, 80)
            }
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="my-awesome-project"
            required
            pattern={projectNamePattern}
            title={projectNameHint}
            maxLength={80}
          />
        </Field>
        <Field label="Ветка">
          <Input
            name="branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="Основная ветка репозитория"
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Сервер">
          <Picker
            label="Выберите сервер"
            value={serverId}
            onChange={setServerId}
            items={ws.data.servers.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label="Тип проекта">
          <Picker
            label="Тип проекта"
            value={kind}
            onChange={setKind}
            items={[
              { value: 'web', label: 'Сайт' },
              { value: 'bot', label: 'Бот' },
              { value: 'service', label: 'Сервис' },
            ]}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field
          label="Compose-файл"
          hint="Конфигурацию можно подготовить после создания проекта."
        >
          <Input name="composeFile" defaultValue="compose.yaml" required />
        </Field>
        <Field
          label="Домен / описание"
          hint="Настроить домен и HTTPS можно после создания проекта."
        >
          <Input name="domain" placeholder="app.example.com" />
        </Field>
      </div>
      <EnvironmentFields document={env} onChange={setEnv} disabled={ws.busy} />
      <div className="switch-line">
        <div>
          <strong>
            <Zap size={16} />
            Автодеплой из GitHub
          </strong>
          <small>После создания настройте webhook в разделе CI/CD.</small>
        </div>
        <Switch
          checked={auto}
          onCheckedChange={setAuto}
          aria-label="Автодеплой"
        />
      </div>
      <FormError error={error} />
      <Button
        type="submit"
        className="primary-button full-width"
        disabled={ws.busy}
      >
        {ws.busy ? 'Сохраняем…' : 'Создать проект'}
        <ArrowRight size={16} />
      </Button>
    </form>
  );
}
export function EditServer({
  server,
  ws,
  onClose,
  onSaved,
}: {
  server: Server | null;
  ws: Workspace;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog
      open={!!server}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flow-dialog">
        <DialogHeader>
          <DialogTitle>Редактировать сервер</DialogTitle>
          <DialogDescription>
            Название, расположение и параметры подключения по SSH.
          </DialogDescription>
        </DialogHeader>
        {server && (
          <ServerForm
            key={server.id}
            server={server}
            ws={ws}
            onDone={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
function ServerForm({
  ws,
  onDone,
  server,
}: {
  ws: Workspace;
  onDone: () => void;
  server?: Server;
}) {
  const [host, setHost] = useState(server?.host || '');
  const [port, setPort] = useState(String(server?.port || 22));
  const [name, setName] = useState(server?.name || '');
  const [fingerprint, setFingerprint] = useState(server?.fingerprint || '');
  const [trusted, setTrusted] = useState(!!server?.fingerprint);
  const [auth, setAuth] = useState(server ? 'keep' : 'password');
  const [error, setError] = useState('');
  const pending =
    ws.busy ||
    (!!server &&
      ws.data.jobs.some(
        (job) =>
          ['pending', 'deploying'].includes(job.status) &&
          (job.serverId === server.id ||
            job.target === server.id ||
            ws.data.projects.some(
              (p) => p.serverId === server.id && p.id === job.projectId,
            )),
      ));
  const reset = () => {
    setFingerprint('');
    setTrusted(false);
  };
  return (
    <form
      className="flow-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        if (!fingerprint || !trusted)
          return setError('Получите и подтвердите отпечаток SSH-ключа');
        const body = Object.fromEntries(new FormData(e.currentTarget));
        try {
          await ws.action(
            server ? '/servers/' + server.id : '/servers',
            {
              ...body,
              name,
              host,
              port: Number(port),
              username: 'root',
              fingerprint,
            },
            server ? 'PATCH' : 'POST',
          );
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <ConnectionNote ws={ws} />
      {server && (
        <p className="detail-copy">
          Новый пароль или ключ проверим перед сохранением. Адрес можно изменить
          для этого же сервера; для переезда проектов используйте «Перенос
          проектов».
        </p>
      )}
      <fieldset className="server-settings-fields" disabled={pending}>
        <Field label="Имя сервера">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="production-01"
            required
            maxLength={64}
          />
        </Field>
        <div className="form-row">
          <Field label="IP-адрес">
            <Input
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                reset();
              }}
              placeholder="203.0.113.10"
              required
            />
          </Field>
          <Field label="SSH-порт">
            <Input
              value={port}
              onChange={(e) => {
                setPort(e.target.value);
                reset();
              }}
              type="number"
              min={1}
              max={65535}
              required
            />
          </Field>
        </div>
        <Field label="Расположение (необязательно)">
          <Input
            name="region"
            defaultValue={server?.region || ''}
            placeholder="Frankfurt, DE"
            maxLength={80}
          />
        </Field>
        <div className="fingerprint-box">
          <Button
            type="button"
            variant="outline"
            disabled={pending || !host || !name}
            onClick={async () => {
              setError('');
              try {
                const result = await ws.action<{ fingerprint: string }>(
                  '/servers/fingerprint',
                  { host, port: Number(port), username: 'root', name },
                );
                setFingerprint(result.fingerprint);
                setTrusted(false);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <LockKeyhole size={15} />
            {ws.busy ? 'Проверяем…' : 'Получить ключ сервера'}
          </Button>
          {fingerprint && (
            <>
              <code>{fingerprint}</code>
              <label className="check-line" htmlFor="trust-host-key">
                <Checkbox
                  id="trust-host-key"
                  checked={trusted}
                  onCheckedChange={(v) => setTrusted(!!v)}
                />
                Отпечаток совпадает с ключом в консоли провайдера
              </label>
            </>
          )}
          <small>
            Получение ключа ещё не подтверждает подлинность сервера.
          </small>
        </div>
        <Field label="Способ входа (root)">
          <Picker
            label="Способ входа"
            value={auth}
            onChange={setAuth}
            items={[
              ...(server
                ? [{ value: 'keep', label: 'Оставить текущий доступ' }]
                : []),
              { value: 'password', label: 'Пароль' },
              { value: 'privateKey', label: 'SSH-ключ' },
            ]}
          />
        </Field>
        {auth === 'password' ? (
          <Field label="Root-пароль">
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder={
                server ? 'Пустое поле — оставить текущий доступ' : undefined
              }
              required={!server}
            />
          </Field>
        ) : auth === 'privateKey' ? (
          <Field
            label="Приватный SSH-ключ"
            hint="В этой версии поддерживаются ключи без passphrase."
          >
            <Textarea
              name="privateKey"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              required={!server}
              rows={4}
            />
          </Field>
        ) : null}
        <p className="secure-note">
          <LockKeyhole size={14} />
          Доступ хранится в зашифрованном виде у исполнителя.
        </p>
        <FormError error={error} />
        <Button
          className="primary-button full-width"
          type="submit"
          disabled={pending || !trusted}
        >
          {pending
            ? 'Сохраняем…'
            : server
              ? 'Сохранить изменения'
              : 'Подключить сервер'}
          <ArrowRight size={16} />
        </Button>
      </fieldset>
    </form>
  );
}
function MigrationForm({
  ws,
  onDone,
  initialProjectId = '',
}: {
  ws: Workspace;
  onDone: (j: Job) => void;
  initialProjectId?: string;
}) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<'standard' | 'llm'>('standard');
  const [intent, setIntent] = useState('');
  const [answer, setAnswer] = useState('');
  const [conflictPolicy, setConflictPolicy] = useState<
    'ask' | 'archive-stopped' | 'stop-archive'
  >('ask');
  const [manual, setManual] = useState(false);
  const directionRef = useRef<HTMLDivElement>(null);
  const restoredProject = useRef('');
  const [confirmed, setConfirmed] = useState(false);
  const [paths, setPaths] = useState('');
  const [units, setUnits] = useState('');
  const [check, setCheck] = useState('');
  const [stopSignal, setStopSignal] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [repairScanId, setRepairScanId] = useState<string | null>(null);
  const p = ws.data.projects.find((p) => p.id === projectId);
  const matches = (candidate: Project['migrationPlan']) =>
    candidate?.sourceId === p?.serverId &&
    candidate?.targetId === target &&
    (candidate?.mode || 'standard') === mode;
  const plan =
    matches(p?.migrationPlan) && p?.migrationPlan?.jobId === scanId
      ? p.migrationPlan
      : null;
  const saved = [p?.savedMigrationPlan, p?.migrationPlan].find(
    (candidate) => matches(candidate) && candidate?.assistant,
  );
  useEffect(() => {
    if (!p || restoredProject.current === p.id) return;
    restoredProject.current = p.id;
    const completedAt = ['complete', 'awaiting_dns'].includes(
      p.migration?.phase || '',
    )
      ? Date.parse(p.migration?.finishedAt || '')
      : 0;
    const latest = [p.migrationPlan, p.savedMigrationPlan].find(
      (candidate) =>
        candidate?.sourceId === p.serverId &&
        (!completedAt || Date.parse(candidate.createdAt) > completedAt),
    );
    const draft =
      p.migrationDraft?.sourceId === p.serverId &&
      (!completedAt || Date.parse(p.migrationDraft.updatedAt) > completedAt)
        ? p.migrationDraft
        : null;
    if (
      draft &&
      (!latest || Date.parse(draft.updatedAt) > Date.parse(latest.createdAt))
    ) {
      setTarget(draft.targetId);
      setMode(draft.mode);
      setScanId(draft.jobId);
      setManual(draft.choice === 'manual');
    } else if (latest) {
      setTarget(latest.targetId);
      setMode(latest.mode || 'standard');
      setScanId(latest.jobId);
      setStopSignal(latest.stopSignal || '');
      setIntent(latest.draftOptions?.intent || '');
      setPaths(latest.draftOptions?.paths.join('\n') || '');
      setUnits(latest.draftOptions?.units.join('\n') || '');
      setConflictPolicy(
        latest.conflictResolution?.policy ||
          (latest.conflictResolution?.selected ? 'archive-stopped' : 'ask'),
      );
    }
    if (p.migration?.needsRecovery) {
      setTarget(p.migration.targetId);
      if (p.migrationRepairPlan) {
        setRepairScanId(p.migrationRepairPlan.jobId);
        setMode('llm');
      }
    }
    setConfirmed(false);
  }, [p]);
  useEffect(() => {
    if (!plan) return;
    setConflictPolicy(
      plan.conflictResolution?.policy ||
        (plan.conflictResolution?.selected ? 'archive-stopped' : 'ask'),
    );
    setConfirmed(false);
  }, [plan?.id]);
  const repairPlan =
    p?.migrationRepairPlan?.jobId === repairScanId
      ? p.migrationRepairPlan
      : null;
  const scanJob = ws.data.jobs.find((j) => j.id === scanId);
  const repairJob = ws.data.jobs.find((j) => j.id === repairScanId);
  const recovery = p?.migration?.locked && p.migration.needsRecovery;
  const active =
    ws.busy ||
    ws.data.jobs.some(
      (j) =>
        ['pending', 'deploying'].includes(j.status) &&
        (j.projectId === projectId ||
          j.serverId === target ||
          j.target === target),
    );
  const bytes = (n: number) =>
    n < 1024 * 1024
      ? Math.ceil(n / 1024) + ' КБ'
      : n < 1024 * 1024 * 1024
        ? (n / 1024 / 1024).toFixed(1) + ' МБ'
        : (n / 1024 / 1024 / 1024).toFixed(1) + ' ГБ';
  const changed = () => {
    setScanId(null);
    setRepairScanId(null);
    setConfirmed(false);
  };
  async function prepare(
    savedPlanId?: string,
    policy = conflictPolicy,
    clarification = '',
  ) {
    if (!p || !target) return;
    setError('');
    setManual(false);
    setConfirmed(false);
    setScanId(null);
    try {
      const job = await ws.action<Job>(
        '/projects/' + p.id + '/migration-plan',
        {
          target,
          savedPlanId,
          options: {
            mode,
            intent: [
              intent,
              clarification && 'Ответ владельца: ' + clarification,
            ]
              .filter(Boolean)
              .join('\n'),
            conflictPolicy: policy,
            stopSignal,
            paths: paths.split('\n').filter(Boolean),
            units: units.split('\n').filter(Boolean),
            check,
          },
        },
      );
      setScanId(job.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <form
      className="flow-form migration-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        try {
          if (!p || !target || !plan || !confirmed || plan.blockers.length)
            throw new Error('Выполните проверку и подтвердите состав переноса');
          onDone(
            await ws.action('/projects/' + p.id + '/migrate', {
              target,
              planId: plan.id,
              confirmDowntime: true,
              confirmManifest: true,
              confirmLlmCommands: mode === 'llm',
              confirmConflictArchive: !!plan.conflictResolution?.selected,
              confirmConflictStop: !!plan.conflictResolution?.requiresStop,
            }),
          );
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <ConnectionNote ws={ws} />
      <ol className="migration-stepper" aria-label="Этапы переноса">
        <li className={p && target ? 'is-done' : 'is-current'}>
          <span>1</span>Направление
        </li>
        <li
          className={
            plan && !plan.blockers.length
              ? 'is-done'
              : p && target
                ? 'is-current'
                : ''
          }
        >
          <span>2</span>План и решения
        </li>
        <li
          className={
            recovery || (plan && !plan.blockers.length) ? 'is-current' : ''
          }
        >
          <span>3</span>Перенос
        </li>
      </ol>
      {p && target && (
        <div className="migration-route migration-route-summary">
          <strong>{p.name}</strong>
          <span>{ws.data.servers.find((s) => s.id === p.serverId)?.name}</span>
          <ArrowRight size={16} />
          <span>{ws.data.servers.find((s) => s.id === target)?.name}</span>
        </div>
      )}
      {active && (
        <p className="inline-notice" role="status">
          Выполняется операция. Можно закрыть окно: продолжение останется во
          вкладке «Перенос проектов».
        </p>
      )}
      {plan?.conflictResolution && !recovery && (
        <MigrationDecisions
          key={plan.id}
          plan={plan}
          busy={active}
          manual={manual}
          onChoice={(choice) => {
            setConfirmed(false);
            if (choice === 'server') {
              setTarget('');
              changed();
              directionRef.current?.focus();
            } else if (choice === 'manual') {
              setManual(true);
              setConflictPolicy('ask');
              void ws
                .action('/projects/' + p!.id + '/migration-choice', {
                  planId: plan.id,
                  choice: 'manual',
                })
                .catch((e) => setError((e as Error).message));
            } else {
              setConflictPolicy(choice);
              prepare(plan.id, choice);
            }
          }}
          onRecheck={() => prepare(plan.id, 'ask')}
        />
      )}
      <details className="migration-direction" open={!p || !target}>
        <summary>Проект и направление</summary>
        <div>
          <Field label="Проект">
            <Picker
              label="Выберите проект"
              disabled={active}
              value={projectId}
              onChange={(id) => {
                setProjectId(id);
                setTarget('');
                changed();
              }}
              items={ws.data.projects
                .filter(
                  (p) => p.status === 'running' || p.migration?.needsRecovery,
                )
                .map((p) => ({
                  value: p.id,
                  label: projectLabel(p, ws.data.servers),
                }))}
            />
          </Field>
          {p && (
            <div className="source-server">
              <ServerIcon size={17} />
              Сейчас на {ws.data.servers.find((s) => s.id === p.serverId)?.name}
            </div>
          )}
          <Field label="Способ переноса">
            <Picker
              label="Способ переноса"
              value={mode}
              disabled={active}
              onChange={(value) => {
                setMode(value as 'standard' | 'llm');
                changed();
              }}
              items={[
                { value: 'standard', label: 'Обычный — без LLM' },
                { value: 'llm', label: 'С помощью LLM' },
              ]}
            />
          </Field>
          {mode === 'llm' && (
            <>
              <p className="inline-notice">
                Помощник ищет дополнительные данные и зависимости, составляет
                команды подготовки сервера и настройки приложения. Команды можно
                проверить до начала переноса.
              </p>
              {!ws.data.llm?.enabled && (
                <p className="form-error">
                  Для нового плана включите LLM в настройках. Сохранённый план
                  можно проверить без обращения к провайдеру.
                </p>
              )}
              <Field
                label="Что учесть при переносе"
                hint="Например: причина ошибки обычного переноса, дополнительные данные или особенности VPN. Ключи и пароли сюда вводить не нужно."
              >
                <Textarea
                  rows={3}
                  value={intent}
                  disabled={active}
                  onChange={(e) => {
                    setIntent(e.target.value);
                    changed();
                  }}
                />
              </Field>
            </>
          )}
        </div>
      </details>
      {recovery && p?.migration ? (
        <div className="migration-report">
          <strong>Перенос требует восстановления</strong>
          {mode === 'llm' && p.migration.targetMayHaveWritten && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={active || !ws.data.llm?.enabled}
                onClick={async () => {
                  setError('');
                  setConfirmed(false);
                  setRepairScanId(null);
                  try {
                    const job = await ws.action<Job>(
                      '/projects/' + p.id + '/migration-repair-plan',
                      { options: { intent } },
                    );
                    setRepairScanId(job.id);
                  } catch (error) {
                    setError((error as Error).message);
                  }
                }}
              >
                Подготовить восстановление с LLM
              </Button>
              {repairScanId && !repairPlan && (
                <p>
                  {repairJob?.status === 'failed'
                    ? repairJob.logs.at(-1) ||
                      'Не удалось составить план. Повторите проверку.'
                    : 'Помощник изучает ошибку и новую копию. Данные остаются на месте.'}
                </p>
              )}
              {repairPlan && (
                <>
                  <p>{repairPlan.assistant.summary}</p>
                  {repairPlan.assistant.configure.map((step, i) => (
                    <details key={i} className="migration-options">
                      <summary>{step.description}</summary>
                      <pre className="migration-command">
                        <code>{step.command}</code>
                      </pre>
                    </details>
                  ))}
                  {repairPlan.assistant.check && (
                    <details className="migration-options">
                      <summary>Проверка после восстановления</summary>
                      <pre className="migration-command">
                        <code>{repairPlan.assistant.check}</code>
                      </pre>
                    </details>
                  )}
                  {!!repairPlan.assistant.questions.length && (
                    <ul className="form-error">
                      {repairPlan.assistant.questions.map((q) => (
                        <li key={q}>{q}</li>
                      ))}
                    </ul>
                  )}
                  {Date.parse(repairPlan.expiresAt) < now && (
                    <p className="form-error">
                      План устарел. Подготовьте восстановление ещё раз.
                    </p>
                  )}
                  <label className="check-line">
                    <Checkbox
                      checked={confirmed}
                      onCheckedChange={(v) => setConfirmed(!!v)}
                      disabled={
                        active || !!repairPlan.assistant.questions.length
                      }
                    />{' '}
                    Проверил команды и разрешаю их выполнение на новой копии
                  </label>
                </>
              )}
            </>
          )}
          <p>
            {p.migration.targetMayHaveWritten
              ? 'Новая копия могла получить данные. Исходную копию запускать нельзя. Исправьте причину ошибки на новом сервере и повторите запуск с проверкой.'
              : 'Новая копия ещё не запускалась. Можно восстановить работу исходного приложения.'}
          </p>
          <p>
            Резервная копия: <code>{p.migration.backupPath}</code>
          </p>
          <Button
            type="button"
            className="primary-button"
            disabled={
              active ||
              (mode === 'llm' &&
                p.migration.targetMayHaveWritten &&
                (!repairPlan ||
                  !confirmed ||
                  !!repairPlan.assistant.questions.length ||
                  Date.parse(repairPlan.expiresAt) < now))
            }
            onClick={async () => {
              setError('');
              try {
                onDone(
                  await ws.action(
                    '/projects/' + p.id + '/migration-recover',
                    mode === 'llm' && p.migration?.targetMayHaveWritten
                      ? {
                          repairPlanId: repairPlan?.id,
                          confirmLlmCommands: true,
                        }
                      : {},
                  ),
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {p.migration.targetMayHaveWritten
              ? 'Восстановить запуск на новом сервере'
              : 'Вернуть исходный проект в работу'}
          </Button>
        </div>
      ) : (
        <>
          <div className="migration-target" ref={directionRef} tabIndex={-1}>
            <Field label="Новый сервер">
              <Picker
                label="Выберите целевой сервер"
                disabled={active}
                value={target}
                onChange={(id) => {
                  setTarget(id);
                  changed();
                }}
                items={ws.data.servers
                  .filter((s) => s.id !== p?.serverId && s.status === 'online')
                  .map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
          </div>
          {saved && (
            <details className="migration-report migration-saved">
              <summary>Сохранённый план и повторная проверка</summary>
              <strong>Сохранённый план LLM</strong>
              <p>{saved.assistant?.summary}</p>
              <p>
                Создан {new Date(saved.createdAt).toLocaleString('ru-RU')}. План
                сохраняется после закрытия панели. Перед переносом проверим
                актуальное состояние серверов.
              </p>
              <details className="migration-options">
                <summary>Команды сохранённого плана</summary>
                {[
                  ...(saved.assistant?.prepare || []),
                  ...(saved.assistant?.configure || []),
                ].map((step, i) => (
                  <div key={i}>
                    <p>{step.description}</p>
                    <pre className="migration-command">
                      <code>{step.command}</code>
                    </pre>
                  </div>
                ))}
                {saved.assistant?.check && (
                  <pre className="migration-command">
                    <code>{saved.assistant.check}</code>
                  </pre>
                )}
              </details>
              <Button
                type="button"
                variant="outline"
                disabled={active}
                onClick={() => prepare(saved.id)}
              >
                Проверить серверы по сохранённому плану
              </Button>
              <small>
                Без запроса к LLM. Используются данные и команды этого плана;
                способ разрешения конфликтов — выбранный выше.
              </small>
            </details>
          )}
          <details className="migration-options">
            <summary>Дополнительные данные и проверка приложения</summary>
            <Field
              label="Сигнал остановки Docker"
              hint="По умолчанию используется настройка контейнера. Другой сигнал выбирайте, если приложение корректно обрабатывает его. Он сохранится на новой копии."
            >
              <Picker
                label="Сигнал остановки"
                value={stopSignal || 'default'}
                disabled={active}
                onChange={(v) => {
                  setStopSignal(v === 'default' ? '' : v);
                  changed();
                }}
                items={[
                  { value: 'default', label: 'Из настроек контейнера' },
                  { value: 'SIGTERM', label: 'SIGTERM — завершение' },
                  { value: 'SIGINT', label: 'SIGINT — прерывание' },
                  { value: 'SIGQUIT', label: 'SIGQUIT — выход' },
                ]}
              />
            </Field>
            <Field
              label="Дополнительные пути"
              hint="Полные пути, по одному в строке. Каталоги приложения и подключённые Docker volumes определяются автоматически."
            >
              <Textarea
                value={paths}
                onChange={(e) => {
                  setPaths(e.target.value);
                  changed();
                }}
                rows={3}
                disabled={active}
                placeholder="/var/lib/my-app"
              />
            </Field>
            <Field
              label="Службы systemd"
              hint="Для своего способа запуска укажите все службы проекта, по одной в строке."
            >
              <Textarea
                value={units}
                onChange={(e) => {
                  setUnits(e.target.value);
                  changed();
                }}
                rows={2}
                disabled={active}
                placeholder="my-app.service"
              />
            </Field>
            <Field
              label="Команда проверки на новом сервере"
              hint="Выполняется после запуска из каталога проекта. Код 0 означает успех. Используйте проверку без изменения данных."
            >
              <Textarea
                value={check}
                onChange={(e) => {
                  setCheck(e.target.value);
                  changed();
                }}
                rows={3}
                disabled={active}
                placeholder="curl --fail http://127.0.0.1:8080/health"
              />
            </Field>
          </details>
          <Button
            type="button"
            variant="outline"
            disabled={
              active ||
              !p ||
              !target ||
              (mode === 'llm' && !ws.data.llm?.enabled)
            }
            onClick={() => prepare()}
          >
            <RefreshCw size={16} />
            {active
              ? 'Проверяем…'
              : mode === 'llm'
                ? saved
                  ? 'Создать новый план с LLM'
                  : 'Составить план с LLM'
                : 'Проверить перенос'}
          </Button>
          {scanId && !plan && (
            <p className="inline-notice">
              {scanJob?.status === 'failed'
                ? 'Проверка не завершена. Откройте журнал ошибки и повторите её.'
                : 'Проверяем серверы и состав данных. Приложение продолжает работать.'}
            </p>
          )}
          {plan && (
            <div className="migration-report" aria-live="polite">
              <strong>
                {plan.blockers.length
                  ? 'Нужно исправить перед переносом'
                  : 'Состав переноса проверен'}
              </strong>
              <p>
                {plan.runtime === 'docker'
                  ? 'Контейнеры Docker'
                  : plan.runtime === 'systemd'
                    ? 'Службы systemd'
                    : 'Способ запуска не определён'}{' '}
                · около {bytes(plan.bytes)}
              </p>
              <ul>
                {plan.resources.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="migration-paths">
                {plan.paths.map((d) => (
                  <div key={d.path}>
                    <code>{d.volume ? 'Том ' + d.volume : d.path}</code>
                    <span>{bytes(d.bytes)}</span>
                  </div>
                ))}
              </div>
              {plan.assistant && (
                <>
                  <p>
                    <strong>План LLM · {plan.assistant.model}</strong>
                  </p>
                  <p>{plan.assistant.summary}</p>
                  {plan.preparationIssues?.length ? (
                    <div className="inline-notice">
                      После подготовки сервера повторно проверим:
                      <ul>
                        {plan.preparationIssues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {[
                    {
                      title: 'Подготовка нового сервера',
                      steps: plan.assistant.prepare,
                    },
                    {
                      title: 'Настройка после копирования',
                      steps: plan.assistant.configure,
                    },
                  ].map(
                    (stage) =>
                      stage.steps.length > 0 && (
                        <details
                          key={stage.title}
                          className="migration-options"
                        >
                          <summary>
                            {stage.title} · {stage.steps.length}
                          </summary>
                          {stage.steps.map((step, i) => (
                            <div key={i}>
                              <p>{step.description}</p>
                              <pre className="migration-command">
                                <code>{step.command}</code>
                              </pre>
                            </div>
                          ))}
                        </details>
                      ),
                  )}
                  {plan.assistant.check && (
                    <details className="migration-options">
                      <summary>Проверка приложения</summary>
                      <pre className="migration-command">
                        <code>{plan.assistant.check}</code>
                      </pre>
                    </details>
                  )}
                </>
              )}
              {plan.stopSignal && (
                <p>
                  Сигнал остановки контейнеров:{' '}
                  <strong>{plan.stopSignal}</strong>
                </p>
              )}
              {mode === 'llm' && !!plan.blockers.length && (
                <Field
                  label="Ответ помощнику или другой способ решения"
                  hint="Например: сохранить прежнюю копию отдельно; установить недостающую зависимость; объяснить, какие данные относятся к этому проекту."
                >
                  <Textarea
                    rows={3}
                    value={answer}
                    disabled={active}
                    onChange={(e) => setAnswer(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={active || !answer.trim() || !ws.data.llm?.enabled}
                    onClick={() => prepare(undefined, conflictPolicy, answer)}
                  >
                    Уточнить план с LLM
                  </Button>
                </Field>
              )}
              {!!plan.blockers.length && (
                <details className="migration-issues">
                  <summary>Причины и вопросы проверки</summary>
                  <ul className="form-error">
                    {plan.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </details>
              )}
              {!!plan.warnings.length && (
                <ul>
                  {plan.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {plan && Date.parse(plan.expiresAt) < now && (
            <p className="form-error">
              Проверка серверов устарела. Проверьте сохранённый план ещё раз —
              повторная генерация LLM не нужна.
            </p>
          )}
          {scanId && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                const job = ws.data.jobs.find((j) => j.id === scanId);
                if (job) onDone(job);
              }}
            >
              Открыть логи проверки <ArrowRight size={15} />
            </Button>
          )}
          <div className="inline-notice">
            Во время переноса приложение недоступно. Исходная копия и резервные
            архивы сохраняются. Если новая копия уже запускалась, возврат к
            старым данным автоматически не выполняется.
          </div>
          <label className="check-line" htmlFor="confirm-migration-downtime">
            <Checkbox
              id="confirm-migration-downtime"
              checked={confirmed}
              disabled={active || !plan || !!plan.blockers.length || manual}
              onCheckedChange={(v) => setConfirmed(!!v)}
            />
            Проверил полный состав данных и понимаю, что приложение будет
            остановлено на время переноса
            {mode === 'llm'
              ? '; разрешаю выполнение показанных команд' +
                (plan?.conflictResolution?.selected
                  ? plan.conflictResolution.requiresStop
                    ? ' и остановку с архивированием перечисленных ресурсов на новом сервере'
                    : ' и архивирование перечисленных конфликтующих ресурсов на новом сервере'
                  : ' на новом сервере')
              : ''}
          </label>
          <Button
            className="primary-button full-width"
            type="submit"
            disabled={
              active ||
              !confirmed ||
              !plan ||
              !!plan.blockers.length ||
              manual ||
              (plan.conflictResolution?.selected &&
                conflictPolicy !==
                  (plan.conflictResolution.policy || 'archive-stopped')) ||
              Date.parse(plan.expiresAt) < now
            }
          >
            <ArrowDownUp size={16} />
            {active ? 'Выполняется операция…' : 'Начать перенос'}
          </Button>
        </>
      )}
      {!!p?.migrationArchives?.length && (
        <details className="migration-options">
          <summary>Архивы прежних копий</summary>
          {p.migrationArchives.map((item) => (
            <p key={item.path}>
              {
                ws.data.servers.find((server) => server.id === item.serverId)
                  ?.name
              }
              <br />
              <code>{item.path}</code>
              <br />
              {item.status === 'complete'
                ? 'Архив проверен'
                : item.status === 'failed'
                  ? 'Архивирование не завершено — см. журнал операции'
                  : 'Архивирование начато'}
            </p>
          ))}
        </details>
      )}
      <FormError error={error} />
    </form>
  );
}
function ConnectionForm({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flow-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError('');
        try {
          await ws.connect(f.get('url') as string, f.get('token') as string);
          onDone();
        } catch (err) {
          setError(
            err instanceof TypeError
              ? 'Не удалось подключиться. Проверьте адрес, HTTPS и ALLOWED_ORIGINS.'
              : (err as Error).message,
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await ws.connect('', '');
            onDone();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Подключиться к локальному исполнителю
      </Button>
      <div className="inline-notice">
        Запустите исполнитель из проекта: <code>npm run runner:setup</code>,
        затем <code>npm run runner</code>. Ключ находится в .env.runner.
      </div>
      <Field
        label="Адрес исполнителя"
        hint="Для удалённого сервера используйте HTTPS."
      >
        <Input
          name="url"
          type="url"
          defaultValue={ws.connection?.url || 'http://localhost:8788'}
          required
        />
      </Field>
      <Field label="Ключ доступа">
        <Input
          type="password"
          name="token"
          autoComplete="off"
          placeholder="MAYPLANE_TOKEN"
          required
          minLength={32}
        />
      </Field>
      <p className="secure-note">
        <LockKeyhole size={14} />
        Ключ останется только в памяти этой вкладки.
      </p>
      <FormError error={error} />
      <Button
        type="submit"
        className="primary-button full-width"
        disabled={busy}
      >
        {busy ? 'Подключаем…' : 'Подключить'}
      </Button>
      {ws.connection && (
        <Button
          variant="outline"
          onClick={() => {
            ws.disconnect();
            onDone();
          }}
        >
          Отключиться
        </Button>
      )}
    </form>
  );
}
export function ProjectDetail({
  project,
  initialTab,
  ws,
  onClose,
  onJob,
  onMigrate,
}: {
  project?: Project;
  initialTab?: 'overview' | 'chat';
  ws: Workspace;
  onClose: () => void;
  onJob: (j: Job) => void;
  onMigrate: () => void;
}) {
  return (
    <Sheet
      open={!!project}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent className="project-sheet">
        {project && (
          <ProjectDetailBody
            key={project.id + (project.adoption?.id || '') + (initialTab || '')}
            project={project}
            initialTab={initialTab}
            ws={ws}
            onJob={onJob}
            onMigrate={onMigrate}
            onDeleted={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
function ProjectSettings({
  project,
  ws,
  pending,
  onSaved,
}: {
  project: Project;
  ws: Workspace;
  pending: boolean;
  onSaved: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [kind, setKind] = useState(project.kind);
  const [error, setError] = useState('');
  if (!editing)
    return (
      <Button
        className="project-edit-button"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setName(project.name);
          setKind(project.kind);
          setError('');
          setEditing(true);
          onSaved('');
        }}
      >
        <Pencil size={15} /> Редактировать проект
      </Button>
    );
  return (
    <form
      className="project-settings flow-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setError('');
        try {
          await ws.action('/projects/' + project.id, { name, kind }, 'PATCH');
          setEditing(false);
          onSaved(
            kind !== project.kind
              ? 'Проект обновлён. Для настройки запуска под новый тип повторите анализ в «Помощнике».'
              : 'Проект обновлён.',
          );
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <fieldset disabled={pending}>
        <legend>Настройки проекта</legend>
        <div className="form-row">
          <Field label="Название" hint={projectNameHint}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              pattern={projectNamePattern}
              title={projectNameHint}
              maxLength={80}
              autoComplete="off"
            />
          </Field>
          <Field label="Тип проекта">
            <Picker
              value={kind}
              label="Тип проекта"
              onChange={(value) => setKind(value as Project['kind'])}
              items={Object.entries(kindLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </Field>
        </div>
        {kind !== project.kind && (
          <p className="env-hint">
            Новый тип будет учтён при следующем анализе помощником. Изменения
            сохранятся без перезапуска приложения.
          </p>
        )}
        <FormError error={error} />
        <div className="environment-toolbar">
          <Button
            type="submit"
            className="primary-button"
            disabled={
              pending || (name === project.name && kind === project.kind)
            }
          >
            Сохранить изменения
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setEditing(false)}
          >
            Отмена
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
function ProjectDetailBody({
  project: p,
  initialTab,
  ws,
  onJob,
  onMigrate,
  onDeleted,
}: {
  project: Project;
  ws: Workspace;
  onJob: (j: Job) => void;
  onMigrate: () => void;
  onDeleted: () => void;
  initialTab?: 'overview' | 'chat';
}) {
  const [error, setError] = useState('');
  const [env, setEnv] = useState(() => parseEnvDocument(''));
  const [envLoaded, setEnvLoaded] = useState(false);
  const [envLoading, setEnvLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [hook, setHook] = useState<{ url: string; secret: string } | null>(
    null,
  );
  const envDefinitions = getEnvDefinitions(p);
  const envNames = [
    ...new Set([...p.envKeys, ...envDefinitions.map((e) => e.name)]),
  ];
  const envDefinition = (name: string) =>
    envDefinitions.find((e) => e.name === name) || {
      name,
      required: null,
      description: '',
    };
  const needsWorkflow = p.adoption?.runtime === 'directory' && !p.workflow;
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [deleteProject, setDeleteProject] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [tab, setTab] = useState(
    initialTab || (p.assistant ? 'assistant' : 'overview'),
  );
  const pending =
    ws.busy ||
    !!p.migration?.locked ||
    ws.data.jobs.some(
      (j) =>
        j.projectId === p.id && ['pending', 'deploying'].includes(j.status),
    );
  async function execute(
    operation: string,
    body: Record<string, unknown> = {},
  ) {
    setError('');
    try {
      const j = await ws.action(`/projects/${p.id}/${operation}`, body);
      setConfirmStop(false);
      setConfirmRemove(false);
      onJob(j);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <SheetHeader>
        <span className={`project-icon ${p.color}`}>
          <FolderIcon />
        </span>
        <SheetTitle>{p.name}</SheetTitle>
        <span className="instance-label">
          {ws.data.servers.find((s) => s.id === p.serverId)?.name} ·{' '}
          {p.id.slice(0, 8)}
        </span>
        <SheetDescription>
          {p.domain || p.repo.replace('https://github.com/', '')}
        </SheetDescription>
        <StatusBadge status={p.status} />
      </SheetHeader>
      <ProjectSettings
        project={p}
        ws={ws}
        pending={pending}
        onSaved={setMessage}
      />
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className="detail-tabs"
      >
        <TabsList variant="line">
          <TabsTrigger value="overview">Обзор</TabsTrigger>
          <TabsTrigger value="assistant">План</TabsTrigger>
          <TabsTrigger value="chat">Чат</TabsTrigger>
          <TabsTrigger value="env">Переменные</TabsTrigger>
          <TabsTrigger value="cicd">CI/CD</TabsTrigger>
        </TabsList>
        <TabsContent value="chat">
          {ws.data.servers.find((s) => s.id === p.serverId) && (
            <OperationsChat
              ws={ws}
              project={p}
              server={ws.data.servers.find((s) => s.id === p.serverId)!}
            />
          )}
        </TabsContent>
        <TabsContent value="assistant">
          <DeploymentAssistant
            key={p.kind + (p.assistant?.id || '')}
            project={p}
            ws={ws}
            onJob={onJob}
          />
        </TabsContent>
        <TabsContent value="overview">
          {!p.adoption && <ExistingProjectPanel project={p} ws={ws} />}
          <p className="detail-copy">
            Управление без LLM:{' '}
            {p.workflow
              ? 'сохранённый сценарий проекта'
              : p.adoption
                ? runtimeLabels[p.adoption.runtime]
                : 'стандартные команды Docker Compose'}
            .
          </p>
          <div className="detail-actions">
            <Button
              className="primary-button"
              disabled={
                pending ||
                needsWorkflow ||
                (!!p.missingEnvKeys?.length && !p.adoption)
              }
              onClick={() => execute('deploy')}
            >
              <Play size={15} />
              {p.adoption && !p.workflow ? 'Запустить' : 'Развернуть'}
            </Button>
            <Button
              variant="outline"
              disabled={pending || needsWorkflow || p.status === 'stopped'}
              onClick={() => execute('restart')}
              aria-label="Перезапустить проект"
            >
              <RefreshCw size={15} />
            </Button>
            <Button
              variant="outline"
              disabled={pending || needsWorkflow || p.status === 'stopped'}
              onClick={() => setConfirmStop(true)}
              aria-label="Остановить проект"
            >
              <Square size={15} /> Остановить
            </Button>
            <Button
              variant="outline"
              disabled={pending || needsWorkflow}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 size={15} />
              Удалить развёртывание
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmForget(true)}
            >
              <Trash2 size={15} /> Удалить из панели
            </Button>
          </div>
          {!p.workflow && !p.adoption && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => execute('build')}
            >
              Проверить сборку
            </Button>
          )}
          <WorkflowPanel project={p} ws={ws} />
          {!p.adoption && !!p.missingEnvKeys?.length && (
            <div className="inline-notice">
              Перед запуском заполните во вкладке «Переменные»:{' '}
              {p.missingEnvKeys.join(', ')}.
            </div>
          )}
          <dl className="details-list">
            <div>
              <dt>Репозиторий</dt>
              <dd>
                <a href={p.repo} target="_blank" rel="noreferrer">
                  {p.repo.replace('https://github.com/', '')}
                </a>
              </dd>
            </div>
            <div>
              <dt>Ветка</dt>
              <dd>
                <GitBranch size={14} />
                {p.branch}
              </dd>
            </div>
            <div>
              <dt>Сервер</dt>
              <dd>{ws.data.servers.find((s) => s.id === p.serverId)?.name}</dd>
            </div>
            <div>
              <dt>Способ запуска</dt>
              <dd>
                {p.workflow
                  ? 'Сохранённые команды'
                  : p.adoption
                    ? runtimeLabels[p.adoption.runtime]
                    : p.composeFile}
              </dd>
            </div>
            <div>
              <dt>Коммит</dt>
              <dd>
                <code>{p.commit}</code>
              </dd>
            </div>
            <div>
              <dt>Обновлён</dt>
              <dd>{relativeDate(p.updatedAt)}</dd>
            </div>
          </dl>
          <div className="inline-notice">
            Статус отражает последнюю операцию. Для проверки приложения откройте
            логи; для проверки ресурсов — раздел «Серверы».
          </div>
          <h3 className="detail-heading">Последние операции</h3>
          <div className="detail-jobs">
            {ws.data.jobs
              .filter((j) => j.projectId === p.id)
              .slice(0, 5)
              .map((j) => (
                <button key={j.id} onClick={() => onJob(j)}>
                  <Terminal size={14} />
                  {jobLabels[j.type]}
                  <JobStatusBadge job={j} />
                </button>
              ))}
            {!ws.data.jobs.some((j) => j.projectId === p.id) && (
              <p className="muted">
                Нажмите «Развернуть», чтобы запустить первый деплой.
              </p>
            )}
          </div>
          <Button
            variant="outline"
            className="full-width"
            onClick={onMigrate}
            disabled={
              ws.busy ||
              (pending && !p.migration?.needsRecovery) ||
              (p.status !== 'running' && !p.migration?.needsRecovery)
            }
          >
            <ArrowDownUp size={16} />
            {p.migration?.needsRecovery
              ? 'Восстановить перенос'
              : 'Перенести на другой сервер'}
          </Button>
          {p.migration && (
            <div className="migration-report">
              <strong>
                {p.migration.locked
                  ? 'Перенос требует завершения'
                  : p.migration.phase === 'rolled_back'
                    ? 'Исходное приложение восстановлено'
                    : 'Проект перенесён'}
              </strong>
              <p>
                Резервные данные сохранены:{' '}
                <code>{p.migration.backupPath}</code>
              </p>
              {p.migration.phase === 'rolled_back' ? (
                <p>
                  На целевом сервере могут оставаться подготовленные ресурсы.
                  Новая проверка покажет конфликты перед повторным переносом.
                </p>
              ) : (
                <p>
                  {p.migration.targetMayHaveWritten
                    ? 'Исходная копия остановлена. Не запускайте её параллельно с новой: данные после переноса уже могут различаться.'
                    : 'Этапы и результат доступны в журнале переноса.'}
                </p>
              )}
              {p.migration.phase === 'awaiting_dns' && (
                <p>
                  Переключите DNS и reverse proxy на новый сервер, затем
                  проверьте HTTPS.
                </p>
              )}
            </div>
          )}
          {p.adoption && <ExistingProjectPanel project={p} ws={ws} />}
        </TabsContent>
        <TabsContent value="env">
          <p className="detail-copy">
            {p.adoption
              ? 'Снимок окружения на момент привязки, только для просмотра. Текущие переменные приложения меняйте через чат проекта или SSH в исходной конфигурации. Значения хранятся зашифрованными.'
              : 'Значения хранятся зашифрованными у исполнителя. После сохранения запустите деплой для применения. Обязательные поля нужны для запуска; необязательные можно оставить пустыми.'}
          </p>
          {envLoaded ? (
            <form
              className="flow-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setError('');
                setMessage('');
                try {
                  await ws.action(
                    '/projects/' + p.id,
                    { env: serializeEnvDocument(env) },
                    'PATCH',
                  );
                  setEnv(parseEnvDocument(''));
                  setEnvLoaded(false);
                  setMessage(
                    'Переменные сохранены. Запустите деплой для применения.',
                  );
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <EnvironmentFields
                document={env}
                readOnly={!!p.adoption}
                onChange={setEnv}
                disabled={pending}
                requiredKeys={p.requiredEnvKeys}
                definitions={envDefinitions}
              />
              <div className="environment-toolbar">
                {!p.adoption && (
                  <Button
                    type="submit"
                    className="primary-button"
                    disabled={pending}
                  >
                    Сохранить переменные
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setEnv(parseEnvDocument(''));
                    setEnvLoaded(false);
                    setError('');
                  }}
                >
                  Отмена
                </Button>
              </div>
            </form>
          ) : (
            <>
              {!p.adoption && !!p.missingEnvKeys?.length && (
                <p className="env-required-notice">
                  До запуска осталось заполнить обязательные:{' '}
                  {p.missingEnvKeys.join(', ')}.
                </p>
              )}
              <div className="env-classified-list">
                {envNames
                  .sort(
                    (a, b) =>
                      Number(envDefinition(b).required === true) -
                      Number(envDefinition(a).required === true),
                  )
                  .map((key) => {
                    const definition = envDefinition(key);
                    const filled =
                      p.filledEnvKeys?.includes(key) ??
                      !p.missingEnvKeys?.includes(key);
                    return (
                      <div className="env-classified-item" key={key}>
                        <div className="env-classified-heading">
                          <FileKey2 size={14} />
                          <code>{key}</code>
                          <EnvRequirement definition={definition} />
                        </div>
                        <span className="env-value-state">
                          {filled
                            ? '••••••••'
                            : definition.required === false
                              ? 'Не задано · настройки по умолчанию'
                              : 'Не заполнено'}
                        </span>
                        <EnvExplanation
                          definition={definition}
                          missing={
                            !p.adoption &&
                            !filled &&
                            definition.required === true
                          }
                        />
                      </div>
                    );
                  })}
                {!envNames.length && (
                  <p className="muted">Переменные не добавлены</p>
                )}
              </div>
              <Button
                variant="outline"
                disabled={pending || envLoading}
                onClick={async () => {
                  setEnvLoading(true);
                  setError('');
                  setMessage('');
                  try {
                    const result = await ws.api<{ env: string }>(
                      '/projects/' + p.id + '/env',
                    );
                    setEnv(parseEnvDocument(result.env));
                    setEnvLoaded(true);
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setEnvLoading(false);
                  }
                }}
              >
                {envLoading
                  ? 'Загрузка…'
                  : p.adoption
                    ? 'Просмотреть переменные'
                    : 'Редактировать переменные'}
              </Button>
            </>
          )}
        </TabsContent>
        <TabsContent value="cicd">
          {p.adoption && !p.workflow && (
            <p className="inline-notice">
              Для автодеплоя сначала сохраните в чате сценарий обновления
              существующего приложения.
            </p>
          )}
          <div className="switch-line">
            <div>
              <strong>
                <Zap size={16} />
                Автодеплой
              </strong>
              <small>Каждый push в ветку {p.branch}</small>
            </div>
            <Switch
              aria-label="Автодеплой проекта"
              checked={p.autoDeploy}
              disabled={pending || (!!p.adoption && !p.workflow)}
              onCheckedChange={async (checked) => {
                try {
                  await ws.action(
                    `/projects/${p.id}`,
                    { autoDeploy: checked },
                    'PATCH',
                  );
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          </div>
          <p className="detail-copy">
            Добавьте webhook в настройках репозитория GitHub. Content type:{' '}
            <code>application/json</code>, событие: <code>Push</code>.
          </p>
          <div className="inline-notice">
            У исполнителя должны быть публичный HTTPS-адрес и
            MAYPLANE_PUBLIC_URL. Новый секрет заменит прежний: обновите его в
            GitHub.
          </div>
          <Button
            variant="outline"
            disabled={pending}
            onClick={async () => {
              try {
                setHook(
                  await ws.action<{ url: string; secret: string }>(
                    `/projects/${p.id}/webhook`,
                  ),
                );
                setMessage(
                  'Сохраните секрет в GitHub: после закрытия он не отображается.',
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <LockKeyhole size={15} />
            Создать / перевыпустить секрет
          </Button>
          {hook && (
            <div className="webhook-result">
              <Field label="Payload URL">
                <Input value={hook.url} readOnly />
              </Field>
              <Field label="Secret">
                <Input value={hook.secret} readOnly type="password" />
              </Field>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(hook.secret);
                    setMessage('Секрет скопирован');
                  } catch {
                    setError(
                      'Не удалось скопировать. Выделите значение вручную.',
                    );
                  }
                }}
              >
                <Copy size={14} />
                Скопировать секрет
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
      <FormError error={error} />
      {message && (
        <output className="form-success">
          <Check size={16} />
          {message}
        </output>
      )}
      <AlertDialog open={confirmForget} onOpenChange={setConfirmForget}>
        <AlertDialogContent>
          <AlertDialogTitle>Удалить {p.name} из панели?</AlertDialogTitle>
          <AlertDialogDescription>
            Карточка, сохранённые в ней переменные, чат и сценарии будут
            удалены. Приложение продолжит работать на сервере, его файлы и базы
            останутся на месте. Автодеплой через эту карточку прекратится.
            История операций сохранится.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forgetBusy}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || forgetBusy}
              onClick={async (e) => {
                e.preventDefault();
                setError('');
                setForgetBusy(true);
                try {
                  await ws.action(
                    '/projects/' + p.id,
                    { confirmPanelOnly: true },
                    'DELETE',
                  );
                  setConfirmForget(false);
                  onDeleted();
                } catch (error) {
                  setError((error as Error).message);
                  setConfirmForget(false);
                } finally {
                  setForgetBusy(false);
                }
              }}
            >
              {forgetBusy ? 'Удаляем…' : 'Удалить из панели'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogTitle>Удалить развёртывание {p.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {p.workflow
              ? 'Будет выполнена команда удаления из сценария проекта. Её можно просмотреть в разделе «Сценарий управления».'
              : p.adoption?.runtime === 'systemd'
                ? 'Служба будет остановлена, её автозапуск отключён. Файл службы и данные сохранятся.'
                : p.adoption
                  ? 'Будут удалены только привязанные контейнеры. Сети, volumes и файлы сохранятся.'
                  : 'Будут удалены контейнеры и сеть этого проекта. Docker volumes и файлы сохранятся.'}
          </AlertDialogDescription>
          <label className="check-line" htmlFor="remove-project-card">
            <Checkbox
              id="remove-project-card"
              checked={deleteProject}
              onCheckedChange={(v) => setDeleteProject(!!v)}
            />
            Также удалить карточку проекта из панели
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() =>
                execute('remove', { confirmRemove: true, deleteProject })
              }
            >
              Удалить развёртывание
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogTitle>Остановить {p.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Будет выполнена сохранённая команда остановки. Проект станет
            недоступен до следующего запуска.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => execute('stop')}
            >
              Остановить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
function FolderIcon() {
  return <GitBranch size={23} />;
}
export function LogViewer({
  ws,
  selectedJob,
  setSelectedJob,
  onProject,
}: {
  ws: Workspace;
  selectedJob: string | null;
  setSelectedJob: (s: string | null) => void;
  onProject: (project: Project, tab: 'overview' | 'chat') => void;
}) {
  const [mode, setMode] = useState('jobs');
  const [project, setProject] = useState(ws.data.projects[0]?.id || '');
  const [runtime, setRuntime] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const job = ws.data.jobs.find((j) => j.id === selectedJob) || ws.data.jobs[0];
  const logProject = ws.data.projects.find(
    (p) => p.id === (mode === 'jobs' ? job?.projectId : project),
  );
  const continueInChat =
    mode === 'jobs' &&
    (job?.outcome === 'limit' || job?.outcome === 'needs_input');
  const lines = (mode === 'jobs' ? job?.logs || [] : runtime).filter((l) =>
    l.toLowerCase().includes(query.toLowerCase()),
  );
  async function loadLogs() {
    setLoading(true);
    setError('');
    try {
      setRuntime(await ws.runtimeLogs(project));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `mayplane-${mode === 'jobs' ? job?.id : project}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <Tabs
          value={mode}
          onValueChange={(v) => {
            setMode(String(v));
            setError('');
          }}
        >
          <TabsList>
            <TabsTrigger value="jobs">Операции</TabsTrigger>
            <TabsTrigger value="runtime">Приложения</TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === 'jobs' ? (
          <Picker
            label="Выберите операцию"
            value={job?.id || ''}
            onChange={setSelectedJob}
            items={ws.data.jobs.map((j) => ({
              value: j.id,
              label: `[${jobStatus(j).label}] ${j.projectName} · ${ws.data.servers.find((s) => s.id === j.serverId)?.name || 'Сервер'} · ${j.projectId?.slice(0, 8) || j.id.slice(0, 8)} · ${jobLabels[j.type]} · ${relativeDate(j.createdAt)}`,
            }))}
          />
        ) : (
          <div className="runtime-select">
            <Picker
              label="Выберите проект"
              value={project}
              onChange={(p) => {
                setProject(p);
                setRuntime([]);
              }}
              items={ws.data.projects.map((p) => ({
                value: p.id,
                label: projectLabel(p, ws.data.servers),
              }))}
            />
            <Button
              variant="outline"
              disabled={!project || loading}
              onClick={loadLogs}
            >
              <RefreshCw size={15} />
              {loading ? 'Загрузка…' : 'Получить логи'}
            </Button>
          </div>
        )}
      </div>
      <FormError error={error} />
      {mode === 'jobs' &&
        job &&
        cancellableJobs.includes(job.type) &&
        ['pending', 'deploying'].includes(job.status) && (
          <div className="log-cancel-bar">
            <Button
              variant="outline"
              disabled={ws.busy || !!job.cancelRequested}
              onClick={async () => {
                setError('');
                try {
                  await ws.action(`/jobs/${job.id}/cancel`);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Square size={15} />{' '}
              {job.cancelRequested ? 'Прерываем…' : 'Прервать выполнение'}
            </Button>
            <small>
              Текущая команда и следующие шаги будут остановлены. Выполненные
              изменения автоматически не откатываются.
            </small>
          </div>
        )}
      {logProject && (
        <div className="log-project-link">
          <div>
            <strong>{projectLabel(logProject, ws.data.servers)}</strong>
            {continueInChat && (
              <p>Откройте чат проекта, чтобы продолжить настройку.</p>
            )}
          </div>
          <Button
            className="primary-button"
            onClick={() =>
              onProject(logProject, continueInChat ? 'chat' : 'overview')
            }
          >
            {continueInChat ? 'Продолжить в чате проекта' : 'Открыть проект'}
            <ArrowRight size={16} />
          </Button>
        </div>
      )}
      {mode === 'jobs' && job && (
        <div className="log-operation-status" aria-live="polite">
          <JobStatusBadge job={job} />
          <span>Начало: {new Date(job.createdAt).toLocaleString('ru-RU')}</span>
          {job.finishedAt ? (
            <span>
              Завершение: {new Date(job.finishedAt).toLocaleString('ru-RU')}
            </span>
          ) : jobStatus(job).active ? (
            <span>Операция ещё не завершена</span>
          ) : null}
        </div>
      )}
      {mode === 'jobs' && job?.outcome === 'cancelled' && (
        <p className="inline-notice">
          Операция прервана. Проверьте состояние приложения перед повторным
          запуском.
        </p>
      )}
      <div className="terminal-window">
        <div className="terminal-header">
          <div className="terminal-dots">
            <span />
            <span />
            <span />
          </div>
          <span>
            <Terminal size={14} />
            {mode === 'jobs'
              ? job?.projectName || 'Операции'
              : 'Вывод приложения'}
          </span>
          {mode === 'jobs' && job && <JobStatusBadge job={job} />}
          <Button
            variant="ghost"
            onClick={download}
            aria-label="Скачать логи"
            disabled={!lines.length}
          >
            <Download size={15} />
          </Button>
        </div>
        <div className="log-search">
          <SearchIcon />
          <input
            aria-label="Поиск по логам"
            placeholder="Поиск по логам…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span>{lines.length} строк</span>
        </div>
        <div
          className="terminal-lines"
          role="log"
          aria-live={
            mode === 'jobs' && job?.status === 'deploying' ? 'polite' : 'off'
          }
        >
          {lines.length ? (
            lines.map((l, i) => (
              <div
                key={i}
                className={
                  /error|ошибка/i.test(l)
                    ? 'log-error'
                    : /успеш|завершена|пройдена|совпадает/i.test(l)
                      ? 'log-success'
                      : ''
                }
              >
                <span>{String(i + 1).padStart(2, '0')}</span>
                <code>{l}</code>
              </div>
            ))
          ) : (
            <p className="terminal-empty">
              {query
                ? 'Нет строк по этому запросу'
                : mode === 'runtime'
                  ? 'Выберите проект и нажмите «Получить логи».'
                  : 'Логи появятся после запуска операции.'}
            </p>
          )}
        </div>
        <div className="terminal-footer">
          <span>
            {ws.connection ? 'Секреты из .env маскируются' : 'Нет подключения'}
          </span>
          <span>
            {mode === 'jobs'
              ? 'Обновление каждые 4 секунды'
              : 'Последние 200 строк'}
          </span>
        </div>
      </div>
    </div>
  );
}
function SearchIcon() {
  return <Terminal size={14} />;
}
