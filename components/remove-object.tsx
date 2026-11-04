'use client';
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type {
  Hub,
  RemovalPreview,
  RemovalResult,
  RemovalTarget,
} from '@/lib/hub';
import type { Workspace } from '@/lib/use-workspace';
import { Modal, Field, ErrorText } from './hub-ui';

const labels = {
  chat: 'Удалить чат?',
  project: 'Удалить проект?',
  service: 'Удалить сервис?',
  machine: 'Удалить машину?',
};
export function RemoveObject({
  target,
  ws,
  hub,
  onClose,
  onRemoved,
}: {
  target: RemovalTarget;
  ws: Workspace;
  hub: Hub;
  onClose: () => void;
  onRemoved: (result: RemovalResult) => void;
}) {
  const [preview, setPreview] = useState<RemovalPreview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [deleteChats, setDeleteChats] = useState(false),
    [allowUnclearedCredentials, setAllowUncleared] = useState(false),
    [confirmName, setConfirmName] = useState('');
  const url = `/hub/removals/${target.kind}/${target.id}`;
  const api = ws.api;
  useEffect(() => {
    let active = true;
    void api<RemovalPreview>(url)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [url, api]);
  const needsName =
    target.kind === 'machine' &&
    !!preview &&
    preview.chats + preview.projects + preview.services > 0;
  return (
    <Modal
      title={labels[target.kind]}
      description={`«${preview?.name || target.name}» будет удалён из MayPlane.`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {!preview && !error && (
        <p className="hub-note">Проверяем связанные данные…</p>
      )}
      {preview && (
        <>
          {target.kind === 'chat' && (
            <p className="hub-note">
              История и сообщения этого чата будут удалены из панели без
              возможности восстановления. Нативная история Codex/OpenCode на
              машине и файлы проекта сохранятся.
            </p>
          )}
          {target.kind === 'project' && (
            <>
              <p className="hub-note">
                Рабочая папка и файлы останутся на машине. По умолчанию{' '}
                {preview.chats} чатов перейдут в «Без проекта» с прежним рабочим
                каталогом.
              </p>
              {preview.chats > 0 && (
                <label className="remove-option">
                  <input
                    type="checkbox"
                    checked={deleteChats}
                    disabled={busy}
                    onChange={(e) => setDeleteChats(e.target.checked)}
                  />
                  <span>
                    Удалить также все чаты проекта из панели ({preview.chats}),
                    включая архивные. Их историю восстановить нельзя.
                  </span>
                </label>
              )}
            </>
          )}
          {target.kind === 'service' && (
            <p className="hub-note">
              Карточка и сохранённые настройки сервиса будут удалены из панели.
              Само приложение продолжит работать: контейнеры, файлы, домен и
              данные на сервере сохранятся. Проекты и чаты останутся.
            </p>
          )}
          {target.kind === 'machine' && (
            <>
              <p className="hub-note">
                Будут удалены подключение и сохранённые доступы, а также
                связанные данные панели: проекты — {preview.projects}, чаты —{' '}
                {preview.chats} (включая архив), сервисы — {preview.services}.
                Историю чатов восстановить нельзя.
              </p>
              <p className="hub-note">
                Машина продолжит работать. Файлы, приложения и нативная история
                агентов сохранятся. SSH-консоли закроются, коннектор потеряет
                доступ. Аккаунты в настройках останутся.
              </p>
              {preview.pendingCredentials > 0 && (
                <label className="remove-option remove-warning">
                  <input
                    type="checkbox"
                    checked={allowUnclearedCredentials}
                    disabled={busy}
                    onChange={(e) => setAllowUncleared(e.target.checked)}
                  />
                  <span>
                    Удалить без очистки {preview.pendingCredentials} копий
                    доступа в профилях агентов на машине. Эти копии могут
                    остаться рабочими; при необходимости отзовите их у
                    провайдера. Для OAuth может потребоваться повторный вход в
                    аккаунт.
                  </span>
                </label>
              )}
              {needsName && (
                <Field label="Для подтверждения введите название машины">
                  <input
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                  />
                </Field>
              )}
            </>
          )}
        </>
      )}
      <ErrorText error={error} />
      <div className="form-actions">
        <button
          type="button"
          className="hub-button"
          onClick={onClose}
          disabled={busy}
        >
          Отмена
        </button>
        <button
          type="button"
          className="hub-button remove-confirm"
          disabled={
            !preview || busy || (needsName && confirmName !== preview.name)
          }
          onClick={() => {
            if (!preview || busy) return;
            setBusy(true);
            setError('');
            void ws
              .action<RemovalResult>(
                url,
                {
                  confirm: true,
                  revision: preview.revision,
                  deleteChats,
                  confirmName,
                  allowUnclearedCredentials,
                },
                'DELETE',
              )
              .then(async (result) => {
                onRemoved(result);
                await hub.refresh();
              })
              .catch((e: Error) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <Trash2 size={15} />
          {busy ? 'Удаляем…' : 'Удалить из панели'}
        </button>
      </div>
    </Modal>
  );
}
