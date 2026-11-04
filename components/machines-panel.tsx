'use client';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  Server as ServerIcon,
  Monitor,
  Plus,
  ArrowLeft,
  ArrowUpRight,
  Copy,
  Eye,
  EyeOff,
  Terminal,
  RefreshCw,
  Network,
  ShieldCheck,
  Download,
  LogIn,
  LogOut,
  Check,
  Link2,
  Unplug,
  ChevronRight,
  LoaderCircle,
  Settings2,
  Trash2,
} from 'lucide-react';
import type { Server } from '@/lib/domain';
import type { Workspace } from '@/lib/use-workspace';
import {
  providerNames,
  type Hub,
  type AgentProvider,
  type AgentStatus,
} from '@/lib/hub';
import { Field, Modal, Submit, CopyButton, ErrorText } from './hub-ui';
import { ServerConsole } from './server-console';
import { agentPathSetup } from '@/lib/agent-path.mjs';
import { formatBytes, resourceSummary } from '@/lib/machine-metrics.mjs';
const MachineMetrics = lazy(() =>
  import('./machine-metrics').then((m) => ({ default: m.MachineMetrics })),
);
import { AccountSelect } from './agent-accounts';
import { automaticConnectorEndpoint } from '@/lib/machine-connection.mjs';

const available = (s: Server) => ['online', 'needs_setup'].includes(s.status);
const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${Math.round(v)}%`;
function AddressRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="address-row">
      <span>{label}</span>
      <div>
        <code>{value || 'Не определён'}</code>
        {value && <CopyButton value={value} />}
      </div>
    </div>
  );
}
export function ServerForm({
  ws,
  existing,
  onClose,
  onSaved,
}: {
  ws: Workspace;
  existing?: Server;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: existing?.name || '',
    host: existing?.host || '',
    port: String(existing?.port || 22),
    username: existing?.username || 'root',
    region: existing?.region || '',
    consoleUrl: existing?.consoleUrl || '',
    password: '',
    privateKey: '',
  });
  const [method, setMethod] = useState('password'),
    [fingerprint, setFingerprint] = useState(existing?.fingerprint || ''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const changed = (name: string, value: string) => {
    setForm({ ...form, [name]: value });
    if (['host', 'port', 'username'].includes(name)) {
      setFingerprint('');
      setConfirmed(false);
    }
  };
  return (
    <Modal
      title={existing ? 'Настройки SSH-сервера' : 'Подключить сервер'}
      description="Любой Linux-сервер с SSH: VPS, выделенный сервер или машина в VPN."
      onClose={onClose}
    >
      <form
        className="hub-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setBusy(true);
          try {
            await ws.action(
              existing ? `/servers/${existing.id}` : '/servers',
              {
                ...form,
                port: Number(form.port),
                fingerprint,
                password: method === 'password' ? form.password : undefined,
                privateKey: method === 'key' ? form.privateKey : undefined,
              },
              existing ? 'PATCH' : 'POST',
            );
            onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Название">
            <input
              required
              placeholder="Production"
              value={form.name}
              maxLength={64}
              onChange={(e) => changed('name', e.target.value)}
            />
          </Field>
          <Field label="Провайдер / расположение">
            <input
              placeholder="Hetzner · Helsinki"
              value={form.region}
              maxLength={80}
              onChange={(e) => changed('region', e.target.value)}
            />
          </Field>
        </div>
        <div className="form-grid host-fields">
          <Field label="IPv4 или IPv6">
            <input
              required
              placeholder="83.217.221.18"
              value={form.host}
              onChange={(e) => changed('host', e.target.value)}
            />
          </Field>
          <Field label="Порт SSH">
            <input
              required
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => changed('port', e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Пользователь"
          hint="Для агентов рекомендуем отдельного пользователя без root-доступа."
        >
          <input
            required
            value={form.username}
            onChange={(e) => changed('username', e.target.value)}
            autoComplete="username"
          />
        </Field>
        <div className="segmented-control">
          <button
            type="button"
            className={method === 'password' ? 'active' : ''}
            onClick={() => setMethod('password')}
          >
            Пароль
          </button>
          <button
            type="button"
            className={method === 'key' ? 'active' : ''}
            onClick={() => setMethod('key')}
          >
            SSH-ключ
          </button>
        </div>
        {method === 'password' ? (
          <Field
            label="SSH-пароль"
            hint={
              existing
                ? 'Пустое поле сохраняет прежние доступы.'
                : 'Хранится зашифрованным на серверной части панели.'
            }
          >
            <input
              type="password"
              required={!existing}
              value={form.password}
              onChange={(e) => changed('password', e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        ) : (
          <Field
            label="Приватный ключ"
            hint="Ключ без passphrase. Хранится зашифрованным."
          >
            <textarea
              rows={4}
              required={!existing}
              value={form.privateKey}
              onChange={(e) => changed('privateKey', e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          </Field>
        )}
        <div className="fingerprint-box">
          <button
            type="button"
            className="hub-button"
            disabled={busy || !form.host || !form.name}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const r = await ws.api<{ fingerprint: string }>(
                  '/servers/fingerprint',
                  'POST',
                  { ...form, port: Number(form.port) },
                );
                setFingerprint(r.fingerprint);
                setConfirmed(false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <ShieldCheck size={16} />
            Получить отпечаток SSH
          </button>
          {fingerprint && (
            <>
              <code>{fingerprint}</code>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                Сверил отпечаток с консолью или панелью провайдера
              </label>
            </>
          )}
        </div>
        <Field
          label="VNC / консоль провайдера · необязательно"
          hint="HTTPS-ссылка на консоль в панели провайдера, без токенов и паролей в URL."
        >
          <input
            type="url"
            value={form.consoleUrl}
            onChange={(e) => changed('consoleUrl', e.target.value)}
            placeholder="https://provider.example.com/servers/console"
          />
        </Field>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="hub-button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="hub-button primary"
            type="submit"
            disabled={busy || !confirmed || !fingerprint}
          >
            {busy && <LoaderCircle size={15} className="spin" />}
            {existing ? 'Сохранить' : 'Подключить сервер'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PairComputer({
  hub,
  ws,
  onClose,
  onPaired,
}: {
  hub: Hub;
  ws: Workspace;
  onClose: () => void;
  onPaired: () => void;
}) {
  const [name, setName] = useState('Домашний ПК'),
    [code, setCode] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [expires, setExpires] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0),
    [pairId, setPairId] = useState(''),
    [kind, setKind] = useState('computer'),
    [hostName, setHostName] = useState('Хост панели');
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(
      () => setExpires(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [expiresAt]);
  const [endpoint, setEndpoint] = useState('');
  const [addressError, setAddressError] = useState('');
  useEffect(() => {
    if (code) return;
    try {
      setEndpoint(
        automaticConnectorEndpoint({
          publicUrl: hub.data.connection?.connectorUrl,
          apiUrl: ws.connection?.url,
          pageOrigin: window.location.origin,
        }),
      );
      setAddressError('');
    } catch (e) {
      setEndpoint('');
      setAddressError((e as Error).message);
    }
  }, [ws.connection, hub.data.connection?.connectorUrl, code]);
  useEffect(() => {
    if (!pairId) return;
    let live = true,
      inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const state = await hub.api<{
          status: string;
          machineId: string | null;
        }>(`/hub/pair/${pairId}`);
        if (!live) return;
        if (state.status === 'paired') {
          live = false;
          onPaired();
          await ws.action('/hub', {}, 'GET');
          await hub.refresh();
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(poll, 1800);
    void poll();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pairId, hub.api, hub.refresh, onPaired, ws.action]);
  return (
    <Modal
      title="Подключить машину"
      description="Windows, macOS или Linux. Исходящее подключение работает за NAT без открытых портов."
      onClose={onClose}
    >
      <div className="hub-form">
        <div className="segmented-control">
          <button
            type="button"
            className={kind === 'computer' ? 'active' : ''}
            onClick={() => setKind('computer')}
          >
            ПК, Mac mini или локальный сервер
          </button>
          <button
            type="button"
            className={kind === 'host' ? 'active' : ''}
            onClick={() => setKind('host')}
          >
            Хост панели
          </button>
        </div>
        {kind === 'host' ? (
          <>
            <Field label="Название хоста">
              <input
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                maxLength={64}
              />
            </Field>
            <div className="connection-choice">
              <Monitor size={24} />
              <div>
                <strong>
                  Хост панели · {hub.data.host?.name || 'сервер панели'}
                </strong>
                <p>
                  На этой машине работает серверная часть панели. Агенты будут
                  работать с её файлами, от пользователя{' '}
                  {hub.data.host?.username || 'панели'}.
                </p>
              </div>
              <button
                className="hub-button"
                disabled={busy || !!hub.data.localMachineId || !hostName.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await ws.action('/hub/host', { name: hostName });
                    await hub.refresh();
                    onPaired();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {hub.data.localMachineId ? 'Уже добавлен' : 'Добавить хост'}
              </button>
            </div>
            <p className="hub-note">
              Это не компьютер, с которого открыт браузер. Если панель размещена
              на VPS, здесь добавится VPS.
            </p>
          </>
        ) : (
          <>
            <p className="hub-note">
              Компьютер подключается к сайту сам. После этого его проекты,
              агенты и локальные модели доступны из панели с любого устройства.
              Машина должна оставаться включённой.
            </p>
            <Field label="Название">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
              />
            </Field>
            <Field
              label="Адрес подключения"
              hint="Определён автоматически по адресу панели. Менять его вручную не нужно."
            >
              <div className="copy-code">
                <input
                  aria-label="Адрес подключения компьютера"
                  value={endpoint}
                  readOnly
                  disabled
                  placeholder="Адрес подключения недоступен"
                />
                {!!endpoint && (
                  <CopyButton
                    value={endpoint}
                    label="Скопировать адрес подключения"
                  />
                )}
              </div>
            </Field>
            <ErrorText error={addressError} />
            {endpoint.startsWith('ws://') && (
              <p className="hub-note">
                Панель открыта локально: этот адрес работает только на том же
                компьютере. Для другого ПК откройте панель по её доступному
                HTTPS-адресу.
              </p>
            )}
            {!code ? (
              <button
                className="hub-button primary"
                disabled={busy || !name.trim() || !endpoint || !!addressError}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await hub.mutate<{
                      code: string;
                      expiresIn: number;
                      pairingId: string;
                      expiresAt: number;
                    }>('/pair', { name });
                    setCode(r.code);
                    setExpires(r.expiresIn);
                    setExpiresAt(r.expiresAt);
                    setPairId(r.pairingId);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Link2 size={16} />
                Создать код подключения
              </button>
            ) : (
              <>
                <div className="pair-steps">
                  <p>
                    <b>1</b>На подключаемой машине установите Node.js 24+ и
                    получите коннектор:
                  </p>
                  <div className="copy-code">
                    <code>
                      git clone https://github.com/develop-mdv/MayPlane.git
                      <br />
                      cd MayPlane
                      <br />
                      npm ci
                    </code>
                    <CopyButton
                      value={
                        'git clone https://github.com/develop-mdv/MayPlane.git\ncd MayPlane\nnpm ci'
                      }
                    />
                  </div>
                  <p>
                    <b>2</b>Запустите коннектор. Адрес должен быть доступен с
                    компьютера.
                  </p>
                  <div className="copy-code">
                    <code>npm run connector -- --url {endpoint} --pair</code>
                    <CopyButton
                      value={`npm run connector -- --url ${endpoint} --pair`}
                    />
                  </div>
                  <p>
                    <b>3</b>Вставьте этот одноразовый код, когда коннектор его
                    запросит.
                  </p>
                  <div className="pair-code">
                    <code>{expires ? code : 'Код истёк'}</code>
                    {!!expires && <CopyButton value={code} />}
                  </div>
                  <small>
                    Ожидаем подключение. Код действует{' '}
                    {Math.floor(expires / 60)}:
                    {String(expires % 60).padStart(2, '0')}. После подключения
                    доступ можно отозвать.
                  </small>
                </div>
                {endpoint.startsWith('ws://') && (
                  <p className="hub-note">
                    Для другого компьютера укажите доступный HTTPS/WSS-адрес
                    панели. Адрес 127.0.0.1 работает только на этой машине.
                  </p>
                )}
                <button
                  className="hub-button"
                  onClick={async () => {
                    try {
                      if (pairId)
                        await hub.mutate(`/pair/${pairId}`, {}, 'DELETE');
                    } catch (e) {
                      setError((e as Error).message);
                      return;
                    }
                    setCode('');
                    setExpires(0);
                    setExpiresAt(0);
                    setPairId('');
                  }}
                >
                  Создать новый код
                </button>
              </>
            )}
            <p className="hub-note">
              Коннектор запускается от вашего пользователя, видит его
              Codex/OpenCode и рабочие папки. Локальная модель подключается к
              агенту на этом же компьютере; её API не нужно публиковать в
              интернете.
            </p>
          </>
        )}
        <ErrorText error={error} />
      </div>
    </Modal>
  );
}

function ProviderPanel({
  machine,
  provider,
  hub,
  onLoginTerminal,
  onAccounts,
  onAccountChanged,
}: {
  machine: Server;
  provider: AgentProvider;
  hub: Hub;
  onLoginTerminal: () => void;
  onAccounts: () => void;
  onAccountChanged: (id: string | null) => Promise<unknown>;
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [login, setLogin] = useState<{
      verificationUrl?: string;
      userCode?: string;
    } | null>(null),
    [taskId, setTaskId] = useState(''),
    [task, setTask] = useState<{
      status: string;
      output: string;
      operation: string;
    } | null>(null),
    [input, setInput] = useState(''),
    [confirm, setConfirm] = useState(false);
  const base = `/machines/${machine.id}/agents/${provider}`;
  const api = hub.api;
  async function check() {
    setBusy(true);
    try {
      setStatus(await api<AgentStatus>('/hub' + base));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setStatus(null);
    setLogin(null);
    setTask(null);
    setTaskId('');
  }, [machine.id]);
  useEffect(() => {
    if (!taskId) return;
    let active = true,
      loading = false;
    const poll = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{
          status: string;
          output: string;
          operation: string;
        }>(`/hub/tasks/${taskId}`);
        if (active) {
          setTask(result);
          if (result.status !== 'running') {
            if (result.status === 'success') {
              const next = await api<AgentStatus>('/hub' + base);
              if (active) setStatus(next);
            }
            if (active) setTaskId('');
          }
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setTaskId('');
        }
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [taskId, api, base]);
  async function operate(action: string) {
    setBusy(true);
    setError('');
    try {
      const result = await hub.mutate<{
        id?: string;
        verificationUrl?: string;
        userCode?: string;
      }>(base + '/' + action, { confirm: true });
      if (result.id) setTaskId(result.id);
      if (result.verificationUrl) setLogin(result);
      setConfirm(false);
      if (action === 'logout') await check();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="provider-panel">
      <div className="provider-panel-heading">
        <div className={`agent-logo ${provider}`}>
          {provider === 'codex' ? <span>✳</span> : <Terminal size={21} />}
        </div>
        <div>
          <strong>{providerNames[provider]}</strong>
          <p>
            {status?.installed
              ? status.account?.email || status.version || 'Установлен'
              : 'Агент на этой машине'}
          </p>
        </div>
        <span className={`state-badge ${status?.installed ? 'online' : ''}`}>
          {status
            ? status.installed
              ? 'Установлен'
              : status.error && !status.missing
                ? 'Ошибка проверки'
                : 'Не найден'
            : 'Не проверен'}
        </span>
      </div>
      <AccountSelect
        hub={hub}
        provider={provider}
        value={machine.agentAccounts?.[provider] || ''}
        disabled={busy || !!taskId}
        onChange={async (id) => {
          setBusy(true);
          setError('');
          try {
            await onAccountChanged(id || null);
            setStatus(null);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      <div className="provider-panel-actions">
        <button
          className="hub-button"
          disabled={busy || !!taskId || !available(machine)}
          onClick={() => void check()}
        >
          <RefreshCw size={14} className={busy ? 'spin' : ''} />
          Проверить
        </button>
        <button
          className="hub-button"
          disabled={busy || !!taskId || !available(machine)}
          onClick={() => setConfirm(true)}
        >
          <Download size={14} />
          {status?.installed
            ? provider === 'opencode'
              ? 'Проверить установку'
              : 'Обновить'
            : 'Установить'}
        </button>
        <button
          className="hub-button"
          disabled={busy || !!taskId || !available(machine)}
          onClick={() => {
            onAccounts();
          }}
        >
          <LogIn size={14} />
          {machine.agentAccounts?.[provider]
            ? 'Настроить аккаунт'
            : 'Добавить аккаунт'}
        </button>
        {provider === 'codex' &&
          status?.account &&
          !machine.agentAccounts?.[provider] && (
            <button
              className="icon-button"
              title="Выйти из Codex"
              aria-label="Выйти из Codex"
              onClick={() => void operate('logout')}
              disabled={busy}
            >
              <LogOut size={16} />
            </button>
          )}
      </div>
      {!machine.agentAccounts?.[provider] &&
        provider === 'opencode' &&
        (!machine.transport || machine.transport === 'ssh') && (
          <button className="text-button" onClick={onLoginTerminal}>
            Войти непосредственно на этой машине
          </button>
        )}
      {status?.account && (
        <p className="hub-note">
          <Check size={14} />
          Аккаунт подключён{' '}
          {status.account.planType ? `· ${status.account.planType}` : ''}
        </p>
      )}
      {provider === 'codex' &&
        status?.installed &&
        status.ready &&
        !status.account && (
          <p className="hub-note">
            <LogIn size={14} /> Codex установлен. Войдите с ChatGPT или
            настройте API-доступ на этой машине.
          </p>
        )}
      {status?.installed && status.ready === false && (
        <p className="hub-note">
          Codex установлен, но подключиться к агенту не удалось. Подробности
          ниже.
        </p>
      )}
      <ErrorText error={status?.error || ''} />
      {login?.verificationUrl && (
        <div className="device-login">
          <p>
            Откройте страницу входа и введите код. Аккаунт подключится на{' '}
            <b>{machine.name}</b>.
          </p>
          <div>
            <code>{login.userCode}</code>
            <CopyButton value={login.userCode || ''} />
            <a
              className="hub-button primary"
              href={login.verificationUrl}
              target="_blank"
              rel="noreferrer"
            >
              Войти <ArrowUpRight size={15} />
            </a>
          </div>
          <button className="text-button" onClick={() => void check()}>
            Я вошёл — проверить подключение
          </button>
        </div>
      )}
      {task && (
        <div className="task-output">
          <div>
            <span>
              {task.status === 'running'
                ? 'Выполняется…'
                : task.status === 'success'
                  ? 'Готово'
                  : 'Операция завершилась с ошибкой'}
            </span>
            {taskId && (
              <button
                className="text-button"
                onClick={async () => {
                  await hub.mutate(`/tasks/${taskId}/stop`);
                }}
              >
                Остановить
              </button>
            )}
          </div>
          <pre>
            {task.output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') ||
              'Ожидаем вывод…'}
          </pre>
          {task.status === 'running' && task.operation === 'login' && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await hub.mutate(`/tasks/${taskId}/input`, { input });
                  setInput('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ответ для CLI (для меню можно использовать SSH-консоль)"
                aria-label="Ввод для входа OpenCode"
              />
              <button className="hub-button" type="submit">
                Отправить
              </button>
            </form>
          )}
        </div>
      )}
      <ErrorText error={error} />
      {confirm && (
        <div className="install-confirm">
          <p>
            Установить{' '}
            <code>
              {provider === 'codex' ? '@openai/codex' : '@opencode/cli'}
            </code>{' '}
            {machine.platform !== 'win32' ? (
              <>
                через официальный установщик {providerNames[provider]} без npm
              </>
            ) : (
              <>
                через <code>npm install --global</code>
              </>
            )}{' '}
            на <b>{machine.name}</b> от пользователя{' '}
            <b>{machine.username || 'владельца коннектора'}</b>? На
            {machine.platform !== 'win32' ? (
              <>
                машине нужен curl.{' '}
                {provider === 'codex'
                  ? 'Codex будет установлен или обновлён в ~/.local/bin; вход и настройки сохраняются.'
                  : 'Существующая установка, настройки и запущенные процессы сохраняются.'}
              </>
            ) : (
              <>машине нужны Node.js и npm.</>
            )}
          </p>
          <div>
            <button className="hub-button" onClick={() => setConfirm(false)}>
              Отмена
            </button>
            <button
              className="hub-button primary"
              disabled={busy}
              onClick={() => void operate('install')}
            >
              Установить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MachinesPanel({
  ws,
  hub,
  selectedId,
  onSelect,
  onAdd,
  onPair,
  onAccounts,
  onRemove,
}: {
  ws: Workspace;
  hub: Hub;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (server?: Server) => void;
  onPair: () => void;
  onAccounts: () => void;
  onRemove: (machine: Server) => void;
}) {
  const [consoleServer, setConsoleServer] = useState<Server | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(''),
    [revoke, setRevoke] = useState(false);
  const [consoleCommand, setConsoleCommand] = useState<string | undefined>();
  const pageRef = useRef<HTMLDivElement>(null);
  const machine = ws.data.servers.find((s) => s.id === selectedId);
  const api = hub.api;
  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
    setPassword('');
    setError('');
    setRevoke(false);
  }, [selectedId]);
  useEffect(() => {
    if (!password) return;
    const timer = setTimeout(() => setPassword(''), 15000);
    return () => clearTimeout(timer);
  }, [password]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true,
      loading = false;
    const poll = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        await api(`/hub/machines/${selectedId}/metrics`, 'POST', {});
        if (active) setError('');
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedId, api]);
  return (
    <div className="hub-page machines-page" ref={pageRef}>
      {machine ? (
        <>
          <button className="back-link" onClick={() => onSelect(null)}>
            <ArrowLeft size={15} />
            Все машины
          </button>
          <div className="page-heading">
            <div>
              <div className="title-with-status">
                <h1>{machine.name}</h1>
                <span
                  className={`state-badge ${available(machine) ? 'online' : ''}`}
                >
                  <i />
                  {available(machine) ? 'На связи' : 'Не в сети'}
                </span>
              </div>
              <p>
                {machine.region || 'Свой сервер'}
                <span className="separator">·</span>
                {machine.specs}
              </p>
            </div>
            <div className="heading-actions">
              <button
                type="button"
                className="hub-button danger"
                onClick={() => onRemove(machine)}
                aria-label={`Удалить машину ${machine.name}`}
              >
                <Trash2 size={15} />
                Удалить
              </button>
              {machine.consoleUrl && (
                <a
                  className="hub-button"
                  href={machine.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Monitor size={16} />
                  VNC / консоль
                  <ArrowUpRight size={13} />
                </a>
              )}
              {!machine.transport || machine.transport === 'ssh' ? (
                <>
                  <button className="hub-button" onClick={() => onAdd(machine)}>
                    <Settings2 size={16} />
                    Настройки
                  </button>
                  <button
                    className="hub-button primary"
                    disabled={!available(machine)}
                    onClick={() => {
                      setConsoleCommand(undefined);
                      setConsoleServer(machine);
                    }}
                  >
                    <Terminal size={16} />
                    SSH-консоль
                  </button>
                </>
              ) : (
                <span className="connection-pill">
                  <ShieldCheck size={14} />
                  {machine.transport === 'local'
                    ? 'Локальное соединение'
                    : 'Исходящее WSS'}
                </span>
              )}
            </div>
          </div>
          <Suspense
            fallback={<p className="metrics-help">Загрузка графиков…</p>}
          >
            <MachineMetrics key={machine.id} machine={machine} />
          </Suspense>
          <ErrorText error={error} />
          <div className="machine-details-grid">
            <section className="detail-card">
              <div className="section-title">
                <h2>Подключение</h2>
                <ShieldCheck size={16} />
              </div>
              <AddressRow
                label="IPv4"
                value={
                  machine.ipv4 ||
                  (!machine.host.includes(':') ? machine.host : '')
                }
              />
              <AddressRow
                label="IPv6"
                value={
                  machine.ipv6 ||
                  (machine.host.includes(':') ? machine.host : '')
                }
              />
              {(!machine.transport || machine.transport === 'ssh') && (
                <>
                  <AddressRow
                    label="SSH"
                    value={`ssh ${machine.port !== 22 ? '-p ' + machine.port + ' ' : ''}${machine.username}@${machine.host}`}
                  />
                  <div className="address-row">
                    <span>SSH-пароль</span>
                    <div>
                      <code>{password || '••••••••••••'}</code>
                      <button
                        className="icon-button"
                        title={
                          password
                            ? 'Скрыть пароль'
                            : 'Показать пароль на 15 секунд'
                        }
                        aria-label={
                          password ? 'Скрыть пароль' : 'Показать пароль'
                        }
                        onClick={async () => {
                          if (password) {
                            setPassword('');
                            return;
                          }
                          try {
                            const r = await api<{ password: string }>(
                              `/hub/machines/${machine.id}/credentials`,
                              'POST',
                              { reveal: true },
                            );
                            setPassword(r.password);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        {password ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                      {password && <CopyButton value={password} />}
                    </div>
                  </div>
                  <AddressRow
                    label="Ключ сервера"
                    value={machine.fingerprint}
                  />
                </>
              )}
              {machine.transport === 'connector' && (
                <div className="address-row">
                  <span>Доступ компьютера</span>
                  <button
                    className="text-button danger"
                    onClick={() => setRevoke(true)}
                  >
                    <Unplug size={13} />
                    Отозвать подключение
                  </button>
                </div>
              )}
            </section>
            <section className="detail-card">
              <div className="section-title">
                <h2>Сеть и система</h2>
                <Network size={16} />
              </div>
              <AddressRow
                label="Платформа"
                value={machine.platform || 'Linux'}
              />
              <AddressRow
                label="Пользователь"
                value={machine.username || 'Владелец коннектора'}
              />
              <AddressRow
                label="Ядра процессора"
                value={
                  machine.cpuCores ? `${machine.cpuCores} vCPU` : undefined
                }
              />
              <AddressRow
                label="Оперативная память"
                value={
                  machine.memoryTotalBytes
                    ? formatBytes(machine.memoryTotalBytes)
                    : undefined
                }
              />
              <AddressRow
                label="Объём диска"
                value={
                  machine.diskTotalBytes
                    ? formatBytes(machine.diskTotalBytes)
                    : undefined
                }
              />
              <AddressRow
                label="Диск измерения"
                value={
                  machine.transport === 'local' ||
                  machine.transport === 'connector'
                    ? 'Том домашней папки'
                    : 'Корневой том /'
                }
              />
              <AddressRow
                label="Время работы"
                value={
                  machine.uptime
                    ? `${Math.floor(machine.uptime / 86400)} дн ${Math.floor((machine.uptime % 86400) / 3600)} ч`
                    : undefined
                }
              />
              <AddressRow
                label="Получено"
                value={
                  machine.networkRx == null
                    ? undefined
                    : formatBytes(machine.networkRx)
                }
              />
              <AddressRow
                label="Отправлено"
                value={
                  machine.networkTx == null
                    ? undefined
                    : formatBytes(machine.networkTx)
                }
              />
              <p className="hub-note">
                Трафик — счётчики с запуска ОС. Графики содержат только реальные
                измерения панели.
              </p>
            </section>
          </div>
          {machine.transport === 'connector' && (
            <section className="detail-card">
              <h2>Постоянное подключение</h2>
              <p className="hub-note">
                В каталоге MayPlane на этой машине остановите ручной коннектор
                (Ctrl+C) и включите автозапуск для своего пользователя. Машина
                должна оставаться включённой.
              </p>
              <div className="copy-code">
                <code>npm run connector -- --install-service</code>
                <CopyButton value="npm run connector -- --install-service" />
              </div>
              <p className="hub-note">
                Отключение:{' '}
                <code>npm run connector -- --uninstall-service</code>.
                Автозапуск действует после входа пользователя в ОС. Отзыв
                доступа в панели отдельно блокирует ключ подключения.
              </p>
            </section>
          )}
          <div className="section-heading">
            <div>
              <h2>Агенты на машине</h2>
              <p>Установка, личный аккаунт и готовность к работе.</p>
            </div>
            <span className="muted">Аккаунт панели или профиль машины</span>
          </div>
          <div className="agents-grid">
            {(['codex', 'opencode'] as const).map((p) => (
              <ProviderPanel
                key={machine.id + p}
                machine={machine}
                provider={p}
                hub={hub}
                onAccounts={onAccounts}
                onAccountChanged={(id) =>
                  ws.action(`/hub/machines/${machine.id}/agents/${p}/account`, {
                    accountId: id,
                  })
                }
                onLoginTerminal={() => {
                  setConsoleCommand(`${agentPathSetup}\nopencode auth login`);
                  setConsoleServer(machine);
                }}
              />
            ))}
          </div>
          <div className="security-caption">
            <ShieldCheck size={16} />
            <p>
              SSH-ключ проверяется при каждом соединении. Секреты в панели
              зашифрованы. Агенты выполняют задачи с правами пользователя
              машины.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="page-heading">
            <div>
              <span className="eyebrow">ИНФРАСТРУКТУРА</span>
              <h1>
                Серверы и компьютеры
                <span className="heading-count">{ws.data.servers.length}</span>
              </h1>
              <p>Вся инфраструктура под рукой, где бы она ни находилась.</p>
            </div>
            <div className="heading-actions">
              <button
                className="hub-button"
                onClick={onPair}
                disabled={!ws.connection}
              >
                <Monitor size={16} />
                Подключить машину
              </button>
              <button
                className="hub-button primary"
                onClick={() => onAdd()}
                disabled={!ws.connection}
              >
                <Plus size={17} />
                Добавить сервер
              </button>
            </div>
          </div>
          <div className="overview-strip">
            <div>
              <i className="live-dot" />
              <strong>{ws.data.servers.filter(available).length}</strong>
              <span>на связи</span>
            </div>
            <div>
              <span className="offline-dot" />
              <strong>
                {ws.data.servers.filter((s) => !available(s)).length}
              </strong>
              <span>не в сети</span>
            </div>
            <div>
              <ShieldCheck size={15} />
              <span>Зашифрованные подключения</span>
            </div>
          </div>
          {ws.data.servers.length ? (
            <div className="machine-grid">
              {ws.data.servers.map((m) => (
                <button
                  className="machine-card"
                  key={m.id}
                  onClick={() => onSelect(m.id)}
                >
                  <div className="machine-card-top">
                    <div className="machine-icon">
                      {m.transport && m.transport !== 'ssh' ? (
                        <Monitor size={21} />
                      ) : (
                        <ServerIcon size={21} />
                      )}
                    </div>
                    <span
                      className={`state-badge ${available(m) ? 'online' : ''}`}
                    >
                      <i />
                      {available(m) ? 'На связи' : 'Не в сети'}
                    </span>
                    <ChevronRight size={17} />
                  </div>
                  <h3>{m.name}</h3>
                  <p>
                    {m.transport === 'local'
                      ? 'Хост панели'
                      : m.region || 'Свой сервер'}
                    <span>·</span>
                    {m.transport === 'connector'
                      ? 'Коннектор'
                      : m.transport === 'local'
                        ? 'На сервере панели'
                        : 'SSH'}
                  </p>
                  <code className="machine-host">
                    {m.ipv4 || m.host || 'Исходящее соединение'}
                  </code>
                  <div className="mini-metrics">
                    {[
                      { label: 'CPU', value: m.cpu, kind: 'cpu' as const },
                      {
                        label: 'RAM',
                        value: m.memory,
                        kind: 'memory' as const,
                      },
                      { label: 'Диск', value: m.disk, kind: 'disk' as const },
                    ].map((x) => (
                      <div key={x.label}>
                        <span>
                          {x.label}
                          <b>{pct(x.value)}</b>
                        </span>
                        <small className="mini-metric-capacity">
                          {resourceSummary(m, x.kind)}
                        </small>
                        <div>
                          <i
                            style={{
                              width: `${Math.max(0, Math.min(100, x.value || 0))}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <footer>
                    {m.specs}
                    <ArrowUpRight size={14} />
                  </footer>
                </button>
              ))}
              <button className="add-machine-card" onClick={() => onAdd()}>
                <Plus size={24} />
                <strong>Ещё одна машина</strong>
                <span>VPS, сервер или домашний ПК</span>
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <ServerIcon size={29} />
              </div>
              <h2>Подключите первую машину</h2>
              <p>
                Сервер по SSH или компьютер через защищённый коннектор.
                <br />
                Затем добавьте проект и начните диалог с агентом.
              </p>
              <button
                className="hub-button primary"
                onClick={() => onAdd()}
                disabled={!ws.connection}
              >
                <Plus size={16} />
                Добавить сервер
              </button>
              <button
                className="text-button"
                onClick={onPair}
                disabled={!ws.connection}
              >
                Подключить ПК или хост панели
              </button>
            </div>
          )}
          <div className="connection-explainer">
            <ShieldCheck size={21} />
            <div>
              <strong>Ваши машины. Ваши аккаунты. Ваш контроль.</strong>
              <p>
                SSH для серверов, исходящий коннектор для личного ПК. Внешние
                порты агентов открывать не нужно.
              </p>
            </div>
          </div>
        </>
      )}
      <ServerConsole
        server={consoleServer}
        ws={ws}
        initialCommand={consoleCommand}
        onClose={() => setConsoleServer(null)}
      />
      {revoke && machine && (
        <Modal
          title="Отозвать доступ компьютера?"
          description={`Коннектор ${machine.name} отключится, активные процессы агентов будут остановлены. Для повторного подключения потребуется новый код.`}
          onClose={() => setRevoke(false)}
        >
          <div className="form-actions">
            <button className="hub-button" onClick={() => setRevoke(false)}>
              Отмена
            </button>
            <button
              className="hub-button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await hub.mutate(`/machines/${machine.id}/revoke`);
                  setRevoke(false);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Отозвать доступ
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
