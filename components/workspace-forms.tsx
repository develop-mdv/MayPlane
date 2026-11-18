'use client';
import { WorkspaceSelect } from './workspace-select';
import { OwnerSettings } from './panel-auth';
import { useState } from 'react';
import {
  ArrowUpRight,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Plus,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import type { Server as Machine } from '@/lib/domain';
import type { Hub, HubProject } from '@/lib/hub';
import type { Workspace } from '@/lib/use-workspace';
import { ErrorText, Field, Modal, Submit } from './hub-ui';
import { AccountsSettings } from './agent-accounts';
import { PathField } from './path-picker';

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
          <WorkspaceSelect
            aria-label="Машина"
            required
            value={machineId}
            onValueChange={(choice) => {
              setMachineId(choice);
              setPath('');
            }}
            options={[
              { value: '', label: 'Выберите машину', disabled: true },
              ...machines.map((m) => ({
                value: m.id,
                label: `${m.name} · ${m.transport === 'local' ? 'Хост панели' : m.region || m.host}`,
              })),
            ]}
          />
        </Field>
        {!machines.length && (
          <button type="button" className="hub-button" onClick={onAddMachine}>
            <Plus size={15} />
            Сначала подключить машину
          </button>
        )}
        <PathField
          api={hub.api}
          machineId={machine?.id}
          machineName={machine?.name}
          platform={machine?.platform}
          label="Рабочая папка"
          hint="Выберите существующую папку на машине или введите её полный путь."
          value={path}
          onChange={setPath}
          required
        />
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
export type SettingsSection = 'accounts' | 'access' | 'security';
const settingsSections = [
  {
    id: 'accounts',
    label: 'Аккаунты агентов',
    short: 'Аккаунты',
    icon: UsersRound,
  },
  { id: 'access', label: 'Доступ к панели', short: 'Доступ', icon: KeyRound },
  {
    id: 'security',
    label: 'Безопасность',
    short: 'Безопасность',
    icon: ShieldCheck,
  },
] as const;

const securityNotes = [
  {
    icon: LockKeyhole,
    title: 'Шифрование данных',
    text: 'Панель хранит SSH-пароли, ключи, токены аккаунтов и историю диалогов с шифрованием AES-256-GCM. Ключ шифрования хранится отдельно от базы.',
  },
  {
    icon: UsersRound,
    title: 'Аккаунты агентов',
    text: 'Codex получает доступ к аккаунту на время работы процесса. OpenCode использует отдельные профили. Для OAuth в OpenCode доступен один активный чат на аккаунт, а API-ключ поддерживает параллельные чаты.',
  },
  {
    icon: ShieldCheck,
    title: 'Разрешения в чате',
    text: 'Codex работает в песочнице проекта и запрашивает дополнительные права. OpenCode запрашивает доступ к инструментам и выполняет действия с правами пользователя машины.',
  },
  {
    icon: Fingerprint,
    title: 'Вход владельца',
    text: 'Вход в личную панель защищён логином и паролем. При установке для доступа через интернет настраиваются HTTPS и продление сертификата. Сервер разработки слушает 127.0.0.1.',
  },
];

export function SettingsPanel({
  ws,
  hub,
  section,
  onSection,
}: {
  ws: Workspace;
  hub: Hub;
  section: SettingsSection;
  onSection: (value: SettingsSection) => void;
}) {
  return (
    <div className="hub-page settings-page">
      <div className="settings-inner">
        <Tabs
          value={section}
          onValueChange={(value) => onSection(value as SettingsSection)}
          className="settings-tabs"
        >
          <header className="settings-heading">
            <h1>Настройки</h1>
            <TabsList
              className="settings-tab-list"
              aria-label="Раздел настроек"
            >
              {settingsSections.map(({ id, label, short, icon: Icon }) => (
                <TabsTrigger key={id} value={id} aria-label={label}>
                  <Icon size={16} aria-hidden="true" />
                  {short}
                </TabsTrigger>
              ))}
            </TabsList>
          </header>
          <TabsContent value="accounts">
            <AccountsSettings hub={hub} ws={ws} />
          </TabsContent>
          <TabsContent value="access">
            <OwnerSettings />
          </TabsContent>
          <TabsContent value="security">
            <section className="settings-section">
              <header className="settings-section-heading">
                <h2>Защита рабочего пространства</h2>
              </header>
              <div className="settings-surface">
                {securityNotes.map(({ icon: Icon, title, text }) => (
                  <div className="settings-info-row" key={title}>
                    <span className="settings-row-icon">
                      <Icon size={19} />
                    </span>
                    <div>
                      <h3>{title}</h3>
                      <p>{text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </TabsContent>
        </Tabs>
        <div className="settings-footer">
          <span>
            MayPlane <code>0.2.0</code>
          </span>
          <a
            href="https://github.com/develop-mdv/MayPlane"
            target="_blank"
            rel="noreferrer"
          >
            Репозиторий проекта <ArrowUpRight size={14} />
          </a>
        </div>
      </div>
    </div>
  );
}
