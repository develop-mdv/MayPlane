'use client';
import { WorkspaceSelect } from './workspace-select';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  ChevronRight,
  Folder,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type { Server } from '@/lib/domain';
import type {
  AgentSession,
  Hub,
  HubProject,
  HubService,
  ServiceEvent,
  ServiceHealth,
  ServiceHttpStatus,
  ServiceLogs,
  ServiceStatus,
} from '@/lib/hub';
import { activeSession, providerNames } from '@/lib/hub';
import { allServiceMetrics } from '@/lib/service-customization.mjs';
import { serviceHasChat, serviceProjects } from '@/lib/service-workspace.mjs';
import { formatBytes } from '@/lib/machine-metrics.mjs';
import { useNow } from '@/lib/use-now';
import { CopyButton, ErrorText, Field } from './hub-ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ServiceDashboard } from './service-customization';
import {
  ServiceForm,
  serviceSourceLabel,
  serviceSourceNames,
} from './service-form';

const statuses: Record<ServiceStatus, string> = {
  running: 'Работает',
  stopped: 'Остановлен',
  failed: 'Ошибка',
  starting: 'Запускается',
  degraded: 'Часть экземпляров недоступна',
  missing: 'Источник не найден',
  unknown: 'Не проверено',
  unconfigured: 'Ручная карточка',
};
const healthLabels: Record<ServiceHealth, string> = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  starting: 'Запускается',
};
const httpLabels: Record<ServiceHttpStatus, string> = {
  ok: 'Отвечает',
  failed: 'Ошибка проверки',
  unknown: 'Не проверено',
};
const dateFormat = new Intl.DateTimeFormat('ru', {
  dateStyle: 'short',
  timeStyle: 'medium',
});
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 });

export type ServiceView = {
  machineId?: string;
  projectId?: string;
  serviceId?: string;
  create?: boolean;
};

function ServiceBadge({ service }: { service: HubService }) {
  const http = service.http?.status;
  const warning =
    service.health === 'unhealthy' ||
    http === 'failed' ||
    ['failed', 'missing', 'degraded'].includes(service.status);
  let label = statuses[service.status];
  if (service.status === 'unconfigured') {
    if (http) label = 'HTTP · ' + httpLabels[http].toLowerCase();
    else if (service.legacy) label = 'Нужна привязка';
  }
  if (service.status === 'running') {
    if (service.health === 'unhealthy') label = 'Healthcheck не пройден';
    else if (http === 'failed') label = 'HTTP недоступен';
    else if (service.unitState === 'exited') label = 'Активен (exited)';
  }
  return (
    <span
      className={
        'state-badge service-badge' +
        (warning
          ? ' service-badge-warning'
          : service.status === 'running' || http === 'ok'
            ? ' online'
            : '')
      }
    >
      {label}
    </span>
  );
}

export function ProjectServices({
  services,
  machines,
  onOpen,
  onAdd,
  onAll,
  disabled,
}: {
  services: HubService[];
  machines: Server[];
  onOpen: (id: string) => void;
  onAdd: () => void;
  onAll: () => void;
  disabled: boolean;
}) {
  return (
    <section
      className="service-related detail-card"
      aria-label="Сервисы проекта"
    >
      <div className="service-related-heading">
        <h2>
          <Boxes size={17} /> Сервисы{' '}
          <span className="heading-count">{services.length}</span>
        </h2>
        <button
          type="button"
          className="hub-button"
          disabled={disabled}
          onClick={onAdd}
        >
          <Plus size={15} /> Добавить сервис
        </button>
      </div>
      {services.length ? (
        <div className="service-related-list">
          {services.slice(0, 3).map((service) => (
            <button
              type="button"
              key={service.id}
              onClick={() => onOpen(service.id)}
            >
              <strong>{service.name}</strong>
              <small>
                {
                  machines.find((machine) => machine.id === service.machineId)
                    ?.name
                }
              </small>
              <ServiceBadge service={service} />
              <ChevronRight size={14} />
            </button>
          ))}
          {services.length > 3 && (
            <button type="button" className="text-button" onClick={onAll}>
              Все сервисы проекта <ChevronRight size={14} />
            </button>
          )}
        </div>
      ) : (
        <p className="hub-note">
          Добавьте приложение, бота или службу, связанную с проектом.
        </p>
      )}
    </section>
  );
}

function ServiceLogViewer({ service, hub }: { service: HubService; hub: Hub }) {
  const [result, setResult] = useState<ServiceLogs | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [sourceIndex, setSourceIndex] = useState(0);
  const sources = [service.source, ...(service.additionalSources || [])];
  const api = hub.api;
  useEffect(() => {
    let active = true;
    void api<ServiceLogs>(
      '/hub/services/' + service.id + '/logs/' + sourceIndex,
    )
      .then((data) => {
        if (active) setResult(data);
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, revision, service.id, sourceIndex]);
  const lines =
    result?.lines.filter(({ text, source }) =>
      (source + ' ' + text).toLowerCase().includes(query.trim().toLowerCase()),
    ) || [];
  return (
    <section className="detail-card service-logs" aria-label="Логи сервиса">
      <div className="service-log-header">
        {sources.length > 1 && (
          <Field label="Компонент">
            <WorkspaceSelect
              aria-label="Компонент"
              value={String(sourceIndex)}
              onValueChange={(choice) => {
                setBusy(true);
                setError('');
                setResult(null);
                setSourceIndex(Number(choice));
              }}
              options={sources.map((source, index) => ({
                value: String(index),
                label: serviceSourceLabel(source),
              }))}
            />
          </Field>
        )}
        <Field label="Поиск по последним 200 строкам">
          <input
            type="search"
            value={query}
            placeholder="Текст или имя источника"
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className="hub-button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            setRevision((n) => n + 1);
          }}
        >
          <RefreshCw size={14} className={busy ? 'spin' : undefined} /> Обновить
          логи
        </button>
        {!!lines.length && (
          <CopyButton
            value={lines
              .map((line) =>
                [line.at, line.source, line.text].filter(Boolean).join(' '),
              )
              .join('\n')}
            label="Скопировать показанные строки"
          />
        )}
      </div>
      <ErrorText error={error} />
      {result?.warning && <p className="hub-note">{result.warning}</p>}
      {lines.length ? (
        <pre className="service-log-output" aria-label="Вывод журнала">
          {lines.map((line, index) => (
            <span className="service-log-line" key={index}>
              {line.at && (
                <time dateTime={line.at}>
                  {dateFormat.format(new Date(line.at))}
                </time>
              )}
              <span className="service-log-source">{line.source}</span>
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : (
        !error && (
          <p className="hub-note">
            {busy
              ? 'Читаем журнал…'
              : query
                ? 'Совпадений нет.'
                : 'Журнал сервиса пуст.'}
          </p>
        )
      )}
    </section>
  );
}

function runningFor(startedAt: string, now: number) {
  const minutes = Math.max(
    0,
    Math.floor((now - Date.parse(startedAt)) / 60000),
  );
  if (minutes < 1) return 'Меньше минуты';
  if (minutes < 60) return minutes + ' мин';
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? hours + ' ч ' + (minutes % 60) + ' мин'
    : Math.floor(hours / 24) + ' д ' + (hours % 24) + ' ч';
}

function ServiceWorkspaceLinks({ projects, chats, onProject, onChat }: {
  projects: HubProject[];
  chats: AgentSession[];
  onProject: (id: string) => void;
  onChat: (session: AgentSession) => void;
}) {
  return (
    <div className="service-details-grid">
      <section className="detail-card service-detail-card">
        <h2>Проекты</h2>
        {projects.length ? (
          <div className="service-related-list">
            {projects.map((project) => (
              <button key={project.id} type="button" onClick={() => onProject(project.id)}>
                <Folder size={15} /> <strong>{project.name}</strong>
                <small>{project.path}</small> <ArrowUpRight size={13} />
              </button>
            ))}
          </div>
        ) : <p className="hub-note">В каталоге сервиса пока нет проекта.</p>}
      </section>
      <section className="detail-card service-detail-card">
        <h2>Чаты</h2>
        {chats.length ? (
          <div className="service-related-list">
            {chats.map((chat) => (
              <button key={chat.id} type="button" onClick={() => onChat(chat)}>
                <MessageSquare size={15} /> <strong>{chat.title}</strong>
                <small>{providerNames[chat.provider]}{chat.archived ? ' · Архив' : ''}</small>
                <ArrowUpRight size={13} />
              </button>
            ))}
          </div>
        ) : <p className="hub-note">Создайте чат для работы с этим сервисом.</p>}
      </section>
    </div>
  );
}

function ServiceExtraDetails({ service, canCustomize, onCustomize }: {
  service: HubService;
  canCustomize: boolean;
  onCustomize: () => void;
}) {
  const { customization } = service;
  const hasMetrics = allServiceMetrics(customization).length > 0;
  const hasWidgets = hasMetrics || !!customization?.fields.length || !!customization?.sections?.length;
  return (
    <section className="detail-card service-detail-card service-extra-details">
      <div className="service-related-heading">
        <h2>Поля и метрики</h2>
        <button type="button" className="hub-button" disabled={!canCustomize} onClick={onCustomize}>
          <Settings2 size={15} /> Настроить в чате
        </button>
      </div>
      {!hasWidgets && (
        <p className="hub-note">Добавьте сведения и показатели, которые нужны этому приложению.</p>
      )}
      {hasWidgets && <ServiceDashboard configuration={customization} values={service.customMetricValues} />}
      {hasMetrics && (customization?.metricsMachineId !== service.machineId ? (
        <p className="hub-note">Обновите источник метрик после смены машины.</p>
      ) : service.customMetricError && <p className="hub-note">{service.customMetricError}</p>)}
    </section>
  );
}

function ServiceDetails({
  service,
  machine,
  projects,
  chats,
  hub,
  connected,
  onBack,
  onEdit,
  onRemove,
  onMachine,
  onProject,
  onOpenChat,
  onNewChat,
}: {
  service: HubService;
  machine?: Server;
  projects: HubProject[];
  chats: AgentSession[];
  hub: Hub;
  connected: boolean;
  onBack: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onMachine: () => void;
  onProject: (id: string) => void;
  onOpenChat: (session: AgentSession, customizeServiceId?: string) => void;
  onNewChat: (customize?: boolean) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'logs' | 'workspace'>('overview');
  const [history, setHistory] = useState<ServiceEvent[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow();
  const api = hub.api;
  const automatic = service.source.type !== 'manual';
  const hasChecks = automatic || !!service.healthUrl || !!service.customization?.metrics.length;
  const workspaceAvailable = !!hub.data.capabilities?.serviceWorkspace;
  const grouped = !!service.additionalSources?.length;
  const { id, attemptedAt, checkedAt } = service;
  const lastFailedAttempt =
    attemptedAt && (!checkedAt || attemptedAt > checkedAt) ? attemptedAt : null;
  useEffect(() => {
    if (tab !== 'overview') return;
    let active = true;
    void api<{ history: ServiceEvent[] }>('/hub/services/' + id)
      .then(({ history }) => {
        if (active) setHistory(history);
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [api, attemptedAt, id, tab]);
  const refresh = async () => {
    setError('');
    setRefreshing(true);
    try {
      await hub.mutate('/services/refresh', {
        machineId: service.machineId,
        wait: true,
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const metrics = [
    {
      label: 'Время работы',
      value: service.startedAt ? runningFor(service.startedAt, now) : null,
    },
    {
      label: 'Перезапуски',
      value: service.restarts != null ? number.format(service.restarts) : null,
    },
    {
      label: 'CPU',
      value:
        service.cpuCores != null
          ? number.format(service.cpuCores) + ' vCPU'
          : null,
    },
    {
      label: 'Память',
      value:
        service.memoryBytes != null ? formatBytes(service.memoryBytes) : null,
    },
  ].filter((metric) => metric.value != null);
  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        <ArrowLeft size={15} /> К списку сервисов
      </button>
      <div className="page-heading service-detail-heading">
        <div>
          <div className="title-with-status">
            <h1>{service.name}</h1>
            <ServiceBadge service={service} />
          </div>
          {service.description && <p>{service.description}</p>}
        </div>
        <div className="heading-actions">
          {workspaceAvailable && (
            <button type="button" className="hub-button primary" disabled={!connected} onClick={() => onNewChat()}>
              <MessageSquare size={15} /> Новый чат
            </button>
          )}
          {service.url && (
            <a
              className="hub-button"
              href={service.url}
              target="_blank"
              rel="noreferrer"
            >
              Открыть приложение <ArrowUpRight size={14} />
            </a>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger className="hub-button" aria-label="Действия с сервисом">
              <MoreHorizontal size={16} /> Действия
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="workspace-menu">
              <DropdownMenuItem onClick={onEdit}><Pencil />Редактировать</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onRemove}><Trash2 />Убрать из списка</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <fieldset className="service-tabs" aria-label="Раздел карточки">
        <button
          type="button"
          className="hub-button"
          aria-pressed={tab === 'overview'}
          onClick={() => setTab('overview')}
        >
          Обзор
        </button>
        <button
          type="button"
          className="hub-button"
          aria-pressed={tab === 'logs'}
          disabled={!automatic}
          onClick={() => setTab('logs')}
        >
          Логи
        </button>
        {workspaceAvailable && (
          <button type="button" className="hub-button" aria-pressed={tab === 'workspace'} onClick={() => setTab('workspace')}>
            Чаты и проекты
          </button>
        )}
      </fieldset>
      {tab === 'workspace' && workspaceAvailable ? (
        <ServiceWorkspaceLinks projects={projects} chats={chats} onProject={onProject} onChat={onOpenChat} />
      ) : tab === 'logs' && automatic ? (
        <ServiceLogViewer
          key={JSON.stringify([service.source, service.additionalSources])}
          service={service}
          hub={hub}
        />
      ) : (
        <div className="service-details-grid">
          <section className="detail-card service-detail-card">
            <h2>Расположение</h2>
            <dl className="service-details">
              <div>
                <dt>Машина</dt>
                <dd>
                  {machine ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={onMachine}
                    >
                      {machine.name} <ArrowUpRight size={12} />
                    </button>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>Проект</dt>
                <dd className="service-project-links">
                  {projects.length ? projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="text-button"
                      onClick={() => onProject(project.id)}
                    >
                      {project.name} <ArrowUpRight size={12} />
                    </button>
                  )) : (
                    'Без проекта'
                  )}
                </dd>
              </div>
              {service.environment && (
                <div>
                  <dt>Окружение</dt>
                  <dd>{service.environment}</dd>
                </div>
              )}
              {!grouped && (
                <div>
                  <dt>Источник</dt>
                  <dd>
                    {serviceSourceNames[service.source.type]}
                    {automatic && (
                      <>
                        {' '}
                        · <code>{serviceSourceLabel(service.source)}</code>
                      </>
                    )}
                  </dd>
                </div>
              )}
              {service.directory && (
                <div>
                  <dt>Каталог</dt>
                  <dd>
                    <code>{service.directory}</code>{' '}
                    <CopyButton
                      value={service.directory}
                      label="Скопировать каталог сервиса"
                    />
                  </dd>
                </div>
              )}
              {service.url && (
                <div>
                  <dt>Адрес</dt>
                  <dd>
                    <a href={service.url} target="_blank" rel="noreferrer">
                      {service.url}
                    </a>
                  </dd>
                </div>
              )}
              {service.repo && (
                <div>
                  <dt>Репозиторий</dt>
                  <dd>
                    <a href={service.repo} target="_blank" rel="noreferrer">
                      {service.repo}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
            {service.notes && (
              <div className="service-notes">
                <h3>Заметки</h3>
                <p>{service.notes}</p>
              </div>
            )}
          </section>
          <section className="detail-card service-detail-card">
            <div className="service-related-heading">
              <h2>Состояние</h2>
              {hasChecks && (
                <button
                  type="button"
                  className="hub-button"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                >
                  <RefreshCw
                    size={14}
                    className={
                      refreshing ? 'motion-safe:animate-spin' : undefined
                    }
                  />{' '}
                  Проверить
                </button>
              )}
            </div>
            {service.error && <p className="hub-note">{service.error}</p>}
            {service.metricsError && (
              <p className="hub-note">{service.metricsError}</p>
            )}
            <output className="hub-note">
              {refreshing
                ? 'Проверяем состояние и метрики…'
                : lastFailedAttempt
                  ? 'Последняя попытка · ' +
                    dateFormat.format(new Date(lastFailedAttempt))
                  : checkedAt
                    ? 'Последняя успешная проверка · ' +
                      dateFormat.format(new Date(checkedAt))
                    : hasChecks
                      ? 'Ожидает проверки'
                      : 'Укажите источник в настройках карточки, чтобы видеть состояние и логи.'}
            </output>
            {lastFailedAttempt && checkedAt && (
              <p className="hub-note">
                Последняя успешная проверка ·{' '}
                {dateFormat.format(new Date(checkedAt))}
              </p>
            )}
            {!!metrics.length && (
              <dl className="service-metrics">
                {metrics.map(({ label, value }) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <dl className="service-details">
              {service.instances && (
                <div>
                  <dt>Контейнеры</dt>
                  <dd>
                    {service.instances.running} из {service.instances.found}{' '}
                    найденных запущены
                  </dd>
                </div>
              )}
              {service.health && (
                <div>
                  <dt>Docker healthcheck</dt>
                  <dd>{healthLabels[service.health]}</dd>
                </div>
              )}
              {service.healthUrl && (
                <div>
                  <dt>HTTP</dt>
                  <dd>
                    {httpLabels[service.http?.status || 'unknown']}
                    {service.http?.code ? ' · ' + service.http.code : ''}
                    <br />
                    <code>{service.healthUrl}</code>
                  </dd>
                </div>
              )}
            </dl>
            {grouped && (
              <div className="service-history service-component-status">
                <h3>Компоненты</h3>
                <ul>
                  {[service.source, ...(service.additionalSources || [])].map(
                    (source) => {
                      const key = JSON.stringify(source);
                      const component = service.components?.find(
                        (entry) => JSON.stringify(entry.source) === key,
                      );
                      const usage = [
                        component?.cpuCores != null
                          ? number.format(component.cpuCores) + ' vCPU'
                          : '',
                        component?.memoryBytes != null
                          ? formatBytes(component.memoryBytes)
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <li key={key}>
                          <code>{serviceSourceLabel(source)}</code>
                          <span>
                            {statuses[component?.status || 'unknown']}
                            {component?.health &&
                              ' · ' + healthLabels[component.health]}
                          </span>
                          {component?.error && <small>{component.error}</small>}
                          {usage && <small>{usage}</small>}
                          {component?.metricsError && (
                            <small>{component.metricsError}</small>
                          )}
                        </li>
                      );
                    },
                  )}
                </ul>
              </div>
            )}
            {!!history.length && (
              <div className="service-history">
                <h3>Изменения состояния</h3>
                <ul>
                  {[...history]
                    .reverse()
                    .slice(0, 10)
                    .map((event) => (
                      <li key={event.at}>
                        <time dateTime={event.at}>
                          {dateFormat.format(new Date(event.at))}
                        </time>
                        <span>
                          {event.status !== 'unconfigured'
                            ? statuses[event.status]
                            : 'Проверка HTTP'}
                          {event.health && ' · ' + healthLabels[event.health]}
                          {event.http && ' · ' + httpLabels[event.http]}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <ErrorText error={error} />
          </section>
          {workspaceAvailable && (
            <ServiceExtraDetails service={service} canCustomize={connected} onCustomize={() => {
              const available = chats.filter((chat) => !chat.archived && !activeSession(chat));
              const chat = available.find((entry) => entry.serviceId === service.id) || available[0];
              if (chat) onOpenChat(chat, service.id);
              else onNewChat(true);
            }} />
          )}
        </div>
      )}
    </>
  );
}

export function ServicesPanel({
  hub,
  machines,
  scope,
  onRemove,
  onProject,
  onMachines,
  onMachine,
  onOpenChat,
  onNewChat,
  connected,
}: {
  hub: Hub;
  machines: Server[];
  scope: ServiceView;
  onRemove: (service: HubService) => void;
  onProject: (id: string) => void;
  onMachines: () => void;
  onMachine: (id: string) => void;
  onOpenChat: (session: AgentSession, customizeServiceId?: string) => void;
  onNewChat: (service: HubService, customize?: boolean) => void;
  connected: boolean;
}) {
  const { services, projects } = hub.data;
  const pageRef = useRef<HTMLDivElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [machineFilter, setMachineFilter] = useState(scope.machineId || '');
  const [projectFilter, setProjectFilter] = useState(scope.projectId || '');
  const [statusFilter, setStatusFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(scope.serviceId || '');
  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);
  const [edit, setEdit] = useState<HubService | 'new' | null>(
    scope.create ? 'new' : null,
  );
  const service = services.find((item) => item.id === selectedId);
  const machine = machines.find((item) => item.id === service?.machineId);
  const projectLinks = new Map<string, HubProject[]>(
    services.map((item) => [
      item.id,
      serviceProjects(
        item,
        projects,
        machines.find((machine) => machine.id === item.machineId)?.platform,
      ),
    ]),
  );
  const filtered = services.filter(
    (item) =>
      (!machineFilter || item.machineId === machineFilter) &&
      (!projectFilter ||
        (projectFilter === 'none'
          ? !projectLinks.get(item.id)?.length
          : projectLinks
              .get(item.id)
              ?.some((project) => project.id === projectFilter))) &&
      (!statusFilter || item.status === statusFilter) &&
      (
        item.name +
        ' ' +
        item.description +
        ' ' +
        item.environment +
        ' ' +
        serviceSourceLabel(item.source)
      )
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const filterCount = [machineFilter, projectFilter, statusFilter].filter(
    Boolean,
  ).length;
  function clearFilters() {
    setQuery('');
    setMachineFilter('');
    setProjectFilter('');
    setStatusFilter('');
  }
  const closeForm = useCallback(() => setEdit(null), []);
  const addServiceButton = (
    <button
      type="button"
      className="hub-button primary"
      disabled={!connected || !machines.length}
      onClick={() => setEdit('new')}
    >
      <Plus size={17} /> Добавить сервис
    </button>
  );
  return (
    <div className="hub-page services-page" ref={pageRef}>
      {service ? (
        <ServiceDetails
          key={service.id}
          service={service}
          machine={machine}
          projects={projectLinks.get(service.id) || []}
          chats={hub.data.sessions.filter((chat) =>
            serviceHasChat(service, chat, projects, machine?.platform),
          )}
          hub={hub}
          connected={connected}
          onBack={() => setSelectedId('')}
          onEdit={() => setEdit(service)}
          onRemove={() => onRemove(service)}
          onMachine={() => onMachine(service.machineId)}
          onProject={onProject}
          onOpenChat={onOpenChat}
          onNewChat={(customize) => onNewChat(service, customize)}
        />
      ) : (
        <>
          <div className="page-heading">
            <div>
              <h1>
                Сервисы <span className="heading-count">{filtered.length}</span>
              </h1>
            </div>
            {services.length > 0 && addServiceButton}
          </div>
          {!!services.length && (
            <div className="service-filters" data-expanded={filtersOpen}>
              <Field label="Поиск">
                <input
                  type="search"
                  value={query}
                  placeholder="Найти сервис"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </Field>
              <button
                type="button"
                className="hub-button service-filter-toggle"
                aria-expanded={filtersOpen}
                aria-controls="service-filter-options"
                onClick={() => setFiltersOpen(!filtersOpen)}
              >
                <SlidersHorizontal size={16} /> Фильтры
                {filterCount > 0 && ` · ${filterCount}`}
              </button>
              <div
                className="service-filter-options"
                id="service-filter-options"
              >
                <Field label="Проект">
                  <WorkspaceSelect
                    aria-label="Проект"
                    value={projectFilter}
                    onValueChange={setProjectFilter}
                    options={[
                      { value: '', label: 'Все проекты' },
                      { value: 'none', label: 'Без проекта' },
                      ...projects.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                  />
                </Field>
                <Field label="Машина">
                  <WorkspaceSelect
                    aria-label="Машина"
                    value={machineFilter}
                    onValueChange={setMachineFilter}
                    options={[
                      { value: '', label: 'Все машины' },
                      ...machines.map((m) => ({ value: m.id, label: m.name })),
                    ]}
                  />
                </Field>
                <Field label="Состояние">
                  <WorkspaceSelect
                    aria-label="Состояние"
                    value={statusFilter}
                    onValueChange={setStatusFilter}
                    options={[
                      { value: '', label: 'Любое' },
                      ...Object.entries(statuses).map(([value, label]) => ({
                        value,
                        label,
                      })),
                    ]}
                  />
                </Field>
              </div>
              {(query || filterCount > 0) && (
                <button
                  type="button"
                  className="text-button reset-filters"
                  onClick={clearFilters}
                >
                  Сбросить фильтры
                </button>
              )}
            </div>
          )}
          {filtered.length ? (
            <div className="service-list">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="service-list-item"
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="project-icon">
                    <Boxes size={19} />
                  </span>
                  <span className="service-list-name">
                    <strong>
                      {item.name}
                      {item.environment && <small>{item.environment}</small>}
                    </strong>
                    {item.description && <span>{item.description}</span>}
                  </span>
                  <span className="service-list-context">
                    <span>
                      <Monitor size={13} />{' '}
                      {machines.find((machine) => machine.id === item.machineId)
                        ?.name || 'Машина'}
                    </span>
                    {!!projectLinks.get(item.id)?.length && (
                      <span>
                        <Folder size={13} />{' '}
                        {projectLinks.get(item.id)?.[0].name}
                      </span>
                    )}
                  </span>
                  <ServiceBadge service={item} />
                  <ChevronRight className="service-list-arrow" size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">
                <Boxes size={27} />
              </span>
              <h2>
                {services.length ? 'Сервисы не найдены' : 'Пока нет сервисов'}
              </h2>
              <p>
                {!machines.length
                  ? 'Подключите машину в разделе «Серверы».'
                  : services.length
                    ? 'Попробуйте другое название или сбросьте фильтры.'
                    : 'Добавьте карточку вручную или найдите приложение на сервере.'}
              </p>
              {!machines.length ? (
                <button
                  className="hub-button primary"
                  type="button"
                  onClick={onMachines}
                >
                  К серверам <ChevronRight size={15} />
                </button>
              ) : (
                services.length === 0 && addServiceButton
              )}
            </div>
          )}
        </>
      )}
      {edit && (
        <ServiceForm
          hub={hub}
          machines={machines}
          projects={projects}
          service={edit === 'new' ? undefined : edit}
          machineId={machineFilter || undefined}
          projectId={
            projectFilter && projectFilter !== 'none'
              ? projectFilter
              : undefined
          }
          onClose={closeForm}
          onSaved={(saved) => {
            setSelectedId(saved.id);
            closeForm();
          }}
        />
      )}
    </div>
  );
}
