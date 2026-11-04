'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, LoaderCircle, RefreshCw, Clock3 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import type {
  Hub,
  AgentProvider,
  AgentLimits,
  LimitWindow,
  SessionDetail,
} from '@/lib/hub';
import { providerNames } from '@/lib/hub';
import { useNow } from '@/lib/use-now';

const num = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
function duration(minutes: number | null) {
  if (!minutes) return 'Окно использования';
  if (minutes === 10080) return 'Неделя';
  if (minutes % 1440 === 0) return `${minutes / 1440} дн`;
  if (minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${num.format(minutes)} мин`;
}
function countdown(reset: string, now: number) {
  const minutes = Math.ceil((Date.parse(reset) - now) / 60000);
  if (minutes <= 0) return 'Период завершён · ждём обновления';
  if (minutes < 60) return `через ${minutes} мин`;
  if (minutes < 1440)
    return `через ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  return `через ${Math.floor(minutes / 1440)} дн ${Math.floor((minutes % 1440) / 60)} ч`;
}
function QuotaWindow({ value, now }: { value: LimitWindow; now: number }) {
  const remaining = Math.max(0, 100 - value.usedPercent);
  const expired = !!value.resetsAt && Date.parse(value.resetsAt) <= now;
  return (
    <div
      className={`quota-window ${remaining <= 10 ? 'low' : ''} ${expired ? 'expired' : ''}`}
    >
      <div className="quota-window-heading">
        <span>{duration(value.windowDurationMins)}</span>
        <strong>{num.format(remaining)}% осталось</strong>
      </div>
      <progress
        className="quota-bar"
        aria-label={`Осталось квоты: ${duration(value.windowDurationMins)}`}
        max={100}
        value={remaining}
      />
      <small>Использовано {num.format(value.usedPercent)}%</small>
      {value.resetsAt ? (
        <div className="quota-reset">
          <Clock3 size={12} />
          <span>
            Сброс {countdown(value.resetsAt, now)}
            <time dateTime={value.resetsAt}>
              {new Date(value.resetsAt).toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
                timeZoneName: 'short',
              })}
            </time>
          </span>
        </div>
      ) : (
        <small>Время сброса агент не передал</small>
      )}
    </div>
  );
}

type LimitsProps = {
  hub: Hub;
  machineId: string;
  provider: AgentProvider;
  accountId?: string | null;
  sessionId?: string;
  usage?: SessionDetail['usage'];
  disabled?: boolean;
};

export function AgentLimitsControl(props: LimitsProps) {
  return (
    <LimitsControl
      key={`${props.machineId}:${props.provider}:${props.accountId === undefined ? 'default' : props.accountId || 'native'}:${props.sessionId || ''}`}
      {...props}
    />
  );
}

function LimitsControl({
  hub,
  machineId,
  provider,
  accountId,
  sessionId,
  usage,
  disabled = false,
}: LimitsProps) {
  const [open, setOpen] = useState(false),
    [limits, setLimits] = useState<AgentLimits | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const now = useNow();
  const lifetime = useRef({ active: false, pending: false });
  const api = hub.api;
  const load = useCallback(
    async (refresh = false) => {
      const scope = lifetime.current;
      if (!machineId || disabled || !scope.active || scope.pending) return;
      scope.pending = true;
      try {
        const value = await api<AgentLimits>(
          `/hub/machines/${machineId}/agents/${provider}/limits`,
          'POST',
          {
            ...(sessionId ? { sessionId } : {}),
            ...(accountId !== undefined ? { accountId } : {}),
            refresh,
          },
        );
        if (scope.active) {
          setLimits(value);
          setError('');
        }
      } catch (e) {
        if (scope.active) setError((e as Error).message);
      } finally {
        if (scope.active) {
          scope.pending = false;
          setLoading(false);
        }
      }
    },
    [api, machineId, provider, accountId, sessionId, disabled],
  );
  useEffect(() => {
    const scope = { active: true, pending: false };
    lifetime.current = scope;
    const initial = setTimeout(() => void load(), 0);
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    const focus = () => {
      if (!document.hidden) void load();
    };
    window.addEventListener('focus', focus);
    return () => {
      scope.active = false;
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [load]);
  const account = (hub.data.accounts || []).find(
    (a) => a.id === (accountId === undefined ? limits?.accountId : accountId),
  );
  const mainBucket =
    limits?.buckets.find((b) => b.id === 'codex') || limits?.buckets[0];
  const windows = [mainBucket?.primary, mainBucket?.secondary].filter(
    (w): w is LimitWindow => !!w,
  );
  const currentWindows = windows.filter(
    (w) => !w.resetsAt || Date.parse(w.resetsAt) > now,
  );
  const remaining = currentWindows.length
    ? Math.min(...currentWindows.map((w) => 100 - w.usedPercent))
    : null;
  const label =
    loading && !limits
      ? 'Лимиты…'
      : limits?.status === 'available' && remaining != null
        ? `Лимиты · ${num.format(remaining)}%`
        : 'Лимиты';
  let note =
    'Агент не вернул лимиты. Проверьте соединение и авторизацию или попробуйте обновить позже.';
  if (limits?.reason === 'provider')
    note =
      'OpenCode пока не передаёт панели остаток квоты аккаунта. Лимиты и время сброса смотрите в кабинете выбранного провайдера.';
  else if (limits?.status === 'unauthenticated')
    note =
      'Для просмотра лимитов войдите в аккаунт агента. Аккаунт можно выбрать рядом с моделью или подключить в настройках.';
  else if (limits?.reason === 'api-key')
    note =
      'Лимиты подписки ChatGPT недоступны при работе с API-ключом. Расходы и ограничения проверяйте в кабинете провайдера.';
  else if (limits?.status === 'unsupported')
    note =
      'Эта версия или конфигурация агента не предоставляет лимиты аккаунта.';
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) void load();
      }}
    >
      <PopoverTrigger
        type="button"
        className={`chat-model-trigger agent-limits-trigger ${remaining != null && remaining <= 10 ? 'low' : ''}`}
        disabled={disabled || !machineId}
        aria-label="Лимиты выбранного агента и аккаунта"
      >
        <Gauge size={13} />
        <span>{label}</span>
        {limits?.stale && (
          <i className="quota-stale-dot" title="Данные устарели" />
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="agent-limits-popup">
        <div className="quota-heading">
          <div>
            <strong>Лимиты {providerNames[provider]}</strong>
            <small>
              {account?.name || 'Аккаунт машины'}
              {account?.planType ? ` · ${account.planType}` : ''}
            </small>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              setLoading(true);
              void load(true);
            }}
            disabled={loading || disabled}
            aria-label="Обновить лимиты"
          >
            {loading ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <RefreshCw size={15} />
            )}
          </button>
        </div>
        {loading && !limits && (
          <output className="quota-note">Получаем данные аккаунта…</output>
        )}
        {limits?.buckets.map((bucket) => (
          <section className="quota-bucket" key={bucket.id}>
            <div className="quota-bucket-title">
              <b>{bucket.name}</b>
              {bucket.planType && <small>{bucket.planType}</small>}
            </div>
            {bucket.primary && <QuotaWindow value={bucket.primary} now={now} />}
            {bucket.secondary && (
              <QuotaWindow value={bucket.secondary} now={now} />
            )}
            {bucket.credits && (
              <p className="quota-credits">
                Дополнительные кредиты:{' '}
                {bucket.credits.unlimited
                  ? 'без ограничений'
                  : bucket.credits.balance != null
                    ? num.format(bucket.credits.balance)
                    : bucket.credits.hasCredits === false
                      ? 'закончились'
                      : bucket.credits.hasCredits
                        ? 'доступны'
                        : 'баланс не передан'}
              </p>
            )}
          </section>
        ))}
        {limits && limits.status !== 'available' && (
          <p className="quota-note">{note}</p>
        )}
        {limits?.availableResets != null && (
          <p className="quota-credits">
            Доступно сбросов лимита: {limits.availableResets}
          </p>
        )}
        {usage && (
          <section className="quota-context">
            <strong>Контекст чата</strong>
            <p>
              {num.format(usage.used)} из {num.format(usage.size)} токенов{' '}
              <b>
                · {num.format(Math.min(100, (100 * usage.used) / usage.size))}%
              </b>
            </p>
            <small>
              Размер контекста, переданный агентом; меняется при сжатии истории.
            </small>
            {usage.cost && (
              <p>
                Стоимость чата:{' '}
                {new Intl.NumberFormat('ru-RU', {
                  style: 'currency',
                  currency: usage.cost.currency,
                  maximumFractionDigits: 6,
                }).format(usage.cost.amount)}
              </p>
            )}
          </section>
        )}
        {provider === 'opencode' && !usage && (
          <p className="quota-note">
            Расход контекста и стоимость появятся после ответа, если версия
            агента их передаёт.
          </p>
        )}
        {error && (
          <p className="hub-error" role="alert">
            {error}
          </p>
        )}
        {limits?.stale && (
          <p className="quota-note quota-warning">
            Не удалось обновить. Показаны последние полученные данные.
          </p>
        )}
        {limits && (
          <footer className="quota-footer">
            Проверено{' '}
            {new Date(limits.fetchedAt).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · автообновление
            {limits.status === 'available' && (
              <span>Квота аккаунта общая для его чатов и машин.</span>
            )}
          </footer>
        )}
      </PopoverContent>
    </Popover>
  );
}
