'use client';
import { WorkspaceSelect, type WorkspaceOption } from './workspace-select';
import { useEffect, useId, useState } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
} from './ui/combobox';
import {
  ShieldCheck,
  ExternalLink,
  LoaderCircle,
  LogIn,
  Plus,
  ChevronDown,
  ChevronRight,
  Code2,
  Laptop,
  Monitor,
  MoreHorizontal,
  Pencil,
  Server,
  Sparkles,
  Terminal,
  Unplug,
  Trash2,
  UserRound,
} from 'lucide-react';
import type { AgentAccount, AgentProvider, AccountLogin, Hub } from '@/lib/hub';
import { providerNames, agentProviders } from '@/lib/hub';
import type { Workspace } from '@/lib/use-workspace';
import { Modal, Field, ErrorText, CopyButton, Submit } from './hub-ui';
import { ClaudeSubscription } from './claude-subscription';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

type AuthField = {
  key: string;
  title: string;
  description?: string;
  type?: string;
  required?: boolean;
  hidden?: boolean;
  default?: string | boolean;
  placeholder?: string;
  options?: { value: string; label: string; description?: string }[];
  when?: { key: string; op: string; value: string }[];
};
type AuthMethod = {
  id: string;
  type: 'api' | 'oauth' | 'native';
  name: string;
  fields: AuthField[];
};
type AuthProvider = { id: string; name: string; methods: AuthMethod[] };
const labels = {
  connected: 'Подключён',
  pending: 'Ожидает входа',
  disconnected: 'Не подключён',
  error: 'Нужен повторный вход',
};

function accountChoices(
  accounts: AgentAccount[],
  provider: AgentProvider,
  value: string,
  defaultName?: string,
  allowNative = true,
): WorkspaceOption[] {
  const local =
    provider === 'claude'
      ? 'Подписка / профиль Claude на машине'
      : 'Аккаунт машины';
  const choices: WorkspaceOption[] = [];
  if (defaultName !== undefined)
    choices.push({
      value: '__default',
      label: `По умолчанию сервера · ${defaultName || local}`,
    });
  if (allowNative) choices.push({ value: '', label: local });
  for (const account of accounts) {
    if (
      account.provider !== provider ||
      (account.status !== 'connected' && account.id !== value)
    )
      continue;
    choices.push({
      value: account.id,
      label: account.name,
      disabled: account.status !== 'connected',
      description: [
        account.email,
        account.status !== 'connected' && labels[account.status],
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  if (value && !choices.some((choice) => choice.value === value)) {
    choices.push({ value, label: 'Аккаунт недоступен', disabled: true });
  }
  return choices;
}

export function AccountSelect({
  hub,
  provider,
  value,
  onChange,
  disabled = false,
  defaultName,
  allowNative = true,
}: {
  hub: Hub;
  provider: AgentProvider;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  defaultName?: string;
  allowNative?: boolean;
}) {
  const accounts = hub.data.accounts || [];
  const accountInputId = useId();
  return (
    <label htmlFor={accountInputId} className="hub-field account-select">
      <span>Аккаунт</span>
      <WorkspaceSelect
        id={accountInputId}
        aria-label="Аккаунт агента"
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        options={accountChoices(
          accounts,
          provider,
          value,
          defaultName,
          allowNative,
        )}
      />
    </label>
  );
}

function AccountForm({
  hub,
  ws,
  initialProvider,
  account,
  onClose,
  onStarted,
}: {
  hub: Hub;
  ws: Workspace;
  initialProvider?: AgentProvider;
  account?: AgentAccount;
  onClose: () => void;
  onStarted: (a: AccountLogin) => void;
}) {
  const [provider, setProvider] = useState<AgentProvider>(
      account?.provider || initialProvider || 'codex',
    ),
    [name, setName] = useState(account?.name || ''),
    [list, setList] = useState<AuthProvider[]>([]),
    [vendor, setVendor] = useState(account?.vendor || 'chatgpt'),
    [method, setMethod] = useState(''),
    [inputs, setInputs] = useState<Record<string, string | boolean>>({}),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const vendorInputId = useId();
  const api = hub.api;
  const selected = list.find((v) => v.id === vendor),
    auth = selected?.methods.find((m) => m.id === method);
  const subscription = provider === 'claude' && method === 'subscription';
  function selectMethod(value: AuthMethod | undefined) {
    setMethod(value?.id || '');
    setInputs(
      Object.fromEntries(
        (value?.fields || [])
          .filter((f) => f.default !== undefined)
          .map((f) => [f.key, f.default!]),
      ),
    );
    setKey('');
  }
  useEffect(() => {
    let active = true;
    void api<{ providers: AuthProvider[] }>(
      `/hub/accounts/providers/${provider}`,
    )
      .then((result) => {
        if (!active) return;
        setList(result.providers);
        const chosen =
          result.providers.find(
            (v) =>
              v.id ===
              (account?.vendor ||
                (provider === 'codex' ? 'chatgpt' : 'openai')),
          ) || result.providers[0];
        setVendor(chosen?.id || '');
        selectMethod(
          chosen?.methods.find((m) => m.name === account?.methodName) ||
            (provider === 'claude'
              ? chosen?.methods.find((m) => m.id === 'subscription')
              : undefined) ||
            chosen?.methods.find(
              (m) => m.type === 'oauth' && /device|headless/.test(m.id),
            ) ||
            chosen?.methods.find((m) => m.type === 'oauth') ||
            chosen?.methods[0],
        );
        setLoading(false);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, provider, account?.vendor, account?.methodName]);
  const visible = (f: AuthField) =>
    !f.hidden &&
    (!f.when ||
      f.when.every((w) =>
        w.op === 'eq'
          ? inputs[w.key] === w.value
          : w.op === 'neq'
            ? inputs[w.key] !== w.value
            : true,
      ));
  return (
    <Modal
      title={account ? 'Повторный вход' : 'Добавить аккаунт'}
      description={
        provider === 'claude'
          ? 'Подключите свою подписку на машине или сохраните API-аккаунт.'
          : 'Подключите личный или рабочий аккаунт один раз и выбирайте его для машин и чатов.'
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="hub-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (subscription) return;
          setBusy(true);
          setError('');
          try {
            const result = await hub.mutate<AccountLogin>(
              account ? `/accounts/${account.id}/login` : '/accounts',
              {
                provider,
                name: name.trim(),
                vendor,
                method,
                inputs,
                ...(auth?.type === 'api' ? { apiKey: key } : {}),
              },
            );
            setKey('');
            onStarted(result);
          } catch (e) {
            setError((e as Error).message);
            setKey('');
          } finally {
            setBusy(false);
          }
        }}
      >
        {!account && !subscription && (
          <Field label="Название аккаунта">
            <input
              aria-label="Название аккаунта"
              placeholder="Личный / Рабочий"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        <Field label="Агент">
          <WorkspaceSelect
            aria-label="Агент аккаунта"
            disabled={!!account || busy}
            value={provider}
            onValueChange={(choice) => {
              setProvider(choice as AgentProvider);
              setList([]);
              setLoading(true);
              setError('');
              setKey('');
            }}
            options={agentProviders.map((agent) => ({
              value: agent,
              label: providerNames[agent],
            }))}
          />
        </Field>
        {loading ? (
          <p className="hub-note">
            <LoaderCircle size={15} className="spin" /> Загружаем способы
            авторизации из агента…
          </p>
        ) : (
          <>
            {provider === 'claude' && (
              <p className="hub-note">
                Войдите со своей подпиской Claude или добавьте Anthropic
                API-ключ. Для подписки отдельный API-баланс не нужен.
              </p>
            )}
            {provider === 'opencode' && (
              <div className="hub-field">
                <label htmlFor={vendorInputId}>Провайдер</label>
                <Combobox.Root
                  items={list}
                  value={selected || null}
                  itemToStringLabel={(item) => item.name}
                  itemToStringValue={(item) => item.id}
                  filter={(item, query) =>
                    `${item.name} ${item.id}`
                      .toLowerCase()
                      .includes(query.trim().toLowerCase())
                  }
                  required
                  disabled={!!account || busy}
                  onValueChange={(item) => {
                    setVendor(item?.id || '');
                    selectMethod(
                      item?.methods.find(
                        (m) =>
                          m.type === 'oauth' && /device|headless/.test(m.id),
                      ) ||
                        item?.methods.find((m) => m.type === 'oauth') ||
                        item?.methods[0],
                    );
                  }}
                >
                  <div className="workspace-provider-input">
                    <Combobox.Input
                      id={vendorInputId}
                      placeholder="Найти провайдера…"
                    />
                    <Combobox.Trigger aria-label="Показать провайдеров">
                      <ChevronDown size={15} />
                    </Combobox.Trigger>
                  </div>
                  <ComboboxContent className="workspace-select-popup">
                    <ComboboxEmpty>Провайдеры не найдены</ComboboxEmpty>
                    <ComboboxList>
                      {(item: AuthProvider) => (
                        <ComboboxItem key={item.id} value={item}>
                          {item.name}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox.Root>
              </div>
            )}
            <Field label="Способ подключения">
              <WorkspaceSelect
                aria-label="Способ подключения"
                required
                disabled={busy || !selected}
                value={method}
                onValueChange={(choice) =>
                  selectMethod(selected?.methods.find((m) => m.id === choice))
                }
                options={[
                  { value: '', label: 'Выберите способ', disabled: true },
                  ...(selected?.methods || []).map((m) => ({
                    value: m.id,
                    label: m.name,
                  })),
                ]}
              />
            </Field>
            {subscription && (
              <ClaudeSubscription
                hub={hub}
                machines={ws.data.servers}
                onUse={async (machineId) => {
                  await ws.action(
                    `/hub/machines/${machineId}/agents/claude/subscription`,
                    { confirm: true },
                  );
                  await hub.refresh();
                  onClose();
                }}
              />
            )}
            {auth?.fields.filter(visible).map((f) => (
              <Field key={f.key} label={f.title} hint={f.description}>
                {f.options?.length ? (
                  <WorkspaceSelect
                    aria-label={f.title}
                    required={f.required}
                    disabled={busy}
                    value={String(inputs[f.key] || '')}
                    onValueChange={(choice) =>
                      setInputs((x) => ({ ...x, [f.key]: choice }))
                    }
                    options={[
                      { value: '', label: 'Выберите значение', disabled: true },
                      ...f.options,
                    ]}
                  />
                ) : (
                  <input
                    aria-label={f.title}
                    required={f.required}
                    disabled={busy}
                    placeholder={f.placeholder}
                    value={String(inputs[f.key] || '')}
                    onChange={(e) =>
                      setInputs((x) => ({ ...x, [f.key]: e.target.value }))
                    }
                  />
                )}
              </Field>
            ))}
            {auth?.type === 'api' && (
              <Field
                label="API-ключ"
                hint="Ключ сохраняется в зашифрованном хранилище и не возвращается в браузер."
              >
                <input
                  aria-label="API-ключ аккаунта"
                  type="password"
                  autoComplete="off"
                  required
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  disabled={busy}
                />
              </Field>
            )}
          </>
        )}
        {!subscription && (
          <p className="hub-note">
            <ShieldCheck size={16} /> Вход выполняется в отдельном профиле.
            Аккаунт вашего Codex или OpenCode вне панели не меняется.
          </p>
        )}
        <ErrorText error={error} />
        <div className="form-actions">
          <button
            className="hub-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          {!subscription && (
            <Submit busy={busy || loading || !method}>
              {auth?.type === 'api'
                ? 'Сохранить аккаунт'
                : 'Перейти к авторизации'}
            </Submit>
          )}
        </div>
      </form>
    </Modal>
  );
}

function LoginDialog({
  hub,
  initial,
  onClose,
  onRetry,
}: {
  hub: Hub;
  initial: AccountLogin;
  onClose: () => void;
  onRetry: (a: AgentAccount) => void;
}) {
  const [data, setData] = useState(initial),
    [error, setError] = useState(''),
    [code, setCode] = useState(''),
    [busy, setBusy] = useState(false);
  const api = hub.api;
  const refresh = hub.refresh;
  useEffect(() => {
    let active = true,
      inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const a = await api<AccountLogin>(`/hub/accounts/${initial.id}`);
        if (active) {
          setData(a);
          setError('');
          if (a.status === 'connected') {
            await refresh();
            onClose();
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, initial.id, refresh, onClose]);
  return (
    <Modal
      title={`Вход · ${data.name}`}
      description={`${providerNames[data.provider]}${data.provider === 'opencode' ? ` · ${data.vendor}` : ''}`}
      onClose={onClose}
    >
      <div className="account-login-content">
        {data.status === 'pending' && data.login ? (
          <>
            <p>
              Откройте страницу провайдера и завершите вход в нужный личный или
              рабочий аккаунт.
            </p>
            {data.login.userCode && (
              <div className="account-device-code">
                <code>{data.login.userCode}</code>
                <CopyButton value={data.login.userCode} />
              </div>
            )}
            {data.login.instructions && (
              <div className="account-login-instructions">
                <p>{data.login.instructions}</p>
                <CopyButton
                  value={data.login.instructions}
                  label="Скопировать инструкцию"
                />
              </div>
            )}
            <a
              className="hub-button primary"
              href={data.login.url}
              target="_blank"
              rel="noreferrer"
            >
              Открыть авторизацию <ExternalLink size={15} />
            </a>
            {data.login.mode === 'code' && (
              <form
                className="hub-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    const next = await hub.mutate<AccountLogin>(
                      `/accounts/${data.id}/complete`,
                      { code },
                    );
                    setCode('');
                    setData(next);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Field label="Код авторизации">
                  <input
                    aria-label="Код авторизации"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </Field>
                <Submit busy={busy}>Завершить вход</Submit>
              </form>
            )}
            <p className="hub-note">
              <LoaderCircle size={14} className="spin" /> Ожидаем подтверждение.
              Аккаунт появится автоматически.
            </p>
            <button
              type="button"
              className="text-button"
              onClick={async () => {
                await hub.mutate(`/accounts/${data.id}/cancel`);
                onClose();
              }}
            >
              Отменить вход
            </button>
          </>
        ) : (
          <>
            <ErrorText
              error={data.error || 'Авторизация завершена или отменена.'}
            />
            <button className="hub-button" onClick={() => onRetry(data)}>
              Повторить вход
            </button>
          </>
        )}
        <ErrorText error={error} />
      </div>
    </Modal>
  );
}

const providerIcons = { codex: Terminal, opencode: Code2, claude: Sparkles };

function MachineDefaults({ hub, ws }: { hub: Hub; ws: Workspace }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const accounts = hub.data.accounts || [];
  async function save(
    machineId: string,
    machineName: string,
    provider: AgentProvider,
    accountId: string,
  ) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await ws.action(`/hub/machines/${machineId}/agents/${provider}/account`, {
        accountId: accountId || null,
      });
      setNotice(`${machineName} · ${providerNames[provider]} — выбор сохранён`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="settings-section">
      <header className="settings-section-heading">
        <div>
          <h2>Аккаунты на машинах</h2>
          <p>
            Аккаунты по умолчанию для новых чатов. В открытых чатах выбор
            сохраняется.
          </p>
        </div>
      </header>
      <div className="settings-surface">
        <table
          className="settings-machine-table"
          aria-label="Аккаунты по умолчанию на машинах"
        >
          <thead>
            <tr>
              <th scope="col">Машина</th>
              {agentProviders.map((p) => (
                <th scope="col" key={p}>
                  {providerNames[p]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ws.data.servers.map((m) => {
              const Icon =
                m.transport === 'local'
                  ? Monitor
                  : m.transport === 'connector'
                    ? Laptop
                    : Server;
              return (
                <tr key={m.id}>
                  <th scope="row">
                    <div className="machine-default-name">
                      <Icon size={18} aria-hidden="true" />
                      <div>
                        <strong>{m.name}</strong>
                        <small>
                          {m.transport === 'local'
                            ? 'Хост панели'
                            : m.transport === 'connector'
                              ? 'Коннектор'
                              : 'SSH'}
                        </small>
                      </div>
                    </div>
                  </th>
                  {agentProviders.map((p) => {
                    const value = m.agentAccounts?.[p] || '';
                    const options = accountChoices(accounts, p, value);
                    return (
                      <td key={p}>
                        <span
                          className="mobile-provider-name"
                          aria-hidden="true"
                        >
                          {providerNames[p]}
                        </span>
                        {options.length > 1 ? (
                          <WorkspaceSelect
                            aria-label={`${providerNames[p]} · ${m.name}`}
                            value={value}
                            options={options}
                            disabled={saving || !ws.connection}
                            onValueChange={(id) => save(m.id, m.name, p, id)}
                          />
                        ) : (
                          <span
                            className="machine-profile"
                            title={options[0].label}
                          >
                            {p === 'claude'
                              ? 'Профиль Claude на машине'
                              : options[0].label}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorText error={error} />
      <output className="settings-feedback">
        {saving ? 'Сохраняем выбор…' : notice}
      </output>
    </section>
  );
}

export function AccountsSettings({ hub, ws }: { hub: Hub; ws: Workspace }) {
  const [form, setForm] = useState<AgentAccount | 'new' | 'claude' | null>(
      null,
    ),
    [login, setLogin] = useState<AccountLogin | null>(null),
    [renaming, setRenaming] = useState<AgentAccount | null>(null),
    [deleting, setDeleting] = useState<AgentAccount | null>(null),
    [dialogError, setDialogError] = useState(''),
    [notice, setNotice] = useState(''),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const accounts = hub.data.accounts || [];
  const linkedChats = deleting
    ? hub.data.sessions.filter((s) => s.accountId === deleting.id)
    : [];
  const linkedMachines = deleting
    ? ws.data.servers.filter(
        (m) => m.agentAccounts?.[deleting.provider] === deleting.id,
      )
    : [];
  const hasActiveChats = linkedChats.some((s) =>
    ['connecting', 'running', 'approval'].includes(s.status),
  );
  async function openLogin(account: AgentAccount) {
    setError('');
    if (account.status !== 'pending') {
      setForm(account);
      return;
    }
    try {
      setLogin(await hub.api<AccountLogin>(`/hub/accounts/${account.id}`));
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  async function disconnect(account: AgentAccount) {
    setBusy(true);
    setError('');
    try {
      await hub.mutate(`/accounts/${account.id}`, {}, 'DELETE');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const hasAssignments = ws.data.servers.some((machine) =>
    agentProviders.some((provider) => machine.agentAccounts?.[provider]),
  );
  return (
    <>
      <section className="settings-section">
        <header className="settings-section-heading">
          <h2>Сохранённые аккаунты</h2>
          <button
            type="button"
            className="hub-button primary"
            disabled={!ws.connection}
            aria-label="Добавить аккаунт"
            onClick={() => setForm('new')}
          >
            <Plus size={16} />
            <span>
              Добавить<span className="settings-add-object"> аккаунт</span>
            </span>
          </button>
        </header>
        <div className="settings-surface">
          {!hub.ready && hub.error ? (
            <div className="settings-empty">
              <ErrorText error={hub.error} />
            </div>
          ) : !hub.ready && ws.connection ? (
            <output className="settings-empty">Загружаем аккаунты…</output>
          ) : !accounts.length ? (
            <div className="settings-empty">
              <span className="settings-row-icon">
                <UserRound size={20} />
              </span>
              <div>
                <h3>Пока нет сохранённых аккаунтов</h3>
                <p>
                  Добавьте аккаунт агента, чтобы выбирать его в чатах и на
                  машинах.
                </p>
              </div>
            </div>
          ) : (
            accounts.map((a) => {
              const Icon = providerIcons[a.provider];
              return (
                <article key={a.id} className="settings-account">
                  <div className="settings-account-row">
                    <span
                      className={`settings-row-icon provider-${a.provider}`}
                    >
                      <Icon size={19} />
                    </span>
                    <div className="settings-account-identity">
                      <h3>{a.name}</h3>
                      <p>
                        {[
                          providerNames[a.provider],
                          a.provider === 'opencode' && a.vendor,
                          a.email,
                          a.planType,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <span className={`account-state ${a.status}`}>
                      <i aria-hidden="true" />
                      {labels[a.status]}
                    </span>
                    {a.status !== 'connected' && (
                      <button
                        className="hub-button account-login-action"
                        disabled={busy || !ws.connection}
                        onClick={() => void openLogin(a)}
                      >
                        {a.status === 'pending'
                          ? 'Продолжить вход'
                          : 'Подключить'}
                      </button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className="icon-button account-menu-trigger"
                        aria-label={`Действия с аккаунтом ${a.name}`}
                        title="Действия с аккаунтом"
                      >
                        <MoreHorizontal size={18} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        className="workspace-menu"
                        align="end"
                      >
                        {a.status === 'connected' && (
                          <DropdownMenuItem
                            disabled={busy}
                            onClick={() => void openLogin(a)}
                          >
                            <LogIn />
                            Войти повторно
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          disabled={busy}
                          onClick={() => {
                            setDialogError('');
                            setName(a.name);
                            setRenaming(a);
                          }}
                        >
                          <Pencil />
                          Переименовать
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={busy || a.status === 'disconnected'}
                          onClick={() => void disconnect(a)}
                        >
                          <Unplug />
                          Отключить
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={busy}
                          onClick={() => {
                            setDialogError('');
                            setDeleting(a);
                          }}
                        >
                          <Trash2 />
                          Удалить аккаунт
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <ErrorText error={a.error || ''} />
                  {!!a.pendingCleanup && (
                    <p className="model-catalog-note">
                      Удаление доступа с {a.pendingCleanup} профилей машин
                      завершится после их подключения.
                    </p>
                  )}
                </article>
              );
            })
          )}
          <div className="settings-subscription">
            <span className="settings-row-icon provider-claude">
              <Sparkles size={19} />
            </span>
            <div>
              <h3>Подписка Claude</h3>
              <p>Вход в Claude на выбранной машине без API-ключа.</p>
            </div>
            <button
              type="button"
              className="hub-button"
              aria-label="Подключить подписку Claude"
              disabled={!ws.connection}
              onClick={() => setForm('claude')}
            >
              Подключить <ChevronRight size={15} />
            </button>
          </div>
        </div>
        <ErrorText error={error} />
        {notice && <output className="settings-feedback">{notice}</output>}
      </section>
      {ws.data.servers.length > 0 &&
        (hasAssignments || accounts.some((a) => a.status === 'connected')) && (
          <MachineDefaults hub={hub} ws={ws} />
        )}
      {form && (
        <AccountForm
          hub={hub}
          ws={ws}
          initialProvider={form === 'claude' ? 'claude' : undefined}
          account={typeof form === 'object' ? form : undefined}
          onClose={() => setForm(null)}
          onStarted={(a) => {
            setForm(null);
            void hub.refresh();
            if (a.status === 'pending') setLogin(a);
          }}
        />
      )}
      {login && (
        <LoginDialog
          hub={hub}
          initial={login}
          onClose={() => setLogin(null)}
          onRetry={(a) => {
            setLogin(null);
            setForm(a);
          }}
        />
      )}
      {renaming && (
        <Modal
          title="Название аккаунта"
          onClose={() => {
            if (!busy) setRenaming(null);
          }}
        >
          <form
            className="hub-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setDialogError('');
              try {
                await hub.mutate(`/accounts/${renaming.id}`, { name }, 'PATCH');
                setRenaming(null);
              } catch (e) {
                setDialogError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Название">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                required
              />
            </Field>
            <ErrorText error={dialogError} />
            <div className="form-actions">
              <button
                type="button"
                className="hub-button"
                disabled={busy}
                onClick={() => setRenaming(null)}
              >
                Отмена
              </button>
              <Submit
                busy={busy}
                disabled={!name.trim() || name.trim() === renaming.name}
              >
                Сохранить
              </Submit>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Удалить аккаунт?"
          description={`«${deleting.name}» будет удалён из MayPlane.`}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <p className="hub-note">
            Запись аккаунта и сохранённые ключи или токены будут удалены из
            панели. Для повторного использования потребуется добавить аккаунт
            заново.
          </p>
          <p className="hub-note">
            Чаты и их история сохранятся
            {linkedChats.length ? ` (${linkedChats.length})` : ''}. В связанных
            чатах нужно будет выбрать другой аккаунт. Проекты, файлы и аккаунт у
            провайдера сохранятся.
          </p>
          {linkedMachines.length > 0 && (
            <p className="hub-note">
              На {linkedMachines.length} машинах этот аккаунт перестанет быть
              выбранным по умолчанию. Новые чаты будут использовать профиль
              машины.
            </p>
          )}
          <p className="hub-note">
            Копии доступа в отдельных профилях чатов будут очищены в фоне. Для
            недоступных машин очистка продолжится после подключения.
          </p>
          {hasActiveChats && (
            <p className="model-catalog-note">
              Сначала завершите или остановите активные чаты этого аккаунта.
            </p>
          )}
          <ErrorText error={dialogError} />
          <div className="form-actions">
            <button
              type="button"
              className="hub-button"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="hub-button danger"
              disabled={busy || hasActiveChats}
              onClick={async () => {
                setBusy(true);
                setDialogError('');
                try {
                  const result = await ws.action<{ pendingCleanup: number }>(
                    `/hub/accounts/${deleting.id}/remove`,
                    { confirm: true },
                    'DELETE',
                  );
                  setDeleting(null);
                  setNotice(
                    result.pendingCleanup
                      ? 'Аккаунт удалён. Очистка копий доступа на машинах продолжается в фоне.'
                      : 'Аккаунт удалён. История чатов сохранена.',
                  );
                  await hub.refresh();
                } catch (e) {
                  setDialogError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Trash2 size={14} /> {busy ? 'Удаление…' : 'Удалить аккаунт'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
