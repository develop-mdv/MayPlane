'use client';
import { useState } from 'react';
import {
  ArrowRight,
  ArrowDownUp,
  Archive,
  Check,
  CircleHelp,
  Hand,
  Server,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  Project,
  Job,
  Server as ServerRecord,
  MigrationPlan,
} from '@/lib/domain';
import { pendingMigrations } from '@/lib/migration-flow.mjs';

export function MigrationQueue({
  projects,
  servers,
  jobs,
  onContinue,
  onLogs,
}: {
  projects: Project[];
  servers: ServerRecord[];
  jobs: Job[];
  onContinue: (id: string) => void;
  onLogs: (job: Job) => void;
}) {
  const items = pendingMigrations(projects, jobs) as {
    projectId: string;
    sourceId: string;
    targetId: string;
    state: string;
    label: string;
    jobId?: string;
    updatedAt: string;
    mode: string;
  }[];
  const serverName = (id: string) =>
    servers.find((s) => s.id === id)?.name || 'Сервер недоступен';
  return (
    <section className="migration-queue" aria-label="Незавершённые переносы">
      <div className="section-heading">
        <h2>
          Незавершённые переносы{' '}
          <span className="migration-count">{items.length}</span>
        </h2>
      </div>
      {items.length ? (
        <div className="migration-queue-grid">
          {items.map((item) => {
            const project = projects.find((p) => p.id === item.projectId)!;
            const job = jobs.find((j) => j.id === item.jobId);
            return (
              <article className="migration-resume-card" key={item.projectId}>
                <div className="migration-card-heading">
                  <span className="migration-project-icon">
                    <ArrowDownUp size={20} />
                  </span>
                  <div>
                    <h3>{project.name}</h3>
                    <span
                      className={
                        'migration-state migration-state-' + item.state
                      }
                    >
                      {item.label}
                    </span>
                  </div>
                </div>
                <div className="migration-route">
                  <span>{serverName(item.sourceId)}</span>
                  <ArrowRight size={16} aria-label="на сервер" />
                  <span>{serverName(item.targetId)}</span>
                </div>
                <p>
                  {item.state === 'manual'
                    ? 'Вы выбрали ручную подготовку. Когда сервер будет готов, продолжите и повторите проверку.'
                    : item.state === 'decision'
                      ? 'Выберите, как подготовить новый сервер. План и настройки уже сохранены.'
                      : item.state === 'ready'
                        ? 'Продолжите с сохранённого плана. При необходимости обновим проверку серверов.'
                        : item.state === 'recovery'
                          ? 'Продолжите восстановление существующей копии.'
                          : item.state === 'checking' ||
                              item.state === 'running'
                            ? 'Можно закрыть окно и вернуться к этой операции здесь.'
                            : 'Продолжите подготовку с сохранёнными проектом и сервером.'}
                </p>
                <div className="migration-card-actions">
                  <Button onClick={() => onContinue(project.id)}>
                    {['running', 'checking'].includes(item.state)
                      ? 'Открыть перенос'
                      : 'Продолжить'}
                    <ArrowRight size={16} />
                  </Button>
                  {job && (
                    <Button variant="ghost" onClick={() => onLogs(job)}>
                      Логи
                    </Button>
                  )}
                  <small>
                    {item.mode === 'llm'
                      ? 'С помощником LLM'
                      : 'Обычный перенос'}
                  </small>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="migration-queue-empty">
          <Check size={20} />
          <p>
            Незавершённых переносов нет. Начните новый — его план появится
            здесь.
          </p>
        </div>
      )}
    </section>
  );
}

type Choice = 'archive-stopped' | 'stop-archive' | 'manual' | 'server';
export function MigrationDecisions({
  plan,
  busy,
  manual,
  onChoice,
  onRecheck,
}: {
  plan: MigrationPlan;
  busy: boolean;
  manual: boolean;
  onChoice: (choice: Choice) => void;
  onRecheck: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const conflict = plan.conflictResolution;
  if (!conflict) return null;
  const selected = conflict.selected && !expanded && !manual;
  return (
    <section
      className={'migration-decision-panel' + (selected ? ' is-resolved' : '')}
      aria-label="Решение перед переносом"
    >
      <div className="migration-decision-heading">
        {selected ? <Check size={22} /> : <CircleHelp size={22} />}
        <div>
          <h3>
            {selected ? 'Решение выбрано' : 'На новом сервере уже есть ресурсы'}
          </h3>
          <p>
            {selected
              ? conflict.policy === 'stop-archive'
                ? 'Сервис остановит прежнюю копию, сохранит её данные и освободит имена.'
                : 'Прежняя копия будет сохранена в архиве перед переносом.'
              : 'Выберите удобный вариант. Решение сохранится вместе с планом.'}
          </p>
        </div>
      </div>
      <details className="migration-collision-list">
        <summary>Какие ресурсы затронуты</summary>
        <ul>
          {[...conflict.resources, ...conflict.paths].map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
        {conflict.reason && <p>{conflict.reason}</p>}
      </details>
      {selected ? (
        <>
          <p className="migration-decision-note">
            Подготовка начнётся после подтверждения внизу окна и нажатия «Начать
            перенос».
          </p>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => setExpanded(true)}
          >
            Изменить решение
          </Button>
        </>
      ) : (
        <>
          <div className="migration-choice-grid">
            <Button
              type="button"
              variant="outline"
              className="migration-choice"
              disabled={busy || !conflict.available || !!conflict.requiresStop}
              onClick={() => {
                setExpanded(false);
                onChoice('archive-stopped');
              }}
            >
              <Archive size={20} />
              <span>
                <strong>Сохранить прежнюю копию</strong>
                <small>
                  {conflict.requiresStop
                    ? 'Сначала требуется остановка — выберите автоматическую подготовку.'
                    : 'Архивируем остановленные ресурсы и освободим имена. Данные сохранятся.'}
                </small>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="migration-choice"
              disabled={busy || !conflict.available}
              onClick={() => {
                setExpanded(false);
                onChoice('stop-archive');
              }}
            >
              <Settings2 size={20} />
              <span>
                <strong>Подготовить автоматически</strong>
                <small>
                  Сервис сам штатно остановит прежнюю копию, проверит архив и
                  удалит конфликтующие ресурсы, сохранив данные.
                </small>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="migration-choice"
              disabled={busy}
              onClick={() => onChoice('server')}
            >
              <Server size={20} />
              <span>
                <strong>Выбрать другой сервер</strong>
                <small>
                  Оставить существующую копию на месте и изменить направление
                  переноса.
                </small>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className={'migration-choice' + (manual ? ' is-selected' : '')}
              disabled={busy}
              onClick={() => onChoice('manual')}
            >
              <Hand size={20} />
              <span>
                <strong>Подготовлю вручную</strong>
                <small>
                  Самостоятельно остановить или убрать конфликтующие ресурсы,
                  затем повторить проверку.
                </small>
              </span>
            </Button>
          </div>
          {!conflict.available && (
            <p className="form-error">
              {conflict.reason} Автоматическая подготовка доступна только для
              изолированных ресурсов выбранной копии.
            </p>
          )}
          {!conflict.available && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onRecheck}
            >
              Обновить проверку возможностей
            </Button>
          )}
          {manual && (
            <div className="migration-manual">
              <strong>Подготовьте выбранный сервер</strong>
              <p>
                Сохраните нужные данные и освободите перечисленные имена и пути.
                После этого нажмите кнопку — проверим сервер без повторной
                генерации плана.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onRecheck}
              >
                Я подготовил сервер — проверить
              </Button>
            </div>
          )}
          <p className="migration-decision-note">
            Выбор варианта пока только обновляет проверку. Работающий исходный
            проект остаётся на месте.
          </p>
        </>
      )}
    </section>
  );
}
