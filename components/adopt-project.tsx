'use client';
import { useEffect, useState } from 'react';
import { Download, Link2, Search, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  statusLabels,
  type AdoptionCandidate,
  type Discovery,
  type Project,
} from '@/lib/domain';
import type { Workspace } from '@/lib/use-workspace';
export const runtimeLabels = {
  compose: 'Docker Compose',
  docker: 'Docker',
  systemd: 'systemd',
  directory: 'Каталог · способ запуска не определён',
};
function CandidateDetails({ candidate: c }: { candidate: AdoptionCandidate }) {
  return (
    <div className="adoption-details">
      <span>
        {runtimeLabels[c.runtime]} · {statusLabels[c.status]}
      </span>
      {c.directory && <code>{c.directory}</code>}
      {c.git?.repo && (
        <span>
          Git: {c.git.repo} · {c.git.branch} · {c.git.commit.slice(0, 8)}
        </span>
      )}
      {c.repoMatch && (
        <strong className="form-success">
          Совпадает с репозиторием проекта
        </strong>
      )}
      {!!c.ports.length && <span>Порты: {c.ports.join(', ')}</span>}
      {!!c.mounts.length && (
        <span>
          Данные:{' '}
          {c.mounts
            .map(
              (m) =>
                `${m.source} → ${m.target}${m.readOnly ? ' (только чтение)' : ''}`,
            )
            .join('; ')}
        </span>
      )}
      {!!c.configFiles.length && (
        <span>Конфигурация: {c.configFiles.join(', ')}</span>
      )}
    </div>
  );
}
export function ExistingProjectPanel({
  project: p,
  ws,
}: {
  project: Project;
  ws: Workspace;
}) {
  const { api } = ws;
  const [directory, setDirectory] = useState('');
  const [scan, setScan] = useState<Discovery | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [unlink, setUnlink] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const jobs = ws.data.jobs.filter(
    (j) =>
      j.projectId === p.id && ['discover', 'adopt', 'check'].includes(j.type),
  );
  const pending =
    ws.busy ||
    localBusy ||
    ws.data.jobs.some(
      (j) =>
        ['pending', 'deploying'].includes(j.status) &&
        (j.serverId === p.serverId || j.target === p.serverId),
    );
  useEffect(() => {
    let live = true;
    if (p.adoption?.id || !p.discovery?.id) return;
    api<{ discovery: Discovery | null }>(`/projects/${p.id}/discovery`)
      .then((r) => {
        if (live) {
          setScan(r.discovery);
          setSelected('');
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [api, p.id, p.discovery?.id, p.adoption?.id]);
  async function action(operation: string, body = {}) {
    setError('');
    setLocalBusy(true);
    try {
      await ws.action(`/projects/${p.id}/${operation}`, body);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setLocalBusy(false);
    }
  }
  const candidate = scan?.candidates.find((c) => c.id === selected);
  return (
    <section className="workflow-panel adoption-panel">
      <h3 className="detail-heading">
        <Link2 size={17} />{' '}
        {p.adoption ? 'Приложение привязано' : 'Уже работает на сервере?'}
      </h3>
      {p.adoption ? (
        <>
          <strong>{p.adoption.name}</strong>
          <CandidateDetails candidate={{ ...p.adoption, status: p.status }} />
          <p className="detail-copy">
            Проверено: {new Date(p.adoption.checkedAt).toLocaleString('ru')}.
            Снимок конфигурации:{' '}
            {new Date(p.adoption.linkedAt).toLocaleString('ru')}.
          </p>
          {!p.workflow && (
            <p className="inline-notice">
              {p.adoption.runtime === 'directory'
                ? 'Каталог привязан. Чтобы управлять процессом и получать логи, попросите помощника в чате определить способ запуска и сохранить сценарий.'
                : 'Кнопка «Запустить» запускает существующее приложение. Для обновления кода и CI/CD попросите помощника в чате сохранить сценарий обновления с сохранением данных.'}
            </p>
          )}
          {p.adoption.warnings.map((w, i) => (
            <p className="inline-notice" key={i}>
              {w}
            </p>
          ))}
          <div className="detail-actions">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void action('check')}
            >
              Проверить состояние
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={async () => {
                setError('');
                setLocalBusy(true);
                try {
                  const snapshot = await api(
                    `/projects/${p.id}/adoption-snapshot`,
                  );
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(snapshot, null, 2)], {
                      type: 'application/json',
                    }),
                  );
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${p.name}-configuration.json`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setLocalBusy(false);
                }
              }}
            >
              <Download size={15} /> Скачать снимок
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setUnlink(true)}
            >
              <Unlink size={15} /> Отвязать
            </Button>
          </div>
          <p className="detail-copy">
            Снимок содержит конфигурацию и секретные значения переменных. Это не
            резервная копия баз данных и файлов приложения.
          </p>
        </>
      ) : (
        <>
          <p className="detail-copy">
            Найдём приложения Docker Compose, Docker и systemd на выбранном
            сервере. Поиск и привязка только читают данные: процессы продолжат
            работать.
          </p>
          <label className="form-field" htmlFor={`adoption-directory-${p.id}`}>
            <span>Каталог приложения, если известен</span>
            <Input
              id={`adoption-directory-${p.id}`}
              aria-label="Каталог существующего приложения"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="/srv/my-app"
              disabled={pending}
            />
            <small>
              Необязательно. Помогает найти Git и позволяет привязать каталог с
              другим способом запуска.
            </small>
          </label>
          <Button
            variant="outline"
            disabled={pending}
            onClick={async () => {
              setScan(null);
              setSelected('');
              await action('discover', { directory });
            }}
          >
            <Search size={15} />{' '}
            {pending
              ? 'Выполняется операция…'
              : 'Проверить на сервере и привязать'}
          </Button>
          {scan && (
            <>
              {scan.warnings.map((w, i) => (
                <p className="inline-notice" key={i}>
                  {w}
                </p>
              ))}
              <p className="detail-copy">
                Найдено: {scan.candidates.length}. Выберите приложение для этой
                карточки.
              </p>
              <div
                className="adoption-candidates"
                role="radiogroup"
                aria-label="Найденные приложения"
              >
                {scan.candidates.map((c) => (
                  <label
                    key={c.id}
                    className={`adoption-candidate ${selected === c.id ? 'selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`adopt-${p.id}`}
                      value={c.id}
                      checked={selected === c.id}
                      disabled={pending || !!c.linkedProject}
                      onChange={() => setSelected(c.id)}
                    />
                    <div>
                      <strong>{c.name}</strong>
                      <CandidateDetails candidate={c} />
                      {c.linkedProject && (
                        <p className="inline-notice">
                          Уже привязано: {c.linkedProject}
                        </p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
              {!scan.candidates.length && (
                <p className="inline-notice">
                  Приложения не найдены. Укажите точный каталог на сервере и
                  повторите проверку.
                </p>
              )}
              {candidate && (
                <div className="adoption-confirm">
                  <p>
                    Привязать «{candidate.name}» к «{p.name}»?
                  </p>
                  <p className="detail-copy">
                    Карточка получит конфигурацию и снимок окружения с сервера.
                    Прежний сценарий и переменные карточки будут заменены;
                    автодеплой отключится. Данные на сервере сохранятся.
                  </p>
                  <Button
                    className="primary-button"
                    disabled={pending || !!candidate.linkedProject}
                    onClick={() =>
                      void action('adopt', {
                        scanId: scan.id,
                        candidateId: selected,
                        confirmAdopt: true,
                      })
                    }
                  >
                    <Link2 size={15} /> Привязать это приложение
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
      {jobs[0]?.status === 'failed' && (
        <p className="form-error" role="alert">
          {jobs[0].logs.at(-1) ||
            'Операция завершилась ошибкой. Повторите проверку.'}
        </p>
      )}
      {pending && (
        <output className="detail-copy">
          Дождитесь завершения операции на сервере. Результат появится здесь
          автоматически.
        </output>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <AlertDialog open={unlink} onOpenChange={setUnlink}>
        <AlertDialogContent>
          <AlertDialogTitle>Отвязать приложение?</AlertDialogTitle>
          <AlertDialogDescription>
            Приложение продолжит работать на сервере. Карточка останется в
            панели; привязка и её сценарий управления будут удалены. Чтобы
            управлять приложением снова, повторите поиск и привязку.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={async () => {
                if (await action('unlink')) {
                  setUnlink(false);
                  setScan(null);
                  setSelected('');
                }
              }}
            >
              Отвязать
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
