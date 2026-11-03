'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import type { Workspace } from '@/lib/use-workspace';
import type { Project, Workflow } from '@/lib/domain';
const commands = {
  deploy: 'Развёртывание',
  stop: 'Остановка',
  remove: 'Удаление развёртывания',
  check: 'Проверка работы',
  logs: 'Получение логов',
} as const;
export function WorkflowPanel({
  project,
  ws,
  draft = false,
}: {
  project: Project;
  ws: Workspace;
  draft?: boolean;
}) {
  const { api } = ws;
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const pending =
    ws.busy ||
    ws.data.jobs.some(
      (j) =>
        ['pending', 'deploying'].includes(j.status) &&
        (j.serverId === project.serverId || j.projectId === project.id),
    );
  useEffect(() => {
    let live = true;
    api<{ workflow: Workflow | null; draft: Workflow | null }>(
      `/projects/${project.id}/workflow`,
    )
      .then((r) => {
        if (live) {
          setWorkflow(draft ? r.draft : r.workflow);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [
    api,
    project.id,
    project.workflow?.id,
    project.assistant?.id,
    project.adoption?.id,
    draft,
  ]);
  return (
    <section className="workflow-panel">
      <h3 className="detail-heading">
        {draft ? 'Команды плана' : 'Сценарий управления'}
      </h3>
      {!workflow ? (
        <p className="detail-copy">
          {!loaded
            ? 'Загружаем сценарий…'
            : draft
              ? 'Пока нет готовых команд. Продолжите настройку в чате.'
              : project.adoption
                ? 'Для обновления существующего приложения сохраните сценарий через чат. Базовые команды управления привязкой уже доступны.'
                : 'Пока используется стандартный Docker Compose. Попросите помощника в чате подготовить сценарий для вашего проекта.'}
        </p>
      ) : (
        <>
          <p className="detail-copy">{workflow.summary}</p>
          <p className="workflow-status">
            {draft
              ? 'Черновик. Команды ещё не выполнялись.'
              : project.workflow?.stale
                ? 'Настройки проекта изменились. Обновите сценарий в чате.'
                : project.workflow?.verifiedAt
                  ? `Запуск проверен ${new Date(project.workflow.verifiedAt).toLocaleString('ru')}`
                  : 'Сценарий сохранён; успешный запуск ещё не подтверждён.'}{' '}
            {!draft && 'Кнопки управления и CI/CD выполняют его без LLM.'}
          </p>
          {Object.entries(commands).map(([key, label]) => (
            <details className="assistant-files" key={key} open={editing}>
              <summary>{label}</summary>
              {editing ? (
                <Textarea
                  aria-label={label + ': команда'}
                  rows={5}
                  value={workflow[key as keyof typeof commands]}
                  onChange={(e) =>
                    setWorkflow({ ...workflow, [key]: e.target.value })
                  }
                  maxLength={24000}
                />
              ) : (
                <pre>{workflow[key as keyof typeof commands]}</pre>
              )}
            </details>
          ))}
          {Object.entries(workflow.files || {}).map(([path, content]) => (
            <details className="assistant-files" key={path}>
              <summary>Файл: {path}</summary>
              <pre>{content}</pre>
            </details>
          ))}
          {!draft && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={async () => {
                if (!editing) {
                  setEditing(true);
                  setSaved(false);
                  return;
                }
                try {
                  setError('');
                  await ws.action(
                    `/projects/${project.id}/workflow`,
                    workflow,
                    'PATCH',
                  );
                  setEditing(false);
                  setSaved(true);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {editing ? 'Сохранить команды' : 'Редактировать команды'}
            </Button>
          )}
          {editing && (
            <p className="detail-copy">
              Команды выполняются в Bash с переменными EZDEPLOY_PROJECT_DIR,
              EZDEPLOY_REPO_DIR, EZDEPLOY_DATA_DIR и окружением проекта.
              Сохранение не запускает команды.
            </p>
          )}
          {saved && <p className="form-success">Сценарий сохранён.</p>}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
