'use client';
import { AgentLimitsControl } from './agent-limits';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
  UserRound,
} from 'lucide-react';
import type {
  AgentProvider,
  AgentSession,
  Hub,
  ModelCatalog,
  ModelChoice,
} from '@/lib/hub';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';
import { ErrorText } from './hub-ui';
import { AccountSelect } from './agent-accounts';

const effortNames: Record<string, string> = {
  none: 'Без reasoning',
  minimal: 'Минимальный',
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
  xhigh: 'Очень высокий',
  max: 'Максимальный',
  ultra: 'Ultra',
  default: 'По умолчанию',
};
const effortName = (value: string) => effortNames[value] || value;

function ModelList({
  choices,
  value,
  disabled,
  onChange,
}: {
  choices: ModelChoice[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = choices.find((c) => c.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        className="model-select-button"
        aria-label="Модель"
        aria-expanded={open}
        disabled={disabled}
        title={selected?.name || value || 'Настройки агента'}
      >
        <span>{selected?.name || value || 'Настройки агента'}</span>
        <ChevronDown size={14} />
      </PopoverTrigger>
      <PopoverContent align="start" className="model-list-popup">
        <Command>
          <CommandInput
            aria-label="Поиск модели"
            placeholder="Найти модель или провайдера…"
          />
          <CommandList aria-label="Доступные модели">
            <CommandEmpty>Моделей по этому запросу нет</CommandEmpty>
            {[
              {
                id: '',
                name: 'Настройки агента',
                description: 'Использовать модель из конфигурации агента',
              },
              ...choices,
            ].map((c) => (
              <CommandItem
                key={c.id}
                title={c.description || c.name}
                value={c.id || '__agent_default'}
                keywords={[c.name, c.id]}
                onSelect={() => {
                  onChange(c.id);
                  setOpen(false);
                }}
              >
                <span className="model-option-text">
                  <strong>{c.name}</strong>
                  {c.id && <small>{c.id}</small>}
                </span>
                {value === c.id && <Check size={14} />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function AgentModelSelector({
  hub,
  machineId,
  provider,
  projectId,
  sessionId,
  accountId,
  model,
  reasoning,
  onChange,
  disabled = false,
  onLoading,
}: {
  hub: Hub;
  machineId: string;
  provider: AgentProvider;
  projectId?: string;
  sessionId?: string;
  accountId?: string | null;
  model: string;
  reasoning: string;
  onChange: (model: string, reasoning: string) => void;
  disabled?: boolean;
  onLoading?: (loading: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0),
    pending = useRef(false),
    modelRef = useRef(model),
    loadCallback = useRef(onLoading);
  useEffect(() => {
    modelRef.current = model;
    loadCallback.current = onLoading;
  }, [model, onLoading]);
  const invalidate = useCallback(() => {
    generation.current++;
    pending.current = false;
  }, []);
  const api = hub.api;
  const load = useCallback(
    async (refresh = false) => {
      if (!machineId || pending.current) return;
      const request = ++generation.current;
      pending.current = true;
      setLoading(true);
      loadCallback.current?.(true);
      setError('');
      try {
        const next = await api<ModelCatalog>(
          `/hub/machines/${machineId}/agents/${provider}/models`,
          'POST',
          { projectId, sessionId, accountId, model: modelRef.current, refresh },
        );
        if (request === generation.current) setCatalog(next);
      } catch (e) {
        if (request === generation.current) setError((e as Error).message);
      } finally {
        if (request === generation.current) {
          pending.current = false;
          setLoading(false);
          loadCallback.current?.(false);
        }
      }
    },
    [api, machineId, provider, projectId, sessionId, accountId],
  );
  useEffect(() => {
    invalidate();
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 60000);
    const focus = () => {
      void load();
    };
    window.addEventListener('focus', focus);
    return () => {
      invalidate();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [load, invalidate]);
  useEffect(() => {
    void load();
  }, [model, load]);
  const selected = catalog?.models.find((m) => m.id === model);
  const efforts = selected?.reasoning || [];
  const levels = efforts.filter((e) => e.id !== 'default');
  return (
    <div className="agent-model-selector" aria-busy={loading}>
      <div className="model-field-label">
        <span>Модель</span>
        <button
          type="button"
          className="text-button"
          disabled={!machineId || loading || disabled}
          onClick={() => void load(true)}
          aria-label="Обновить модели"
        >
          {loading ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RefreshCw size={13} />
          )}{' '}
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
      </div>
      <ModelList
        choices={catalog?.models || []}
        value={model}
        disabled={disabled || loading || !machineId}
        onChange={(value) => onChange(value, '')}
      />
      {!!levels.length && (
        <label className="hub-field reasoning-field">
          <span>Уровень reasoning</span>
          <select
            aria-label="Уровень reasoning"
            disabled={disabled || loading}
            value={reasoning === 'default' ? '' : reasoning}
            onChange={(e) => onChange(model, e.target.value)}
          >
            <option value="">
              По умолчанию
              {selected?.defaultReasoning &&
              selected.defaultReasoning !== 'default'
                ? ` · ${effortName(selected.defaultReasoning)}`
                : ''}
            </option>
            {levels.map((e) => (
              <option key={e.id} value={e.id} title={e.description}>
                {effortNames[e.id] || e.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {reasoning && !loading && !efforts.some((e) => e.id === reasoning) && (
        <p className="hub-error" role="alert">
          Уровень {reasoning} больше не доступен. Выберите модель заново.
        </p>
      )}
      {model && catalog && !selected && !loading && (
        <p className="hub-error" role="alert">
          Этой модели больше нет в каталоге агента. Выберите другую.
        </p>
      )}
      <ErrorText error={error} />
      <small className="model-catalog-note">
        {catalog
          ? `${catalog.models.length} моделей · список с выбранной машины, обновляется автоматически`
          : 'Модели и reasoning из конфигурации выбранного агента'}
      </small>
    </div>
  );
}

export function ChatModelSettings({
  hub,
  session,
  disabled,
  onAccounts,
  accountOnly = false,
}: {
  hub: Hub;
  session: AgentSession;
  disabled: boolean;
  onAccounts: () => void;
  accountOnly?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [accountId, setAccountId] = useState(session.accountId || ''),
    [model, setModel] = useState(session.model),
    [reasoning, setReasoning] = useState(session.reasoning || ''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const accountName = session.accountId
    ? (hub.data.accounts || []).find((a) => a.id === session.accountId)?.name ||
      'Аккаунт недоступен'
    : 'Аккаунт машины';
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        setOpen(value);
        if (value) {
          setAccountId(session.accountId || '');
          setModel(session.model);
          setReasoning(session.reasoning || '');
          setError('');
        }
      }}
    >
      <PopoverTrigger
        type="button"
        className="chat-model-trigger"
        aria-label={accountOnly ? 'Аккаунт чата' : 'Модель и reasoning'}
        disabled={disabled || busy}
        title={
          accountOnly
            ? accountName
            : `${session.model || 'Настройки агента'}${session.reasoning ? ` · ${effortName(session.reasoning)}` : ''}`
        }
      >
        {accountOnly && <UserRound size={12} />}
        <span>
          {accountOnly ? accountName : session.model || 'Модель агента'}
        </span>
        {!accountOnly && session.reasoning && (
          <small>{effortName(session.reasoning)}</small>
        )}
        <ChevronDown size={12} />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="chat-model-popup">
        <AccountSelect
          hub={hub}
          provider={session.provider}
          value={accountId}
          allowNative={!session.profileId}
          disabled={busy || disabled}
          onChange={(id) => {
            setAccountId(id);
            setModel('');
            setReasoning('');
            setError('');
          }}
        />
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setOpen(false);
            onAccounts();
          }}
        >
          Управление аккаунтами
        </button>
        {accountId !== (session.accountId || '') && (
          <small className="model-catalog-note">
            Выбранный аккаунт получит контекст этого чата. История переписки
            сохраняется.
          </small>
        )}
        {open && (
          <AgentLimitsControl
            key={`limits:${accountId}`}
            hub={hub}
            machineId={session.machineId}
            provider={session.provider}
            accountId={accountId || null}
            sessionId={session.id}
          />
        )}
        {open && !accountOnly && (
          <AgentModelSelector
            key={accountId}
            hub={hub}
            machineId={session.machineId}
            provider={session.provider}
            sessionId={session.id}
            accountId={accountId || null}
            model={model}
            reasoning={reasoning}
            disabled={busy || disabled}
            onLoading={setLoading}
            onChange={(m, r) => {
              setModel(m);
              setReasoning(r);
              setError('');
            }}
          />
        )}
        <ErrorText error={error} />
        <button
          type="button"
          className="hub-button primary"
          disabled={
            busy ||
            loading ||
            disabled ||
            (accountOnly && accountId === (session.accountId || ''))
          }
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await hub.mutate(
                `/sessions/${session.id}`,
                {
                  ...(!accountOnly ? { model, reasoning } : {}),
                  ...(accountId !== (session.accountId || '')
                    ? { accountId: accountId || null }
                    : {}),
                },
                'PATCH',
              );
              setOpen(false);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Сохранение…' : 'Применить'}
        </button>
        <small className="model-catalog-note">
          Выбор применяется к следующим сообщениям этого чата.
        </small>
      </PopoverContent>
    </Popover>
  );
}
