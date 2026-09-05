'use client';
import { useState } from 'react';
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
  Upload,
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
import { StatusBadge, EmptyState } from './dashboard';
import { keys, type Workspace } from '@/lib/use-workspace';
import {
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
}: {
  value: string;
  onChange: (s: string) => void;
  items: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select
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
function DemoNote({ ws }: { ws: Workspace }) {
  return !ws.connection ? (
    <div className="inline-notice">
      Деморежим: используйте вымышленные доступы. Действия имитируются,
      изменения сбросятся при обновлении страницы.
    </div>
  ) : null;
}
async function readEnv(file: File | undefined) {
  if (!file) return '';
  if (file.size > 65536) throw new Error('Файл .env должен быть меньше 64 КБ');
  return file.text();
}
export function WorkspaceDialogs({
  modal,
  setModal,
  ws,
  onProject,
  onJob,
  confirmServer,
  setConfirmServer,
}: {
  modal: string;
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
        <DialogContent className="flow-dialog">
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
                      'Перенос проекта вместе с Docker-образами и локальными данными.',
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
            <AddServer ws={ws} onDone={() => setModal('')} />
          )}{' '}
          {modal === 'migration' && (
            <MigrationForm
              ws={ws}
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
            На Ubuntu 24.04 будут установлены Docker, Docker Compose и Git.
            Существующие проекты сохранятся. Сервер не будет перезагружен.
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
  const [env, setEnv] = useState('');
  const [auto, setAuto] = useState(true);
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
            env,
            autoDeploy: auto,
          });
          setEnv('');
          onDone(p);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <DemoNote ws={ws} />
      <Field
        label="Git-репозиторий"
        hint="Публичный HTTPS-репозиторий с Docker Compose. Приватные репозитории пока не поддерживаются."
      >
        <Input
          name="repo"
          type="url"
          placeholder="https://github.com/username/project"
          required
        />
      </Field>
      <div className="form-row">
        <Field label="Имя проекта">
          <Input
            name="name"
            placeholder="my-awesome-project"
            required
            pattern="[a-z][a-z0-9\-]{1,47}"
            maxLength={48}
          />
        </Field>
        <Field label="Ветка">
          <Input name="branch" defaultValue="main" required />
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
        <Field label="Compose-файл">
          <Input name="composeFile" defaultValue="compose.yaml" required />
        </Field>
        <Field
          label="Домен / описание"
          hint="Для отображения. DNS и TLS настраиваются отдельно."
        >
          <Input name="domain" placeholder="app.example.com" />
        </Field>
      </div>
      <div className="form-field">
        <span>Переменные окружения</span>
        <label className="upload-zone">
          <Upload size={21} />
          <strong>
            {env
              ? `Загружено переменных: ${keys(env).length}`
              : 'Выберите файл .env'}
          </strong>
          <span>до 64 КБ · значения не попадут в Git</span>
          <input
            aria-label="Загрузить .env"
            type="file"
            onChange={async (e) => {
              try {
                setEnv(await readEnv(e.target.files?.[0]));
                setError('');
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </label>
      </div>
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
function AddServer({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [name, setName] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [auth, setAuth] = useState('password');
  const [error, setError] = useState('');
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
          await ws.action('/servers', {
            ...body,
            name,
            host,
            port: Number(port),
            username: 'root',
            fingerprint,
          });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <DemoNote ws={ws} />
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
        <Input name="region" placeholder="Frankfurt, DE" />
      </Field>
      <div className="fingerprint-box">
        <Button
          variant="outline"
          disabled={ws.busy || !host || !name}
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
        <small>Получение ключа ещё не подтверждает подлинность сервера.</small>
      </div>
      <Field label="Способ входа (root)">
        <Picker
          label="Способ входа"
          value={auth}
          onChange={setAuth}
          items={[
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
            required
          />
        </Field>
      ) : (
        <Field
          label="Приватный SSH-ключ"
          hint="В этой версии поддерживаются ключи без passphrase."
        >
          <Textarea
            name="privateKey"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            required
            rows={4}
          />
        </Field>
      )}
      <p className="secure-note">
        <LockKeyhole size={14} />
        Доступ хранится в зашифрованном виде у исполнителя.
      </p>
      <FormError error={error} />
      <Button
        className="primary-button full-width"
        type="submit"
        disabled={ws.busy || !trusted}
      >
        {ws.busy ? 'Подключаем…' : 'Подключить сервер'}
        <ArrowRight size={16} />
      </Button>
    </form>
  );
}
function MigrationForm({
  ws,
  onDone,
}: {
  ws: Workspace;
  onDone: (j: Job) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const [target, setTarget] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const p = ws.data.projects.find((p) => p.id === projectId);
  return (
    <form
      className="flow-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        try {
          if (!p || !target || !confirmed)
            throw new Error('Выберите проект, сервер и подтвердите остановку');
          onDone(
            await ws.action(`/projects/${p.id}/migrate`, {
              target,
              confirmDowntime: true,
            }),
          );
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <DemoNote ws={ws} />
      <Field label="Проект">
        <Picker
          label="Выберите работающий проект"
          value={projectId}
          onChange={(id) => {
            setProjectId(id);
            setTarget('');
          }}
          items={ws.data.projects
            .filter((p) => p.status === 'running')
            .map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>
      {p && (
        <div className="source-server">
          <ServerIcon size={17} />
          Сейчас на {ws.data.servers.find((s) => s.id === p.serverId)?.name}
        </div>
      )}
      <Field label="Новый сервер">
        <Picker
          value={target}
          label="Выберите целевой сервер"
          onChange={setTarget}
          items={ws.data.servers
            .filter((s) => s.id !== p?.serverId && s.status === 'online')
            .map((s) => ({ value: s.id, label: s.name }))}
        />
      </Field>
      <div className="migration-steps">
        {[
          'Проверка сервера, томов и путей',
          'Остановка записи и создание копии',
          'Передача по SSH и проверка SHA-256',
          'Запуск и проверка контейнеров',
        ].map((s, i) => (
          <div key={s}>
            <span>{i + 1}</span>
            {s}
          </div>
        ))}
      </div>
      <div className="inline-notice">
        На исходном сервере данные сохранятся, контейнеры останутся
        остановленными. При ошибке исполнитель попробует вернуть исходный проект
        в работу. DNS и внешние хранилища переносятся отдельно.
      </div>
      <label className="check-line" htmlFor="confirm-migration-downtime">
        <Checkbox
          id="confirm-migration-downtime"
          checked={confirmed}
          onCheckedChange={(v) => setConfirmed(!!v)}
        />
        Понимаю, что проект будет недоступен во время переноса
      </label>
      <FormError error={error} />
      <Button
        className="primary-button full-width"
        type="submit"
        disabled={!confirmed || !target || !projectId || ws.busy}
      >
        <ArrowDownUp size={16} />
        {ws.busy ? 'Запускаем…' : 'Начать перенос'}
      </Button>
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
          placeholder="EZDEPLOY_TOKEN"
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
          Вернуться в деморежим
        </Button>
      )}
    </form>
  );
}
export function ProjectDetail({
  project,
  ws,
  onClose,
  onJob,
  onMigrate,
}: {
  project?: Project;
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
            key={project.id}
            project={project}
            ws={ws}
            onJob={onJob}
            onMigrate={onMigrate}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
function ProjectDetailBody({
  project: p,
  ws,
  onJob,
  onMigrate,
}: {
  project: Project;
  ws: Workspace;
  onJob: (j: Job) => void;
  onMigrate: () => void;
}) {
  const [error, setError] = useState('');
  const [env, setEnv] = useState('');
  const [envLoaded, setEnvLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [hook, setHook] = useState<{ url: string; secret: string } | null>(
    null,
  );
  const [confirmStop, setConfirmStop] = useState(false);
  const pending =
    ws.busy ||
    ws.data.jobs.some(
      (j) =>
        j.projectId === p.id && ['pending', 'deploying'].includes(j.status),
    );
  async function execute(operation: string) {
    setError('');
    try {
      const j = await ws.action(`/projects/${p.id}/${operation}`);
      setConfirmStop(false);
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
        <SheetDescription>
          {p.domain || p.repo.replace('https://github.com/', '')}
        </SheetDescription>
        <StatusBadge status={p.status} />
      </SheetHeader>
      <Tabs defaultValue="overview" className="detail-tabs">
        <TabsList variant="line">
          <TabsTrigger value="overview">Обзор</TabsTrigger>
          <TabsTrigger value="env">Переменные</TabsTrigger>
          <TabsTrigger value="cicd">CI/CD</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="detail-actions">
            <Button
              className="primary-button"
              disabled={pending}
              onClick={() => execute('deploy')}
            >
              <Play size={15} />
              Развернуть
            </Button>
            <Button
              variant="outline"
              disabled={pending || p.status === 'stopped'}
              onClick={() => execute('restart')}
              aria-label="Перезапустить проект"
            >
              <RefreshCw size={15} />
            </Button>
            <Button
              variant="outline"
              disabled={pending || p.status === 'stopped'}
              onClick={() => setConfirmStop(true)}
              aria-label="Остановить проект"
            >
              <Square size={15} />
            </Button>
          </div>
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
              <dt>Compose</dt>
              <dd>{p.composeFile}</dd>
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
                  <StatusBadge status={j.status} />
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
            disabled={pending || p.status !== 'running'}
          >
            <ArrowDownUp size={16} />
            Перенести на другой сервер
          </Button>
        </TabsContent>
        <TabsContent value="env">
          <p className="detail-copy">
            Значения зашифрованы у исполнителя. После замены файла запустите
            деплой, чтобы применить изменения.
          </p>
          <div className="env-list">
            {p.envKeys.map((k) => (
              <div key={k}>
                <FileKey2 size={14} />
                <code>{k}</code>
                <span>••••••••</span>
              </div>
            ))}
            {!p.envKeys.length && (
              <p className="muted">Переменные не добавлены</p>
            )}
          </div>
          <label className="upload-zone">
            <Upload size={21} />
            <strong>
              {envLoaded
                ? `Новый файл: ${keys(env).length} переменных`
                : 'Загрузить новый .env'}
            </strong>
            <span>Полностью заменит предыдущий файл</span>
            <input
              type="file"
              aria-label="Новый файл .env"
              onChange={async (e) => {
                try {
                  setEnv(await readEnv(e.target.files?.[0]));
                  setEnvLoaded(!!e.target.files?.[0]);
                  setError('');
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </label>
          <Button
            className="primary-button full-width"
            disabled={!envLoaded || pending}
            onClick={async () => {
              try {
                await ws.action(`/projects/${p.id}`, { env }, 'PATCH');
                setEnv('');
                setEnvLoaded(false);
                setMessage(
                  'Переменные сохранены. Запустите деплой для применения.',
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Заменить переменные
          </Button>
        </TabsContent>
        <TabsContent value="cicd">
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
              disabled={pending}
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
            EZDEPLOY_PUBLIC_URL. Новый секрет заменит прежний: обновите его в
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
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogTitle>Остановить {p.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Контейнеры будут остановлены. Данные сохранятся, но проект станет
            недоступен.
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
}: {
  ws: Workspace;
  selectedJob: string | null;
  setSelectedJob: (s: string | null) => void;
}) {
  const [mode, setMode] = useState('jobs');
  const [project, setProject] = useState(ws.data.projects[0]?.id || '');
  const [runtime, setRuntime] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const job = ws.data.jobs.find((j) => j.id === selectedJob) || ws.data.jobs[0];
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
    a.download = `ezdeploy-${mode === 'jobs' ? job?.id : project}.log`;
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
              label: `${j.projectName} · ${jobLabels[j.type]} · ${relativeDate(j.createdAt)}`,
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
                label: p.name,
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
          {mode === 'jobs' && job && <StatusBadge status={job.status} />}
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
            {ws.connection
              ? 'Секреты из .env маскируются'
              : 'Демонстрационный вывод'}
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
