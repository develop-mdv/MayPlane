'use client';
import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { Server } from '@/lib/domain';
import {
  providerNames,
  activeSession,
  type Hub,
  type AgentProvider,
  type AgentSession,
} from '@/lib/hub';
import { Modal, Field, ErrorText } from './hub-ui';
type NativeSession = {
  nativeId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  active: boolean;
  importedSessionId: string | null;
};
type Page = { sessions: NativeSession[]; nextCursor: string | null };
export function NativeSessionImport({
  hub,
  machines,
  onClose,
  onOpened,
}: {
  hub: Hub;
  machines: Server[];
  onClose: () => void;
  onOpened: (s: AgentSession) => void;
}) {
  const [machineId, setMachineId] = useState(
      machines.find((m) => m.status === 'online')?.id || machines[0]?.id || '',
    ),
    [provider, setProvider] = useState<AgentProvider>('codex'),
    [rows, setRows] = useState<NativeSession[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [stopped, setStopped] = useState(false),
    [mode, setMode] = useState('workspace-write'),
    [error, setError] = useState(''),
    [filter, setFilter] = useState('');
  const machine = machines.find((m) => m.id === machineId);
  async function load(more = false) {
    setBusy(true);
    setError('');
    try {
      const result = await hub.mutate<Page>(
        `/machines/${machineId}/agents/${provider}/native-sessions`,
        { cursor: more ? cursor : null },
      );
      setRows((old) =>
        more
          ? [
              ...old,
              ...result.sessions.filter(
                (s) => !old.some((o) => o.nativeId === s.nativeId),
              ),
            ]
          : result.sessions,
      );
      setCursor(result.nextCursor);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setRows([]);
    setCursor(null);
    setLoaded(false);
    setError('');
    setStopped(false);
  }
  return (
    <Modal
      title="Продолжить с компьютера"
      description="Подключите сохранённый диалог CLI или настольного Codex. Работа продолжится на той же машине и в той же папке."
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="hub-form">
        <div className="form-grid">
          <Field label="Машина">
            <select
              aria-label="Машина с диалогами"
              value={machineId}
              disabled={busy}
              onChange={(e) => {
                setMachineId(e.target.value);
                reset();
              }}
            >
              <option value="" disabled>
                Выберите машину
              </option>
              {machines.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                  {m.transport === 'local' ? ' · Хост панели' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Агент">
            <select
              aria-label="Агент для поиска диалогов"
              value={provider}
              disabled={busy}
              onChange={(e) => {
                setProvider(e.target.value as AgentProvider);
                reset();
              }}
            >
              <option value="codex">Codex · CLI и приложение</option>
              <option value="opencode">OpenCode</option>
            </select>
          </Field>
        </div>
        <p className="hub-note">
          Читается профиль пользователя агента на выбранной машине. Для
          настольного Codex коннектор должен работать от того же пользователя и
          с совместимой версией CLI. Облачные диалоги, отсутствующие на машине,
          здесь не появятся.
        </p>
        <button
          className="hub-button"
          disabled={busy || !machineId || machine?.status === 'offline'}
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={busy ? 'spin' : ''} />
          {loaded ? 'Обновить список' : 'Найти диалоги'}
        </button>
        {machine?.status === 'offline' && (
          <p className="hub-note">
            Включите машину и запустите коннектор. Файлы и диалоги остаются на
            ней.
          </p>
        )}
        {provider === 'codex' && (
          <Field label="Доступ к рабочей папке">
            <select
              aria-label="Доступ для продолжения диалога"
              value={mode}
              disabled={busy}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="workspace-write">
                Изменения в рабочей папке · дополнительные права по запросу
              </option>
              <option value="read-only">Только чтение</option>
            </select>
          </Field>
        )}
        <ErrorText error={error} />
        {loaded && (
          <>
            <Field label="Поиск в загруженных диалогах">
              <input
                aria-label="Поиск диалога машины"
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </Field>
            <label className="native-handoff">
              <input
                type="checkbox"
                checked={stopped}
                onChange={(e) => setStopped(e.target.checked)}
              />
              Я завершил текущий ход в исходном приложении. Не буду одновременно
              отправлять сообщения в этот диалог из двух интерфейсов.
            </label>
            <div className="native-session-list">
              {rows
                .filter((s) =>
                  `${s.title} ${s.cwd}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )
                .map((s) => (
                  <article key={s.nativeId} className="native-session-row">
                    <div>
                      <strong>{s.title}</strong>
                      <code>{s.cwd}</code>
                      <small>
                        {providerNames[provider]} ·{' '}
                        {new Date(s.updatedAt).toLocaleString('ru-RU')}
                        {s.active ? ' · Выполняется' : ''}
                      </small>
                    </div>
                    <button
                      className="hub-button"
                      disabled={
                        busy || s.active || (!stopped && !s.importedSessionId)
                      }
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          if (s.importedSessionId) {
                            const existing = hub.data.sessions.find(
                              (r) => r.id === s.importedSessionId,
                            );
                            if (existing) {
                              if (
                                existing.nativeSource &&
                                !activeSession(existing)
                              )
                                await hub.mutate(
                                  `/sessions/${existing.id}/sync`,
                                );
                              onOpened(existing);
                              return;
                            }
                          }
                          const result = await hub.mutate<AgentSession>(
                            '/sessions/import',
                            {
                              machineId,
                              provider,
                              nativeId: s.nativeId,
                              cwd: s.cwd,
                              stopped,
                              mode:
                                provider === 'codex' ? mode : 'workspace-write',
                            },
                          );
                          onOpened(result);
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Download size={14} />
                      {s.importedSessionId ? 'Открыть' : 'Продолжить'}
                    </button>
                  </article>
                ))}
            </div>
            {!rows.length && (
              <p className="hub-note">
                Сохранённых диалогов в этом профиле нет.
              </p>
            )}
            {cursor && (
              <button
                className="hub-button"
                disabled={busy}
                onClick={() => void load(true)}
              >
                Ещё диалоги
              </button>
            )}
            <p className="hub-note">
              Используются аккаунт и провайдеры самой машины, включая локальные
              модели. История выбранного диалога сохраняется в панели в
              зашифрованном виде; файлы проекта не копируются. Для больших
              диалогов Codex показываются последние 100 элементов истории,
              полный контекст остаётся у агента.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
