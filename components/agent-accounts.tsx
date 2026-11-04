'use client';
import { useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogIn,
  Plus,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import type { AgentAccount, AgentProvider, AccountLogin, Hub } from '@/lib/hub';
import { providerNames } from '@/lib/hub';
import type { Workspace } from '@/lib/use-workspace';
import { Modal, Field, ErrorText, CopyButton, Submit } from './hub-ui';

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
  type: 'api' | 'oauth';
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
  const accounts = (hub.data.accounts || []).filter(
    (a) => a.provider === provider,
  );
  return (
    <label className="hub-field account-select">
      <span>Аккаунт</span>
      <select
        aria-label="Аккаунт агента"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {defaultName !== undefined && (
          <option value="__default">
            По умолчанию сервера · {defaultName || 'аккаунт машины'}
          </option>
        )}
        {allowNative && <option value="">Аккаунт машины</option>}
        {accounts
          .filter((a) => a.status === 'connected' || a.id === value)
          .map((a) => (
            <option key={a.id} value={a.id} disabled={a.status !== 'connected'}>
              {a.name}
              {a.email ? ` · ${a.email}` : ''}
              {a.status !== 'connected' ? ` · ${labels[a.status]}` : ''}
            </option>
          ))}
        {!!value &&
          value !== '__default' &&
          !accounts.some((a) => a.id === value) && (
            <option value={value} disabled>
              Аккаунт недоступен
            </option>
          )}
      </select>
    </label>
  );
}

function AccountForm({
  hub,
  account,
  onClose,
  onStarted,
}: {
  hub: Hub;
  account?: AgentAccount;
  onClose: () => void;
  onStarted: (a: AccountLogin) => void;
}) {
  const [provider, setProvider] = useState<AgentProvider>(
      account?.provider || 'codex',
    ),
    [name, setName] = useState(account?.name || ''),
    [list, setList] = useState<AuthProvider[]>([]),
    [vendor, setVendor] = useState(account?.vendor || 'chatgpt'),
    [method, setMethod] = useState(''),
    [filter, setFilter] = useState(''),
    [inputs, setInputs] = useState<Record<string, string | boolean>>({}),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const api = hub.api;
  const selected = list.find((v) => v.id === vendor),
    auth = selected?.methods.find((m) => m.id === method);
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
      description="Подключите личный или рабочий аккаунт один раз и выбирайте его для машин и чатов."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="hub-form"
        onSubmit={async (e) => {
          e.preventDefault();
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
        {!account && (
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
          <select
            aria-label="Агент аккаунта"
            disabled={!!account || busy}
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as AgentProvider);
              setList([]);
              setLoading(true);
              setError('');
              setFilter('');
              setKey('');
            }}
          >
            <option value="codex">Codex</option>
            <option value="opencode">OpenCode</option>
          </select>
        </Field>
        {loading ? (
          <p className="hub-note">
            <LoaderCircle size={15} className="spin" /> Загружаем способы
            авторизации из агента…
          </p>
        ) : (
          <>
            {provider === 'opencode' && (
              <Field label="Провайдер">
                <input
                  aria-label="Поиск провайдера"
                  type="search"
                  placeholder="Найти провайдера…"
                  value={filter}
                  disabled={!!account || busy}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setVendor('');
                    setMethod('');
                    setKey('');
                  }}
                />
                <select
                  aria-label="Провайдер аккаунта"
                  disabled={!!account || busy}
                  value={vendor}
                  onChange={(e) => {
                    setVendor(e.target.value);
                    const v = list.find((v) => v.id === e.target.value);
                    selectMethod(
                      v?.methods.find(
                        (m) =>
                          m.type === 'oauth' && /device|headless/.test(m.id),
                      ) ||
                        v?.methods.find((m) => m.type === 'oauth') ||
                        v?.methods[0],
                    );
                  }}
                >
                  <option value="" disabled>
                    Выберите провайдера
                  </option>
                  {list
                    .filter(
                      (v) =>
                        !filter ||
                        `${v.id} ${v.name}`
                          .toLowerCase()
                          .includes(filter.toLowerCase()),
                    )
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field label="Способ подключения">
              <select
                aria-label="Способ подключения"
                required
                disabled={busy || !selected}
                value={method}
                onChange={(e) =>
                  selectMethod(
                    selected?.methods.find((m) => m.id === e.target.value),
                  )
                }
              >
                <option value="" disabled>
                  Выберите способ
                </option>
                {selected?.methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            {auth?.fields.filter(visible).map((f) => (
              <Field key={f.key} label={f.title} hint={f.description}>
                {f.options?.length ? (
                  <select
                    aria-label={f.title}
                    required={f.required}
                    disabled={busy}
                    value={String(inputs[f.key] || '')}
                    onChange={(e) =>
                      setInputs((x) => ({ ...x, [f.key]: e.target.value }))
                    }
                  >
                    <option value="" disabled>
                      Выберите значение
                    </option>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
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
        <p className="hub-note">
          <ShieldCheck size={16} /> Вход выполняется в отдельном профиле.
          Аккаунт вашего Codex или OpenCode вне панели не меняется.
        </p>
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
          <Submit busy={busy || loading || !method}>
            {auth?.type === 'api'
              ? 'Сохранить аккаунт'
              : 'Перейти к авторизации'}
          </Submit>
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

export function AccountsSettings({ hub, ws }: { hub: Hub; ws: Workspace }) {
  const [form, setForm] = useState<AgentAccount | 'new' | null>(null),
    [login, setLogin] = useState<AccountLogin | null>(null),
    [renaming, setRenaming] = useState<AgentAccount | null>(null),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const accounts = hub.data.accounts || [];
  return (
    <>
      <section className="detail-card accounts-settings">
        <div className="section-title">
          <div>
            <h2>Аккаунты агентов</h2>
            <p className="muted">
              Личные и рабочие аккаунты для ваших серверов и чатов.
            </p>
          </div>
          <button
            className="hub-button primary"
            onClick={() => setForm('new')}
            disabled={!ws.connection}
          >
            <Plus size={15} /> Добавить аккаунт
          </button>
        </div>
        {!accounts.length ? (
          <div className="accounts-empty">
            <UserRound size={25} />
            <strong>Подключите первый аккаунт</strong>
            <p>
              Войдите с ChatGPT для Codex или выберите провайдера OpenCode.
              Сохранённый аккаунт можно использовать на нескольких машинах.
            </p>
          </div>
        ) : (
          <div className="account-list">
            {accounts.map((a) => (
              <article className="account-card" key={a.id}>
                <div className="account-card-main">
                  <div className={`agent-logo ${a.provider}`}>
                    {a.authType === 'api' ? (
                      <KeyRound size={18} />
                    ) : (
                      <UserRound size={18} />
                    )}
                  </div>
                  <div>
                    <strong>{a.name}</strong>
                    <p>
                      {providerNames[a.provider]}
                      {a.provider === 'opencode' ? ` · ${a.vendor}` : ''}
                      {a.email ? ` · ${a.email}` : ''}
                      {a.planType ? ` · ${a.planType}` : ''}
                    </p>
                  </div>
                  <span
                    className={`state-badge ${a.status === 'connected' ? 'online' : ''}`}
                  >
                    {a.status === 'connected' && <Check size={12} />}
                    {labels[a.status]}
                  </span>
                </div>
                <div className="account-card-actions">
                  {a.status === 'pending' ? (
                    <button
                      className="hub-button"
                      onClick={async () => {
                        try {
                          setLogin(
                            await hub.api<AccountLogin>(
                              `/hub/accounts/${a.id}`,
                            ),
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Продолжить вход
                    </button>
                  ) : (
                    <button className="hub-button" onClick={() => setForm(a)}>
                      <LogIn size={14} />
                      {a.status === 'connected'
                        ? 'Войти повторно'
                        : 'Подключить'}
                    </button>
                  )}
                  <button
                    className="text-button"
                    onClick={() => {
                      setRenaming(a);
                      setName(a.name);
                    }}
                  >
                    Переименовать
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || a.status === 'disconnected'}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        await hub.mutate(`/accounts/${a.id}`, {}, 'DELETE');
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <X size={13} /> Отключить
                  </button>
                </div>
                <ErrorText error={a.error || ''} />
                {!!a.pendingCleanup && (
                  <p className="model-catalog-note">
                    Удаление доступа с {a.pendingCleanup} профилей машин
                    завершится после их подключения.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
        <ErrorText error={error} />
        <p className="hub-note">
          <ShieldCheck size={15} /> Токены хранятся на серверной части панели в
          зашифрованном виде. Codex получает доступ для выбранного процесса; для
          OpenCode используются отдельные профили аккаунтов.
        </p>
        <p className="model-catalog-note">
          Для OAuth в OpenCode доступен один активный чат на аккаунт: это
          защищает обновление токенов между машинами. API-ключи позволяют
          работать параллельно.
        </p>
      </section>
      {!!accounts.some((a) => a.status === 'connected') && (
        <section className="detail-card account-machine-defaults">
          <div className="section-title">
            <h2>Аккаунты на машинах</h2>
          </div>
          <p className="muted">
            Выбор по умолчанию для новых чатов. В существующих чатах аккаунт
            закреплён отдельно.
          </p>
          {ws.data.servers.map((m) => (
            <div className="account-machine-row" key={m.id}>
              <strong>{m.name}</strong>
              {(['codex', 'opencode'] as const).map((p) => (
                <label className="hub-field" key={p}>
                  <span>{providerNames[p]}</span>
                  <select
                    aria-label={`${providerNames[p]} · ${m.name}`}
                    value={m.agentAccounts?.[p] || ''}
                    disabled={busy}
                    onChange={async (e) => {
                      setBusy(true);
                      setError('');
                      try {
                        await ws.action(
                          `/hub/machines/${m.id}/agents/${p}/account`,
                          { accountId: e.target.value || null },
                        );
                        await hub.refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <option value="">Аккаунт машины</option>
                    {accounts
                      .filter(
                        (a) => a.provider === p && a.status === 'connected',
                      )
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {a.email ? ` · ${a.email}` : ''}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </div>
          ))}
        </section>
      )}
      {form && (
        <AccountForm
          hub={hub}
          account={form === 'new' ? undefined : form}
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
        <Modal title="Название аккаунта" onClose={() => setRenaming(null)}>
          <form
            className="hub-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await hub.mutate(`/accounts/${renaming.id}`, { name }, 'PATCH');
                setRenaming(null);
              } catch (e) {
                setError((e as Error).message);
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
            <Submit busy={busy}>Сохранить</Submit>
          </form>
        </Modal>
      )}
    </>
  );
}
