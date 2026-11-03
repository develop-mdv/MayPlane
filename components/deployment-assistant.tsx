'use client';
import { EnvRequirement, EnvExplanation } from './environment-fields';
import { WorkflowPanel } from './workflow-panel';
import { useState } from 'react';
import { Sparkles, Play, FileCode2, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import type { Workspace } from '@/lib/use-workspace';
import type { Project, Job } from '@/lib/domain';
export function DeploymentAssistant({
  project: p,
  ws,
  onJob,
}: {
  project: Project;
  ws: Workspace;
  onJob: (j: Job) => void;
}) {
  const [intent, setIntent] = useState('');
  const [useLlm, setUseLlm] = useState(true);
  const [error, setError] = useState('');
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [domain, setDomain] = useState(p.kind === 'web' ? p.domain : '');
  const pending =
    ws.busy ||
    ws.data.jobs.some(
      (j) =>
        j.projectId === p.id && ['pending', 'deploying'].includes(j.status),
    );
  const plan = p.assistant;
  async function start(operation: string) {
    setError('');
    try {
      const job = await ws.action(`/projects/${p.id}/${operation}`, {
        intent,
        useLlm,
        planId: plan?.id,
      });
      onJob(job);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="assistant-body">
      <div className="assistant-intro">
        <Sparkles size={23} />
        <div>
          <h3>От репозитория до запуска</h3>
          <p>
            {ws.data.llm?.enabled
              ? 'Модель: ' + ws.data.llm.model
              : 'Встроенное автоопределение. LLM можно подключить в настройках.'}
          </p>
        </div>
      </div>
      <label className="form-field" htmlFor="deploy-intent">
        <span>Что нужно развернуть</span>
        <Textarea
          id="deploy-intent"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="Например: сайт из папки frontend; сервер API уже работает отдельно. Уточните нужный сервис, если их несколько."
          maxLength={4000}
        />
        <small>
          {p.adoption
            ? 'Переменные привязанного приложения меняются в исходной конфигурации через чат или SSH.'
            : 'Секреты вводите во вкладке «Переменные».'}
        </small>
      </label>
      {ws.data.llm?.enabled && (
        <div className="switch-line">
          <div>
            <strong>Помощь LLM</strong>
            <small>
              Манифесты и инструкции отправляются выбранному провайдеру.
            </small>
          </div>
          <Switch
            checked={useLlm}
            disabled={!!p.adoption}
            onCheckedChange={setUseLlm}
            aria-label="Анализировать с LLM"
          />
        </div>
      )}
      <div className="detail-actions">
        <Button
          variant="outline"
          disabled={pending || (!!p.adoption && !ws.data.llm?.enabled)}
          onClick={() => start('analyze')}
        >
          <Sparkles size={15} />
          Подготовить план
        </Button>
        <Button
          className="primary-button"
          disabled={pending || (!!p.adoption && !ws.data.llm?.enabled)}
          onClick={() => start('auto-deploy')}
        >
          <Play size={15} />
          Подготовить и развернуть
        </Button>
      </div>
      <p className="detail-copy">
        Помощник остановится, если не хватает ключей или нужны ваши действия.
        Готовый план можно просмотреть до запуска. Для настройки с выполнением
        команд и обратной связью откройте вкладку «Чат».
      </p>
      {plan && (
        <section className="assistant-plan">
          <div className="assistant-plan-heading">
            <h3>{plan.summary}</h3>
            <span>{plan.source}</span>
          </div>
          <dl className="details-list">
            <div>
              <dt>Способ запуска</dt>
              <dd>
                {plan.runtime === 'commands'
                  ? 'Команды для этого проекта'
                  : plan.runtime}
              </dd>
            </div>
            <div>
              <dt>Рабочая папка</dt>
              <dd>{plan.workdir}</dd>
            </div>
            <div>
              <dt>
                {plan.runtime === 'commands' ? 'Повторные операции' : 'Compose'}
              </dt>
              <dd>
                {plan.runtime === 'commands'
                  ? 'Без LLM, по сохранённым командам'
                  : plan.composeFile || 'Нужно уточнение'}
              </dd>
            </div>
            <div>
              <dt>Коммит анализа</dt>
              <dd>
                <code>{plan.commit.slice(0, 8)}</code>
              </dd>
            </div>
          </dl>
          {plan.runtime === 'commands' && (
            <WorkflowPanel project={p} ws={ws} draft />
          )}
          {!!plan.blockers.length && (
            <div className="inline-notice">
              <strong>Перед запуском</strong>
              <ul>
                {plan.blockers.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
              <p>Ответьте во вкладке «Чат» — помощник продолжит настройку.</p>
            </div>
          )}
          {!p.adoption && !!p.missingEnvKeys?.length && (
            <div className="inline-notice">
              Заполните во вкладке «Переменные»: {p.missingEnvKeys.join(', ')}.
            </div>
          )}
          {!!plan.env.length && (
            <div className="assistant-env">
              {plan.env.map((e, i) => (
                <div key={e.name + i}>
                  <code>{e.name}</code>
                  <EnvExplanation definition={e} />
                  <span>
                    <EnvRequirement definition={e} />
                  </span>
                </div>
              ))}
            </div>
          )}
          {!!plan.notes.length && (
            <ul className="assistant-notes">
              {plan.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <details className="assistant-files">
            <summary>
              Что прочитал помощник · {plan.inspectedFiles.length} файлов
            </summary>
            <ul>
              {plan.inspectedFiles.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
            {!!plan.omitted && (
              <p>
                Не прочитано файлов: {plan.omitted}. При необходимости уточните
                проект.
              </p>
            )}
          </details>
          {!!plan.files.length && (
            <>
              <Button
                variant="outline"
                disabled={pending}
                onClick={async () => {
                  try {
                    const result = await ws.api<{
                      files: Record<string, string>;
                    }>(`/projects/${p.id}/assistant`);
                    setFiles(result.files);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <FileCode2 size={15} />
                Показать созданные конфигурации
              </Button>
              {files &&
                Object.entries(files).map(([path, content]) => (
                  <details key={path} className="assistant-files">
                    <summary>{path}</summary>
                    <pre>{content}</pre>
                  </details>
                ))}
            </>
          )}
          <Button
            className="primary-button full-width"
            disabled={
              pending ||
              (!!p.missingEnvKeys?.length && !p.adoption) ||
              !!plan.blockers.length ||
              plan.runtime === 'manual'
            }
            onClick={() => start('apply-plan')}
          >
            <Play size={15} />
            Развернуть по этому плану
          </Button>
          {plan.usage && (
            <p className="detail-copy">
              Последний анализ: {plan.usage.input} входных / {plan.usage.output}{' '}
              выходных токенов.
            </p>
          )}
        </section>
      )}
      {p.kind === 'web' &&
        !p.adoption &&
        !p.workflow &&
        plan?.runtime !== 'commands' && (
          <section className="assistant-plan">
            <h3>Адрес сайта</h3>
            <label className="form-field" htmlFor="assistant-domain">
              <span>Домен</span>
              <Input
                id="assistant-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="app.example.com"
              />
            </label>
            <Button
              variant="outline"
              disabled={pending || p.status !== 'running'}
              onClick={async () => {
                try {
                  const job = await ws.action(`/projects/${p.id}/domain`, {
                    domain,
                  });
                  onJob(job);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <RefreshCw size={15} />
              Настроить домен
            </Button>
            {p.publicUrl && (
              <a
                className="text-link"
                href={p.publicUrl}
                target="_blank"
                rel="noreferrer"
              >
                Открыть {p.publicUrl} ↗
              </a>
            )}
            {p.deploymentChecks && (
              <>
                <p className="detail-copy">
                  HTTP: {p.deploymentChecks.httpStatus || 'пока не проверен'}
                </p>
                <ul className="assistant-notes">
                  {p.deploymentChecks.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      <section className="assistant-plan">
        <h3>Если деплой завершился ошибкой</h3>
        <Button
          variant="outline"
          disabled={
            pending ||
            !ws.data.llm?.enabled ||
            !ws.data.jobs.some(
              (j) => j.projectId === p.id && j.status === 'failed',
            )
          }
          onClick={() => start('diagnose')}
        >
          <Sparkles size={15} />
          Объяснить последнюю ошибку
        </Button>
        {p.diagnosis && (
          <div>
            <p>{p.diagnosis.summary}</p>
            <ol className="assistant-notes">
              {p.diagnosis.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </div>
        )}
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
