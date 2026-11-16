'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import type { Server } from '@/lib/domain';
import type { AgentStatus, Hub } from '@/lib/hub';
import { isClaudeSubscription } from '@/lib/claude-auth.mjs';
import { ErrorText, Field } from './hub-ui';

type Task = {
  id: string;
  machineId: string;
  provider: string;
  operation: string;
  status: string;
  output: string;
  loginUrl?: string;
};

export function ClaudeSubscription({
  hub,
  machines,
  onUse,
}: {
  hub: Hub;
  machines: Server[];
  onUse: (machineId: string) => Promise<unknown>;
}) {
  const [machineId, setMachineId] = useState('');
  const machine = machines.find((m) => m.id === machineId);
  const available =
    !!machine &&
    (machine.transport !== 'connector' || machine.status === 'online');
  const [status, setStatus] = useState<AgentStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(available),
    [taskId, setTaskId] = useState(
      hub.data.tasks?.find(
        (t) => t.machineId === machineId && t.provider === 'claude',
      )?.id || '',
    ),
    [task, setTask] = useState<Task | null>(null),
    [code, setCode] = useState(''),
    [confirmInstall, setConfirmInstall] = useState(false);
  const api = hub.api;
  const base = `/machines/${machineId}/agents/claude`;
  const check = useCallback(async () => {
    if (!machineId) return;
    setBusy(true);
    setError('');
    try {
      setStatus(
        await api<AgentStatus>(
          `/hub/machines/${machineId}/agents/claude/subscription`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [api, machineId]);
  useEffect(() => {
    let active = true;
    if (!machineId || !available) return;
    void api<AgentStatus>(
      `/hub/machines/${machineId}/agents/claude/subscription`,
    )
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [api, machineId, available]);
  useEffect(() => {
    if (!taskId) return;
    let active = true,
      loading = false;
    const poll = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<Task>(`/hub/tasks/${taskId}`);
        if (!active) return;
        setTask(result);
        if (result.status !== 'running') {
          setTaskId('');
          setCode('');
          if (result.status === 'success') await check();
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
  }, [taskId, api, check]);
  async function operate(operation: 'install' | 'login') {
    setBusy(true);
    setError('');
    setTask(null);
    setCode('');
    try {
      const result = await hub.mutate<{ id: string }>(base + '/' + operation, {
        confirm: true,
      });
      setTaskId(result.id);
      setConfirmInstall(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sendCode() {
    if (!taskId || !code.trim()) return;
    setBusy(true);
    setError('');
    try {
      await hub.mutate(`/tasks/${taskId}/input`, { input: code.trim() });
      setCode('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const subscription = status?.ready && isClaudeSubscription(status.account);
  return (
    <div className="hub-form">
      <Field
        label="Машина для входа"
        hint={
          machines.length
            ? 'Выберите, где подключить ваш Claude-аккаунт. Установка и вход выполняются в этом окне.'
            : 'Сначала добавьте машину в разделе «Серверы».'
        }
      >
        <select
          aria-label="Машина для подписки Claude"
          required
          value={machineId}
          disabled={busy || !!taskId}
          onChange={(e) => {
            const id = e.target.value;
            setMachineId(id);
            setStatus(null);
            setTask(null);
            setCode('');
            setError('');
            setConfirmInstall(false);
            setTaskId(
              hub.data.tasks?.find(
                (t) => t.machineId === id && t.provider === 'claude',
              )?.id || '',
            );
            const next = machines.find((m) => m.id === id);
            setChecking(
              !!next &&
                (next.transport !== 'connector' || next.status === 'online'),
            );
          }}
        >
          <option value="" disabled>
            Выберите машину для входа
          </option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.transport === 'connector' && m.status !== 'online'
                ? ' · не в сети'
                : ''}
            </option>
          ))}
        </select>
      </Field>
      <p className="hub-note">
        Подписка Claude подключается без API-ключа. Сессия остаётся на выбранной
        машине.
      </p>
      {!available && !!machine && (
        <p className="hub-note">
          Подключите эту машину, чтобы установить Claude и войти.
        </p>
      )}
      {checking && !status && (
        <p className="hub-note">
          <LoaderCircle className="spin" size={15} /> Проверяем Claude Code и
          аккаунт машины…
        </p>
      )}
      {status && (
        <div className="hub-note">
          {subscription ? <Check size={16} /> : <LogIn size={16} />}{' '}
          {subscription
            ? `Подписка подключена${status.account?.email ? ` · ${status.account.email}` : ''}${status.account?.planType ? ` · ${status.account.planType}` : ''}`
            : status.missing
              ? 'Claude Code ещё не установлен на этой машине. Нажмите «Установить Claude Code», затем войдите с подпиской.'
              : status.account?.type === 'api_key'
                ? 'На машине сейчас активен API-ключ. Войдите с подпиской; если ключ задан в окружении или настройках CLI, уберите его, чтобы использовать подписку.'
                : status.ready
                  ? 'Выполните вход именно в аккаунт с подпиской Claude.'
                  : status.error || 'Claude Code ещё не установлен.'}
        </div>
      )}
      <div className="provider-actions">
        <button
          type="button"
          className="hub-button"
          disabled={busy || checking || !!taskId || !available}
          onClick={() => void check()}
        >
          <RefreshCw size={14} /> Проверить подключение
        </button>
        {(!status?.installed || !status.adapterVersion) && (
          <button
            type="button"
            className="hub-button"
            disabled={busy || checking || !!taskId || !available}
            onClick={() => setConfirmInstall(true)}
          >
            <Download size={14} /> Установить Claude Code
          </button>
        )}
        <button
          type="button"
          className="hub-button primary"
          disabled={
            busy || checking || !!taskId || !available || !status?.installed
          }
          onClick={() => void operate('login')}
        >
          <LogIn size={14} />{' '}
          {subscription ? 'Сменить аккаунт Claude' : 'Войти с подпиской Claude'}
        </button>
      </div>
      {confirmInstall && (
        <div className="device-login">
          <p>
            Установить Claude Code и адаптер на <b>{machine?.name}</b> от
            пользователя <b>{machine?.username}</b>? Будут загружены пакеты и
            при необходимости Node.js. Настройки и проекты сохранятся.
          </p>
          <div className="provider-actions">
            <button
              type="button"
              className="hub-button"
              onClick={() => setConfirmInstall(false)}
            >
              Отмена установки
            </button>
            <button
              type="button"
              className="hub-button primary"
              disabled={busy}
              onClick={() => void operate('install')}
            >
              Установить на эту машину
            </button>
          </div>
        </div>
      )}
      {task && (
        <div className="task-output">
          <div>
            <span>
              {task.status === 'running'
                ? 'Ожидаем завершения…'
                : task.status === 'success'
                  ? 'Готово'
                  : 'Операция прервана или завершилась с ошибкой'}
            </span>
            {taskId && (
              <button
                className="text-button"
                type="button"
                onClick={async () => {
                  try {
                    await hub.mutate(`/tasks/${taskId}/stop`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Остановить
              </button>
            )}
          </div>
          <pre>{task.output || 'Ожидаем вывод Claude Code…'}</pre>
          {task.loginUrl && task.status === 'running' && (
            <>
              <p>
                Откройте страницу Claude и войдите в аккаунт с подпиской. Пароль
                вводится только на сайте Claude.
              </p>
              <a
                className="hub-button primary"
                href={task.loginUrl}
                target="_blank"
                rel="noreferrer"
              >
                Открыть вход Claude <ExternalLink size={14} />
              </a>
              <Field label="Код со страницы входа, если Claude его запросил">
                <input
                  aria-label="Код входа Claude"
                  type="password"
                  autoComplete="off"
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void sendCode();
                    }
                  }}
                />
              </Field>
              <button
                type="button"
                className="hub-button"
                disabled={busy || !code.trim()}
                onClick={() => void sendCode()}
              >
                Отправить код Claude
              </button>
            </>
          )}
        </div>
      )}
      {subscription && (
        <>
          <p className="hub-note">
            Новые чаты Claude на этой машине будут использовать подписку. Уже
            созданные чаты сохранят выбранные аккаунты. Для другого подписочного
            аккаунта используйте «Сменить аккаунт»; штатный профиль машины общий
            для её чатов.
          </p>
          <button
            type="button"
            className="hub-button primary"
            disabled={busy || !!taskId}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await onUse(machineId);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Использовать подписку для новых чатов
          </button>
        </>
      )}
      <ErrorText error={error} />
    </div>
  );
}
