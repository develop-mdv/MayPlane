'use client';

import { useEffect, useState, type SubmitEvent } from 'react';
import { LoaderCircle, Plus, Search, Sparkles, X } from 'lucide-react';
import type { Server } from '@/lib/domain';
import type {
  Hub,
  HubProject,
  HubService,
  ServiceCandidate,
  ServiceDraft,
  ServiceFields,
  ServiceSource,
} from '@/lib/hub';
import { ErrorText, Field, Modal, Submit } from './hub-ui';

export const serviceSourceNames: Record<ServiceSource['type'], string> = {
  manual: 'Ручная карточка',
  docker: 'Docker',
  compose: 'Docker Compose',
  systemd: 'systemd',
};

export function serviceSourceLabel(source: ServiceSource) {
  if (source.type === 'compose') return source.stack + ' / ' + source.component;
  if (source.type === 'docker') return source.container;
  if (source.type === 'systemd') return source.unit;
  return serviceSourceNames.manual;
}

const blankSources: Record<ServiceSource['type'], ServiceSource> = {
  manual: { type: 'manual' },
  docker: { type: 'docker', container: '' },
  compose: { type: 'compose', stack: '', component: '' },
  systemd: { type: 'systemd', unit: '' },
};

function sourceReady(source: ServiceSource) {
  if (source.type === 'docker') return !!source.container.trim();
  if (source.type === 'compose')
    return !!source.stack.trim() && !!source.component.trim();
  if (source.type === 'systemd') return !!source.unit.trim();
  return true;
}

type Discovery = {
  candidates: ServiceCandidate[];
  warnings: Partial<Record<'docker' | 'systemd', string>>;
};

export function ServiceForm({
  hub,
  machines,
  projects,
  service,
  machineId,
  projectId,
  onClose,
  onSaved,
}: {
  hub: Hub;
  machines: Server[];
  projects: HubProject[];
  service?: HubService;
  machineId?: string;
  projectId?: string;
  onClose: () => void;
  onSaved: (service: HubService) => void;
}) {
  const [form, setForm] = useState<ServiceFields>(() => ({
    name: service?.name || '',
    description: service?.description || '',
    environment: service?.environment || '',
    directory: service?.directory || '',
    url: service?.url || '',
    repo: service?.repo || '',
    healthUrl: service?.healthUrl || '',
    notes: service?.notes || '',
    source: service?.source || blankSources.manual,
    additionalSources: service?.additionalSources || [],
    machineId:
      service?.machineId ||
      machineId ||
      projects.find((p) => p.id === projectId)?.machineId ||
      machines[0]?.id ||
      '',
    projectId: service ? service.projectId : projectId || null,
  }));
  const [busy, setBusy] = useState<
    'saving' | 'discovering' | 'starting' | null
  >(null);
  const [discovery, setDiscovery] = useState<
    (Discovery & { for: 'primary' | 'additional' }) | null
  >(null);
  const [resultQuery, setResultQuery] = useState('');
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState('');
  const [feedback, setFeedback] = useState('');
  const [warning, setWarning] = useState('');
  const { api, mutate } = hub;
  const machine = machines.find((m) => m.id === form.machineId);
  const automatic = !!machine && machine.transport !== 'connector';
  const linux = (machine?.platform || 'linux') === 'linux';
  const source = form.source;
  const additionalSources = form.additionalSources || [];
  const locked = !!busy || !!jobId;
  const canDraft =
    !!machine &&
    sourceReady(source) &&
    (source.type !== 'manual' || !!(form.name.trim() || form.directory.trim()));
  const visibleCandidates = discovery?.candidates.filter((candidate) =>
    (serviceSourceLabel(candidate.source) + ' ' + candidate.description)
      .toLowerCase()
      .includes(resultQuery.trim().toLowerCase()),
  );

  useEffect(() => {
    if (!jobId) return;
    const path = '/hub/services/drafts/' + jobId;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const draft = await api<ServiceDraft>(path);
        if (!active) return;
        if (draft.status === 'ready' && draft.suggestion) {
          const fields = draft.suggestion;
          setForm((previous) => ({
            ...previous,
            name: fields.name || previous.name,
            description: fields.description || previous.description,
            environment: previous.environment || fields.environment,
            notes: previous.notes || fields.notes,
            directory: previous.directory || fields.directory,
            projectId: previous.projectId || fields.projectId || null,
          }));
          setWarning(draft.warning || '');
          setFeedback('Черновик заполнен. Проверьте поля перед сохранением.');
          setJobId('');
        } else if (draft.status === 'failed') {
          setError(draft.error || 'Не удалось оформить сервис.');
          setFeedback('');
          setJobId('');
        } else {
          setFeedback(
            draft.status === 'collecting'
              ? 'Собираем сведения на машине…'
              : 'Codex на хосте панели заполняет карточку…',
          );
          timer = setTimeout(() => void poll(), 1100);
        }
      } catch (reason) {
        if (!active) return;
        setError((reason as Error).message);
        setFeedback('');
        setJobId('');
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      void api(path, 'DELETE', {}).catch(() => {});
    };
  }, [api, jobId]);

  function field<K extends keyof ServiceFields>(
    key: K,
    value: ServiceFields[K],
  ) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  async function discover(target: 'primary' | 'additional' = 'primary') {
    setBusy('discovering');
    setError('');
    setResultQuery('');
    try {
      setDiscovery({
        ...(await api<Discovery>('/hub/services/discover', 'POST', {
          machineId: form.machineId,
        })),
        for: target,
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function selectSource(candidate: ServiceCandidate) {
    if (discovery?.for === 'additional') {
      field('additionalSources', [...additionalSources, candidate.source]);
      if (additionalSources.length >= 6) setDiscovery(null);
      return;
    }
    const changed =
      JSON.stringify(form.source) !== JSON.stringify(candidate.source);
    setForm({
      ...form,
      name: service && form.name ? form.name : candidate.name.slice(0, 100),
      directory:
        candidate.directory ||
        (form.source.type === 'manual' || !changed ? form.directory : ''),
      description:
        service && form.description ? form.description : candidate.description,
      healthUrl: changed && form.source.type !== 'manual' ? '' : form.healthUrl,
      source: candidate.source,
    });
    setDiscovery(null);
    setFeedback('');
    setWarning('');
  }

  async function draft() {
    setBusy('starting');
    setError('');
    setWarning('');
    setFeedback('Собираем сведения на машине…');
    setDiscovery(null);
    try {
      const { id } = await api<{ id: string }>(
        '/hub/services/drafts',
        'POST',
        form,
      );
      setJobId(id);
    } catch (reason) {
      setFeedback('');
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    setBusy('saving');
    setError('');
    try {
      onSaved(
        await mutate<HubService>(
          service ? '/services/' + service.id : '/services',
          form,
          service ? 'PATCH' : 'POST',
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title={service ? 'Редактировать сервис' : 'Добавить сервис'}
      description="Карточка приложения, бота или службы на подключённой машине."
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form
        className="hub-form service-form"
        onSubmit={(event) => void save(event)}
      >
        <fieldset className="service-form-fields" disabled={locked}>
          <div className="form-grid">
            <Field label="Машина">
              <select
                value={form.machineId}
                disabled={service?.legacy}
                required
                onChange={(event) => {
                  setDiscovery(null);
                  setWarning('');
                  setFeedback('');
                  setForm({
                    ...form,
                    machineId: event.target.value,
                    directory: '',
                    healthUrl: '',
                    source: blankSources.manual,
                    additionalSources: [],
                  });
                }}
              >
                <option value="">Выберите машину</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Проект">
              <select
                value={form.projectId || ''}
                onChange={(event) =>
                  field('projectId', event.target.value || null)
                }
              >
                <option value="">Без проекта</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} ·{' '}
                    {machines.find((m) => m.id === project.machineId)?.name ||
                      'рабочая папка'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="service-source-fields">
            <Field label="Источник состояния и логов">
              <select
                value={source.type}
                onChange={(event) => {
                  const source =
                    blankSources[event.target.value as ServiceSource['type']];
                  setDiscovery(null);
                  setForm({
                    ...form,
                    source,
                    additionalSources:
                      source.type === 'manual' ? [] : additionalSources,
                  });
                }}
              >
                {Object.entries(serviceSourceNames).map(([value, label]) => (
                  <option
                    key={value}
                    value={value}
                    disabled={
                      value !== 'manual' &&
                      (!automatic || (value === 'systemd' && !linux))
                    }
                  >
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <button
              type="button"
              className="hub-button"
              disabled={!automatic}
              onClick={() => void discover()}
            >
              {busy === 'discovering' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Search size={15} />
              )}
              Найти на сервере
            </button>
          </div>
          {source.type === 'docker' && (
            <Field label="Имя контейнера">
              <input
                value={source.container}
                required
                maxLength={180}
                onChange={(event) =>
                  field('source', { ...source, container: event.target.value })
                }
              />
            </Field>
          )}
          {source.type === 'compose' && (
            <div className="form-grid">
              <Field label="Проект Compose">
                <input
                  value={source.stack}
                  required
                  maxLength={180}
                  onChange={(event) =>
                    field('source', { ...source, stack: event.target.value })
                  }
                />
              </Field>
              <Field label="Сервис в Compose">
                <input
                  value={source.component}
                  required
                  maxLength={180}
                  onChange={(event) =>
                    field('source', {
                      ...source,
                      component: event.target.value,
                    })
                  }
                />
              </Field>
            </div>
          )}
          {source.type === 'systemd' && (
            <Field label="Имя службы systemd">
              <input
                value={source.unit}
                placeholder="app.service"
                required
                maxLength={248}
                onChange={(event) =>
                  field('source', { ...source, unit: event.target.value })
                }
              />
            </Field>
          )}
          {source.type !== 'manual' && (
            <div className="service-extra-sources">
              {additionalSources.map((entry) => (
                <div key={JSON.stringify(entry)}>
                  <code>{serviceSourceLabel(entry)}</code>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={'Убрать компонент ' + serviceSourceLabel(entry)}
                    onClick={() =>
                      field(
                        'additionalSources',
                        additionalSources.filter((item) => item !== entry),
                      )
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="hub-button"
                disabled={
                  !automatic ||
                  !sourceReady(source) ||
                  additionalSources.length >= 7
                }
                onClick={() => void discover('additional')}
              >
                <Plus size={14} /> Добавить компонент
              </button>
            </div>
          )}
          {discovery && (
            <section
              className="service-discovery"
              aria-label="Найденные сервисы"
            >
              {Object.entries(discovery.warnings).map(([kind, message]) => (
                <p className="hub-note" key={kind}>
                  {serviceSourceNames[kind as 'docker' | 'systemd']} · {message}
                </p>
              ))}
              {!!discovery.candidates.length && (
                <Field label="Поиск по найденным">
                  <input
                    value={resultQuery}
                    onChange={(event) => setResultQuery(event.target.value)}
                    type="search"
                  />
                </Field>
              )}
              <div className="service-discovery-results">
                {visibleCandidates?.map((candidate) => {
                  const linked =
                    !!candidate.serviceId &&
                    candidate.serviceId !== service?.id;
                  const added = (
                    discovery.for === 'additional'
                      ? [source, ...additionalSources]
                      : additionalSources
                  ).some(
                    (entry) =>
                      JSON.stringify(entry) ===
                      JSON.stringify(candidate.source),
                  );
                  return (
                    <button
                      key={JSON.stringify(candidate.source)}
                      type="button"
                      className="service-discovery-item"
                      disabled={linked || added}
                      onClick={() => selectSource(candidate)}
                    >
                      <strong>{serviceSourceLabel(candidate.source)}</strong>
                      <small>
                        {serviceSourceNames[candidate.source.type]} ·{' '}
                        {added
                          ? 'В карточке'
                          : linked
                            ? 'Уже добавлен'
                            : candidate.status === 'running'
                              ? 'Запущен'
                              : 'Найден'}
                      </small>
                    </button>
                  );
                })}
                {!visibleCandidates?.length && (
                  <p className="hub-note">Подходящие сервисы не найдены.</p>
                )}
              </div>
              {discovery.for === 'additional' && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setDiscovery(null)}
                >
                  Готово
                </button>
              )}
            </section>
          )}
        </fieldset>
        <div className="service-draft">
          <div>
            <output className="hub-note">
              {feedback ||
                'Codex на хосте панели заполнит черновик по сведениям о сервисе.'}
            </output>
            {warning && <p className="hub-note">{warning}</p>}
          </div>
          {jobId ? (
            <button
              type="button"
              className="hub-button"
              onClick={() => {
                setJobId('');
                setFeedback('Оформление отменено.');
              }}
            >
              Отменить оформление
            </button>
          ) : (
            <button
              type="button"
              className="hub-button"
              disabled={!canDraft || locked}
              onClick={() => void draft()}
            >
              {busy === 'starting' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Sparkles size={15} />
              )}
              Оформить сервис
            </button>
          )}
        </div>
        <ErrorText error={busy === 'saving' ? '' : error} />
        <fieldset className="service-form-fields" disabled={locked}>
          <div className="form-grid">
            <Field label="Название">
              <input
                value={form.name}
                required
                maxLength={100}
                onChange={(event) => field('name', event.target.value)}
              />
            </Field>
            <Field label="Окружение">
              <input
                value={form.environment}
                maxLength={40}
                placeholder="prod, test"
                onChange={(event) => field('environment', event.target.value)}
              />
            </Field>
          </div>
          <Field label="Описание">
            <textarea
              rows={2}
              maxLength={500}
              value={form.description}
              onChange={(event) => field('description', event.target.value)}
            />
          </Field>
          <div className="form-grid">
            <Field label="Каталог запуска">
              <input
                value={form.directory}
                maxLength={1024}
                placeholder={
                  machine?.platform === 'win32' ? 'C:\\Apps\\app' : '/srv/app'
                }
                onChange={(event) => field('directory', event.target.value)}
              />
            </Field>
            <Field label="Адрес приложения">
              <input
                type="url"
                value={form.url}
                maxLength={1000}
                placeholder="https://app.example.com"
                onChange={(event) => field('url', event.target.value)}
              />
            </Field>
          </div>
          <Field label="Репозиторий">
            <input
              type="url"
              maxLength={1000}
              value={form.repo || ''}
              placeholder="https://github.com/owner/repo"
              onChange={(event) => field('repo', event.target.value)}
            />
          </Field>
          <Field
            label="Заметки"
            hint="Например, где конфиг и что проверить после обновления."
          >
            <textarea
              rows={3}
              maxLength={6000}
              value={form.notes}
              onChange={(event) => field('notes', event.target.value)}
            />
          </Field>
          {automatic && (
            <Field
              label="HTTP-проверка"
              hint="Необязательно. Панель проверяет адрес на самой машине сервиса."
            >
              <input
                type="url"
                value={form.healthUrl}
                maxLength={1000}
                placeholder="http://127.0.0.1:8080/health"
                onChange={(event) => field('healthUrl', event.target.value)}
              />
            </Field>
          )}
        </fieldset>
        <div className="form-actions">
          <button
            type="button"
            className="hub-button"
            onClick={onClose}
            disabled={!!busy}
          >
            Отмена
          </button>
          <Submit
            busy={busy === 'saving'}
            disabled={
              locked || !machine || !sourceReady(source) || !form.name.trim()
            }
          >
            Сохранить сервис
          </Submit>
        </div>
      </form>
    </Modal>
  );
}
