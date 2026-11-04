'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ShieldCheck,
  LogOut,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import { panelCsrf, setPanelCsrf } from '@/lib/panel-session';
import { ErrorText, Field, Submit } from './hub-ui';

type OwnerSession = {
  authenticated: boolean;
  configured?: boolean;
  user?: { username: string };
  csrf?: string;
  expiresAt?: string;
  publicUrl?: string;
  secure?: boolean;
  origin?: string;
};
const OwnerContext = createContext<{
  session: OwnerSession;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  change: (body: Record<string, string>) => Promise<void>;
} | null>(null);
export function usePanelAuth() {
  const value = useContext(OwnerContext);
  if (!value) throw new Error('Owner authentication is not mounted');
  return value;
}
async function authRequest<T = OwnerSession>(
  path: string,
  body?: Record<string, string>,
): Promise<T> {
  const response = await fetch('/api/auth/' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body
      ? { 'Content-Type': 'application/json', 'X-MayPlane-CSRF': panelCsrf() }
      : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const value = (await response.json()) as OwnerSession & { error?: string };
  if (!response.ok)
    throw new Error(value.error || 'Не удалось связаться с панелью');
  return value as T;
}

export function PanelAuth({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<OwnerSession | null>(null),
    [error, setError] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    ++generation.current;
  }, []);
  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current;
    const value = await authRequest('session');
    if (requestGeneration !== generation.current) return;
    setPanelCsrf(value.csrf || '');
    setSession({ ...value, origin: window.location.origin });
    setError('');
  }, []);
  useEffect(() => {
    let active = true;
    const check = () => {
      void refresh().catch((e: Error) => {
        if (active) setError(e.message);
      });
    };
    const initial = setTimeout(check, 0);
    const timer = setInterval(check, 60000);
    window.addEventListener('mayplane:unauthorized', check);
    return () => {
      active = false;
      invalidate();
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener('mayplane:unauthorized', check);
      setPanelCsrf('');
    };
  }, [refresh, invalidate]);
  const logout = useCallback(async () => {
    ++generation.current;
    await authRequest('logout', {});
    ++generation.current;
    setPanelCsrf('');
    setSession({ authenticated: false, configured: true });
  }, []);
  const change = useCallback(
    async (body: Record<string, string>) => {
      ++generation.current;
      await authRequest('credentials', body);
      await refresh();
    },
    [refresh],
  );
  return (
    <OwnerContext.Provider
      value={{
        session: session || { authenticated: false },
        refresh,
        logout,
        change,
      }}
    >
      {session?.authenticated ? (
        children
      ) : (
        <main className="owner-auth-page">
          <div className="owner-auth-card">
            <div className="owner-auth-brand">
              <LockKeyhole size={24} />
              <strong>
                MayPlane<span>.</span>
              </strong>
            </div>
            <h1>
              {session?.configured === false
                ? 'Настройте вход владельца'
                : 'Вход в панель'}
            </h1>
            <p>Ваши машины, проекты и агенты — в личном пространстве.</p>
            {!session && !error ? (
              <div className="owner-auth-loading">
                <LoaderCircle size={18} className="spin" /> Проверяем
                подключение…
              </div>
            ) : session?.configured === false ? (
              <div className="owner-setup-help">
                На машине панели выполните <code>npm run runner:setup</code>.
                Команда создаст логин и покажет пароль для первого входа.
              </div>
            ) : session ? (
              <form
                className="hub-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError('');
                  try {
                    await authRequest('login', { username, password });
                    setPassword('');
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Field label="Логин">
                  <input
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    maxLength={64}
                    disabled={busy}
                  />
                </Field>
                <Field label="Пароль">
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    maxLength={1024}
                    disabled={busy}
                  />
                </Field>
                <ErrorText error={error} />
                <Submit busy={busy}>Войти</Submit>
              </form>
            ) : (
              <ErrorText error={error} />
            )}
            {(!session || session.configured === false) && (
              <button
                className="hub-button"
                type="button"
                onClick={() =>
                  void refresh().catch((e: Error) => setError(e.message))
                }
              >
                <RefreshCw size={14} /> Проверить подключение
              </button>
            )}
            <div className="owner-auth-note">
              <ShieldCheck size={15} />
              <span>
                Данные для первого входа выдаются при установке. Восстановить
                доступ можно командой <code>npm run auth:reset</code> на машине
                панели.
              </span>
            </div>
          </div>
        </main>
      )}
    </OwnerContext.Provider>
  );
}

export function OwnerSettings() {
  const auth = usePanelAuth();
  const [username, setUsername] = useState(auth.session.user?.username || ''),
    [currentPassword, setCurrent] = useState(''),
    [newPassword, setNew] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [certificate, setCertificate] = useState<{
    enabled: boolean;
    managed: boolean;
    state: string;
    expiresAt?: string;
    issuer?: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const check = () =>
      void authRequest<NonNullable<typeof certificate>>('deployment')
        .then((value) => {
          if (active) setCertificate(value);
        })
        .catch(() => {
          if (active)
            setCertificate({
              enabled: true,
              managed: false,
              state: 'unavailable',
            });
        });
    const initial = setTimeout(check, 0),
      timer = setInterval(check, 60000);
    return () => {
      active = false;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);
  return (
    <section className="detail-card owner-settings">
      <div className="section-title">
        <h2>Доступ к панели</h2>
        <ShieldCheck size={18} />
      </div>
      <div className="owner-session-summary">
        <div>
          <strong>{auth.session.user?.username}</strong>
          <small>
            {auth.session.secure
              ? 'HTTPS · защищённое соединение'
              : 'Локальное подключение · сеть не открыта'}
          </small>
        </div>
        <button
          className="hub-button"
          disabled={busy}
          onClick={() =>
            void auth.logout().catch((e: Error) => setError(e.message))
          }
        >
          <LogOut size={14} /> Выйти
        </button>
      </div>
      <Field label="Адрес панели">
        <input
          value={auth.session.publicUrl || auth.session.origin || ''}
          readOnly
          aria-readonly="true"
        />
      </Field>
      <output className="owner-certificate">
        <strong>
          {!certificate
            ? 'Проверяем сертификат…'
            : !certificate.enabled
              ? 'Локальный режим'
              : certificate.state === 'valid'
                ? 'Сертификат HTTPS действителен'
                : certificate.state === 'expiring'
                  ? 'Срок сертификата скоро истекает'
                  : 'Не удалось проверить сертификат HTTPS'}
        </strong>
        {certificate?.expiresAt && (
          <span>
            Действует до{' '}
            {new Date(certificate.expiresAt).toLocaleString('ru-RU')}
            {certificate.issuer ? ` · ${certificate.issuer}` : ''}
          </span>
        )}
        <small>
          {certificate?.managed
            ? 'Caddy автоматически получает и продлевает сертификат. Панель проверяет его каждую минуту, пока открыты настройки.'
            : certificate?.enabled
              ? 'Сертификатом управляет ваш HTTPS-прокси. Проверьте его настройку и доступность.'
              : certificate
                ? 'Панель доступна только с этой машины. Сертификат не требуется.'
                : ''}
        </small>
      </output>
      <form
        className="hub-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setNotice('');
          if (newPassword !== confirmation) {
            setError('Новые пароли не совпадают.');
            return;
          }
          setBusy(true);
          try {
            await auth.change({ username, currentPassword, newPassword });
            setCurrent('');
            setNew('');
            setConfirmation('');
            setNotice('Данные для входа обновлены. Другие сессии завершены.');
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Логин владельца">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={64}
            autoComplete="username"
            disabled={busy}
          />
        </Field>
        <Field label="Текущий пароль">
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </Field>
        <Field
          label="Новый пароль"
          hint="Не менее 15 символов. Оставьте пустым, чтобы изменить только логин."
        >
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            minLength={15}
            maxLength={1024}
            autoComplete="new-password"
            disabled={busy}
          />
        </Field>
        <Field label="Повторите новый пароль">
          <input
            type="password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            required={!!newPassword}
          />
        </Field>
        <p className="hub-note">
          Изменение требует текущий пароль и завершает остальные входы, а также
          открытые SSH-консоли. Чаты и данные сохраняются. Обычная сессия
          действует до 12 часов.
        </p>
        <ErrorText error={error} />
        {notice && <output className="owner-settings-notice">{notice}</output>}
        <Submit
          busy={busy}
          disabled={
            !currentPassword ||
            (!newPassword && username === auth.session.user?.username)
          }
        >
          Сохранить данные для входа
        </Submit>
      </form>
    </section>
  );
}
