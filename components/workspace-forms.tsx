'use client';
import { useState } from 'react';
import { ArrowUpRight, Check, Plus, ShieldCheck } from 'lucide-react';
import type { Server as Machine } from '@/lib/domain';
import type { Hub, HubProject } from '@/lib/hub';
import type { Workspace } from '@/lib/use-workspace';
import { ErrorText, Field, Modal, Submit } from './hub-ui';
import { AccountsSettings } from './agent-accounts';

export function NewProject({
  hub,
  machines,
  onClose,
  onSaved,
  onAddMachine,
}: {
  hub: Hub;
  machines: Machine[];
  onClose: () => void;
  onSaved: (p: HubProject) => void;
  onAddMachine: () => void;
}) {
  const [name, setName] = useState(''),
    [machineId, setMachineId] = useState(machines[0]?.id || ''),
    [path, setPath] = useState(''),
    [repo, setRepo] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const machine = machines.find((m) => m.id === machineId);
  return (
    <Modal
      title="Добавить проект"
      description="Проект — это рабочая папка на одной из ваших машин. Все диалоги сохраняют её контекст."
      onClose={onClose}
    >
      <form
        className="hub-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const p = await hub.mutate<HubProject>('/projects', {
              name,
              machineId,
              path,
              repo,
            });
            onSaved(p);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Название проекта">
          <input
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Мой проект"
            maxLength={80}
          />
        </Field>
        <Field label="Машина">
          <select
            required
            value={machineId}
            onChange={(e) => {
              setMachineId(e.target.value);
              setPath('');
            }}
          >
            <option value="" disabled>
              Выберите машину
            </option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ·{' '}
                {m.transport === 'local'
                  ? 'Хост панели'
                  : m.region || m.host}
              </option>
            ))}
          </select>
        </Field>
        {!machines.length && (
          <button type="button" className="hub-button" onClick={onAddMachine}>
            <Plus size={15} />
            Сначала подключить машину
          </button>
        )}
        <Field
          label="Путь к рабочей папке"
          hint="Укажите существующую папку на выбранной машине. Панель не клонирует репозиторий и не меняет её содержимое при добавлении."
        >
          <input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={
              machine?.platform === 'win32'
                ? 'D:\\Projects\\my-app'
                : '/home/deploy/projects/my-app'
            }
            maxLength={1024}
          />
        </Field>
        <Field
          label="Git-репозиторий · необязательно"
          hint="Ссылка для быстрого перехода. Git использует доступы, настроенные на машине проекта."
        >
          <input
            type="url"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="https://github.com/owner/project"
          />
        </Field>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="hub-button" onClick={onClose}>
            Отмена
          </button>
          <Submit busy={busy}>Добавить проект</Submit>
        </div>
      </form>
    </Modal>
  );
}
export function SettingsPanel({ ws, hub }: { ws: Workspace; hub: Hub }) {
  const [url, setUrl] = useState(ws.connection?.url || ''),
    [token, setToken] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="hub-page settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span>
          <h1>Настройки</h1>
          <p>Подключение панели и границы доступа.</p>
        </div>
      </div>
      <AccountsSettings hub={hub} ws={ws} />
      <section className="detail-card">
        <div className="section-title">
          <h2>Серверная часть</h2>
          <span
            className={`state-badge ${ws.connection && !ws.error ? 'online' : ''}`}
          >
            <i />
            {ws.connection && !ws.error ? 'Подключена' : 'Нет соединения'}
          </span>
        </div>
        <p className="muted">
          Runner хранит проекты и зашифрованные секреты, соединяет панель с
          вашими машинами.
        </p>
        <form
          className="hub-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await ws.connect(url, token);
              setToken('');
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Адрес API"
            hint="Пустое поле — локальный прокси панели. Для удалённого API нужен HTTPS."
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Локальное подключение / https://control.example.com"
            />
          </Field>
          <Field
            label="Ключ доступа"
            hint="Хранится в памяти этой вкладки. Не записывается в localStorage."
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              placeholder="EZDEPLOY_TOKEN — для прямого подключения"
            />
          </Field>
          <ErrorText error={error} />
          <div className="form-actions">
            {ws.connection && (
              <button
                type="button"
                className="hub-button"
                onClick={() => {
                  ws.disconnect();
                  setToken('');
                }}
              >
                Отключить
              </button>
            )}
            <Submit busy={busy}>Подключить</Submit>
          </div>
        </form>
      </section>
      <section className="detail-card">
        <div className="section-title">
          <h2>Безопасность</h2>
          <ShieldCheck size={18} />
        </div>
        <div className="security-item">
          <Check size={16} />
          <div>
            <strong>Секреты зашифрованы</strong>
            <p>
              SSH-пароли, ключи и история диалогов защищены AES-256-GCM. Ключ
              шифрования хранится отдельно от базы.
            </p>
          </div>
        </div>
        <div className="security-item">
          <Check size={16} />
          <div>
            <strong>Личные аккаунты агентов</strong>
            <p>
              Сохранённые аккаунты выбираются для машин и чатов. Для каждого
              чата используется выбранный профиль; работа других аккаунтов не
              затрагивается.
            </p>
          </div>
        </div>
        <div className="security-item">
          <Check size={16} />
          <div>
            <strong>Контроль действий в диалоге</strong>
            <p>
              Codex использует песочницу проекта и запросы дополнительных прав.
              OpenCode спрашивает разрешение на инструменты; его действия
              выполняются с правами пользователя ОС.
            </p>
          </div>
        </div>
        <div className="security-item">
          <Check size={16} />
          <div>
            <strong>Личная панель</strong>
            <p>
              Текущая версия рассчитана на одного владельца. Для доступа через
              интернет используйте HTTPS и аутентификацию reverse proxy или VPN.
              Локальный dev-сервер доступен на 127.0.0.1.
            </p>
          </div>
        </div>
      </section>
      <div className="settings-footer">
        <span>
          ezdeploy <code>0.2.0</code>
        </span>
        <a
          href="https://github.com/develop-mdv/ezdeploy"
          target="_blank"
          rel="noreferrer"
        >
          Репозиторий проекта <ArrowUpRight size={14} />
        </a>
      </div>
    </div>
  );
}
