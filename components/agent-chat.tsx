'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowUp,
  Square,
  Code2,
  Terminal,
  ChevronDown,
  ShieldCheck,
  Sparkles,
  Search,
  Bug,
  Folder,
  LoaderCircle,
  Boxes,
} from 'lucide-react';
import type { Server } from '@/lib/domain';
import {
  activeSession,
  providerNames,
  agentProviders,
  sessionLabels,
  type Hub,
  type AgentSession,
  type SessionDetail,
  type AgentApproval,
  type HubProject,
  type AgentProvider,
  type ServiceConversationBatch,
} from '@/lib/hub';
import {
  serviceChatBlock,
  serviceChatCommand,
  splitServiceChatCommand,
  suggestsServiceChatCommand,
} from '@/lib/service-chat.mjs';
import { CopyButton, ErrorText, Field, Modal, Submit } from './hub-ui';
import { AgentModelSelector, ChatModelSettings } from './agent-model-selector';
import { AccountSelect } from './agent-accounts';
import { AgentLimitsControl } from './agent-limits';
import {
  ServiceChatBatch,
  ServiceCommandSuggestion,
  ServiceCommandTag,
} from './service-chat';
const chatDrafts = new WeakMap<object, Map<string, string>>();

export function NewSession({
  hub,
  projects,
  machines,
  initialProject,
  onCreated,
  onClose,
  onAccounts,
}: {
  hub: Hub;
  projects: HubProject[];
  machines: Server[];
  initialProject?: string;
  onCreated: (s: AgentSession) => void;
  onClose: () => void;
  onAccounts: () => void;
}) {
  const [projectId, setProjectId] = useState(initialProject || '');
  const [machineId, setMachineId] = useState(
    projects.find((p) => p.id === initialProject)?.machineId ||
      machines.find((m) => ['online', 'needs_setup'].includes(m.status))?.id ||
      machines[0]?.id ||
      '',
  );
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [accountChoice, setAccountChoice] = useState('__default');
  const [model, setModel] = useState(''),
    [reasoning, setReasoning] = useState(''),
    [mode, setMode] = useState(
      initialProject ? 'workspace-write' : 'read-only',
    );
  const [loadingModels, setLoadingModels] = useState(false);
  const selectedMachine = machines.find(
    (m) =>
      m.id ===
      (projects.find((p) => p.id === projectId)?.machineId || machineId),
  );
  const defaultAccount = (hub.data.accounts || []).find(
    (a) => a.id === selectedMachine?.agentAccounts?.[provider],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="Новый чат"
      description="Начните чат в рабочей папке проекта или без проекта на выбранной машине."
      onClose={onClose}
    >
      <form
        className="hub-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const s = await hub.mutate<AgentSession>('/sessions', {
              projectId: projectId || null,
              machineId: projectId
                ? projects.find((p) => p.id === projectId)?.machineId
                : machineId,
              provider,
              ...(accountChoice === '__default'
                ? {}
                : { accountId: accountChoice || null }),
              model,
              reasoning,
              mode: provider !== 'codex' ? 'workspace-write' : mode,
            });
            onCreated(s);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Проект">
          <select
            aria-label="Проект"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setAccountChoice('__default');
              setModel('');
              setReasoning('');
              setMode(e.target.value ? 'workspace-write' : 'read-only');
            }}
          >
            <option value="">Без проекта</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ·{' '}
                {machines.find((m) => m.id === p.machineId)?.name || 'Машина'}
              </option>
            ))}
          </select>
        </Field>
        {!projectId && (
          <Field
            label="Машина"
            hint="Чат начнётся в домашнем каталоге пользователя агента. Проект можно выбрать позже."
          >
            <select
              aria-label="Машина"
              required
              value={machineId}
              onChange={(e) => {
                setMachineId(e.target.value);
                setAccountChoice('__default');
                setModel('');
                setReasoning('');
              }}
            >
              <option value="" disabled>
                Выберите машину
              </option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="hub-field">
          <span>Агент</span>
          <div className="provider-options">
            {agentProviders.map((p) => (
              <button
                className={provider === p ? 'selected' : ''}
                type="button"
                key={p}
                onClick={() => {
                  setProvider(p);
                  setAccountChoice('__default');
                  setModel('');
                  setReasoning('');
                }}
              >
                <Code2 size={20} />
                <strong>{providerNames[p]}</strong>
                <small>
                  {p === 'codex'
                    ? 'Ваш аккаунт ChatGPT / API'
                    : p === 'claude'
                      ? 'Anthropic API / аккаунт машины'
                      : 'Ваши провайдеры моделей'}
                </small>
              </button>
            ))}
          </div>
        </div>
        <AccountSelect
          hub={hub}
          provider={provider}
          value={accountChoice}
          defaultName={defaultAccount?.name || ''}
          onChange={(value) => {
            setAccountChoice(value);
            setModel('');
            setReasoning('');
          }}
        />
        <button className="text-button" type="button" onClick={onAccounts}>
          Добавить или настроить аккаунты
        </button>
        <AgentModelSelector
          key={provider + ':' + (projectId || machineId) + ':' + accountChoice}
          hub={hub}
          machineId={
            projects.find((p) => p.id === projectId)?.machineId || machineId
          }
          provider={provider}
          projectId={projectId || undefined}
          accountId={
            accountChoice === '__default' ? undefined : accountChoice || null
          }
          model={model}
          reasoning={reasoning}
          onLoading={setLoadingModels}
          onChange={(m, r) => {
            setModel(m);
            setReasoning(r);
          }}
        />
        <AgentLimitsControl
          hub={hub}
          machineId={selectedMachine?.id || ''}
          provider={provider}
          accountId={
            accountChoice === '__default'
              ? selectedMachine?.agentAccounts?.[provider] || null
              : accountChoice || null
          }
        />
        {provider === 'codex' ? (
          <Field label="Доступ к рабочей папке">
            <select
              aria-label="Доступ к рабочей папке"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="workspace-write">
                Изменения в рабочей папке · дополнительные права по запросу
              </option>
              <option value="read-only">
                Только чтение · для анализа и ревью
              </option>
            </select>
          </Field>
        ) : (
          <p className="hub-note">
            <ShieldCheck size={16} /> {providerNames[provider]} запрашивает
            разрешение на инструменты. Разрешить можно одно действие за раз.
          </p>
        )}
        <ErrorText error={error} />
        <div className="form-actions">
          <button className="hub-button" type="button" onClick={onClose}>
            Отмена
          </button>
          <Submit busy={busy || (loadingModels && !!model)}>Создать чат</Submit>
        </div>
      </form>
    </Modal>
  );
}

function RichText({ text }: { text: string }) {
  return (
    <div className="message-text">
      {text.split(/(```[\s\S]*?```)/g).map((part, i) =>
        part.startsWith('```') ? (
          <div className="code-block" key={i}>
            <div>
              <span>{part.slice(3).split('\n')[0] || 'code'}</span>
              <CopyButton
                value={part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}
              />
            </div>
            <pre>
              <code>
                {part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}
              </code>
            </pre>
          </div>
        ) : (
          <span key={i}>
            {part
              .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
              .map((s, j) =>
                s.startsWith('`') ? (
                  <code key={j}>{s.slice(1, -1)}</code>
                ) : s.startsWith('**') ? (
                  <strong key={j}>{s.slice(2, -2)}</strong>
                ) : (
                  s
                ),
              )}
          </span>
        ),
      )}
    </div>
  );
}
function ApprovalCard({
  approval: a,
  session,
  hub,
  onDone,
}: {
  approval: AgentApproval;
  session: AgentSession;
  hub: Hub;
  onDone: () => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function answer(decision?: string) {
    setBusy(true);
    try {
      await hub.mutate(`/sessions/${session.id}/approval`, {
        id: a.id,
        decision,
        answers,
      });
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="approval-card">
      <div className="approval-title">
        <ShieldCheck size={19} />
        <strong>
          {a.kind === 'input' ? 'Агенту нужен ваш ответ' : 'Запрос разрешения'}
        </strong>
        <span>Ожидает вас</span>
      </div>
      {a.params.reason && <p>{a.params.reason}</p>}
      {a.params.networkApprovalContext && (
        <p>
          Доступ к сети:{' '}
          <code>
            {a.params.networkApprovalContext.protocol}://
            {a.params.networkApprovalContext.host}
          </code>
        </p>
      )}
      {!!(
        a.params.command ||
        a.params.grantRoot ||
        a.params.toolCall ||
        a.params.changes
      ) && (
        <pre>
          {a.params.command
            ? Array.isArray(a.params.command)
              ? a.params.command.join(' ')
              : a.params.command
            : a.params.grantRoot ||
              JSON.stringify(a.params.toolCall || a.params.changes, null, 2)}
        </pre>
      )}
      {a.kind === 'input' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void answer();
          }}
        >
          {a.params.questions?.map((q) => (
            <Field label={q.question} key={q.id}>
              {q.options?.length ? (
                <select
                  required
                  value={answers[q.id] || ''}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                >
                  <option value="" disabled>
                    Выберите ответ
                  </option>
                  {q.options.map((o) => (
                    <option key={o.label} value={o.label}>
                      {o.label}
                      {o.description ? ' — ' + o.description : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  required
                  value={answers[q.id] || ''}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                />
              )}
            </Field>
          ))}
          <Submit busy={busy}>Ответить</Submit>
        </form>
      ) : (
        <div className="approval-actions">
          {session.provider === 'codex' ? (
            <>
              <button
                className="hub-button"
                disabled={busy}
                onClick={() => void answer('decline')}
              >
                Отклонить
              </button>
              <button
                className="hub-button primary"
                disabled={busy}
                onClick={() => void answer('accept')}
              >
                Разрешить один раз
              </button>
            </>
          ) : (
            a.params.options
              ?.filter((o) => ['allow_once', 'reject_once'].includes(o.kind))
              .map((o) => (
                <button
                  key={o.optionId}
                  disabled={busy}
                  className={`hub-button ${o.kind === 'allow_once' ? 'primary' : ''}`}
                  onClick={() => void answer(o.optionId)}
                >
                  {o.name}
                </button>
              ))
          )}
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

export function AgentChat({
  session,
  project,
  machine,
  hub,
  onNewProject,
  onNewSession,
  onAccounts,
  onOpenService,
  disabled,
}: {
  session?: AgentSession;
  project?: HubProject;
  machine?: Server;
  hub: Hub;
  onNewProject: () => void;
  onNewSession: () => void;
  onAccounts: () => void;
  onOpenService: (id: string) => void;
  disabled: boolean;
}) {
  const api = hub.api;
  const sessionId = session?.id;
  const [detail, setDetail] = useState<SessionDetail | null>(null),
    [draft, setDraft] = useState(() =>
      sessionId ? chatDrafts.get(api)?.get(sessionId) || '' : '',
    ),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false),
    [changingMode, setChangingMode] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const commandMenuId = useId();
  const bottom = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    composer = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  function rememberDraft(text: string) {
    if (sessionId) {
      let drafts = chatDrafts.get(api);
      if (!drafts) {
        drafts = new Map();
        chatDrafts.set(api, drafts);
      }
      if (text) drafts.set(sessionId, text);
      else drafts.delete(sessionId);
    }
    setDraft(text);
  }
  async function reload() {
    if (!sessionId) return;
    const s = await api<SessionDetail>(`/hub/sessions/${sessionId}`);
    if (mounted.current && s.id === sessionId) {
      setDetail(s);
      setError('');
    }
  }
  useEffect(() => {
    if (!sessionId) return;
    mounted.current = true;
    let alive = true;
    let loading = false;
    const poll = async () => {
      if (loading) return;
      loading = true;
      try {
        const s = await api<SessionDetail>(`/hub/sessions/${sessionId}`);
        if (alive) {
          setDetail(s);
          setError('');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 1200);
    return () => {
      alive = false;
      mounted.current = false;
      clearInterval(timer);
    };
  }, [sessionId, api]);
  useEffect(() => {
    if (follow.current)
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [detail]);
  const currentDetail = detail?.id === session?.id ? detail : null;
  const live = currentDetail || session;
  const drafting = !!live?.serviceDrafting;
  const chatBusy =
    disabled ||
    sending ||
    changingMode ||
    activeSession(live) ||
    !!session?.archived;
  const command = splitServiceChatCommand(draft);
  const commandAttached = !!command?.separated;
  const serviceChatAvailable = !!hub.data.capabilities?.serviceChat;
  const commandUnavailable = !!command && !serviceChatAvailable;
  const commandMenuOpen =
    composerFocused &&
    !commandsDismissed &&
    !disabled &&
    !session?.archived &&
    suggestsServiceChatCommand(draft);
  const draftContent = commandAttached && command ? command.content : draft;
  function chooseCommand() {
    rememberDraft(serviceChatCommand + ' ');
    composer.current?.focus();
  }
  function removeCommand() {
    rememberDraft(draftContent);
    composer.current?.focus();
  }
  async function changeServiceMode(active: boolean) {
    if (!session || chatBusy || !serviceChatAvailable) return;
    if (active === drafting) {
      composer.current?.focus();
      return;
    }
    setChangingMode(true);
    setError('');
    try {
      await api('/hub/sessions/' + session.id + '/service-drafts', 'PATCH', {
        active,
      });
      await reload();
      if (active && mounted.current) composer.current?.focus();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setChangingMode(false);
    }
  }
  async function send() {
    if (!session || !draft.trim() || chatBusy || commandUnavailable) return;
    const text = draft;
    setSending(true);
    setError('');
    try {
      await hub.mutate(`/sessions/${session.id}/message`, { message: text });
      const drafts = chatDrafts.get(api);
      if (drafts?.get(session.id) === text) drafts.delete(session.id);
      if (mounted.current) {
        setDraft((value) => (value === text ? '' : value));
        follow.current = true;
        await reload();
        composer.current?.focus();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  const messages = currentDetail?.messages || [];
  const batches = currentDetail?.serviceBatches || [];
  const messageIds = new Set(messages.map((message) => message.id));
  function renderServiceBatch(batch: ServiceConversationBatch) {
    return (
      session && (
        <ServiceChatBatch
          key={batch.id}
          batch={batch}
          sessionId={session.id}
          hub={hub}
          disabled={chatBusy}
          onRefresh={reload}
          onOpen={onOpenService}
          onRefine={() => void changeServiceMode(true)}
        />
      )
    );
  }
  return (
    <div className="chat-layout">
      {session?.nativeSource && (
        <div className="native-chat-notice">
          <span>
            Диалог машины · перед продолжением остановите ход в CLI или
            приложении. История перечитывается перед отправкой.
          </span>
          <button
            className="text-button"
            disabled={sending || activeSession(live) || disabled}
            onClick={async () => {
              setSending(true);
              try {
                await hub.mutate(`/sessions/${session.id}/sync`);
                await reload();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSending(false);
              }
            }}
          >
            Синхронизировать
          </button>
        </div>
      )}
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        {!messages.length && !batches.length ? (
          <div className="chat-welcome">
            <div className="welcome-mark">
              <Code2 size={32} />
            </div>
            <span className="eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</span>
            <h1>
              {session ? 'С чего начнём?' : 'От идеи до работающего кода.'}
            </h1>
            <p>
              {session
                ? `${providerNames[session.provider]} · ${project?.name || 'Без проекта'} · ${machine?.name || 'выбранная машина'}.`
                : 'Ваши агенты, проекты и машины. Один спокойный интерфейс.'}
            </p>
            {session ? (
              <div className="prompt-suggestions">
                {(session.projectId
                  ? [
                      {
                        icon: Search,
                        text: 'Разберись в архитектуре проекта',
                        sub: 'Структура, стек и точки входа',
                      },
                      {
                        icon: Bug,
                        text: 'Найди причину ошибок',
                        sub: 'Проверка и план исправления',
                      },
                      {
                        icon: Sparkles,
                        text: 'Предложи улучшения проекта',
                        sub: 'Идеи с учётом текущего кода',
                      },
                    ]
                  : [
                      {
                        icon: Sparkles,
                        text: 'Что ты умеешь?',
                        sub: 'Возможности агента и доступные инструменты',
                      },
                      {
                        icon: Search,
                        text: 'Помоги разобраться в задаче',
                        sub: 'Обсудим идею и составим план',
                      },
                      {
                        icon: Code2,
                        text: 'Объясни технический вопрос',
                        sub: 'Задайте вопрос без привязки к проекту',
                      },
                    ]
                ).map(({ icon: Icon, text, sub }) => (
                  <button
                    key={text}
                    disabled={disabled}
                    onClick={() => {
                      rememberDraft(text);
                      composer.current?.focus();
                    }}
                  >
                    <Icon size={18} />
                    <strong>{text}</strong>
                    <span>{sub}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="welcome-actions">
                <button
                  className="hub-button primary"
                  disabled={disabled}
                  onClick={onNewProject}
                >
                  <Folder size={17} />
                  Добавить проект
                </button>
                <button
                  className="hub-button"
                  disabled={disabled}
                  onClick={onNewSession}
                >
                  Начать диалог <ArrowUp size={16} />
                </button>
              </div>
            )}
            {!session && (
              <div className="welcome-providers">
                <span>
                  <span className="provider-dot codex" />
                  Codex
                </span>
                <span>
                  <span className="provider-dot opencode" />
                  OpenCode
                </span>
                <span className="muted">Любая ваша машина</span>
              </div>
            )}
          </div>
        ) : (
          <div className="conversation">
            {messages.map((m) => {
              const text = m.serviceOutput
                ? (serviceChatBlock(m.content)?.text ?? m.content)
                : m.content;
              return (
                <article key={m.id} className={`chat-message ${m.role}`}>
                  {m.role === 'tool' ? (
                    <details>
                      <summary>
                        <Terminal size={14} />
                        Действие агента
                        <ChevronDown size={13} />
                      </summary>
                      <pre>{m.content}</pre>
                    </details>
                  ) : (
                    <>
                      <div className="message-author">
                        {m.role === 'user'
                          ? 'Вы'
                          : m.role === 'system'
                            ? 'Система'
                            : providerNames[session!.provider]}
                        <time>
                          {new Date(m.createdAt).toLocaleTimeString('ru', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </div>
                      {m.role === 'user' &&
                        m.command === serviceChatCommand && (
                          <div className="message-command">
                            <ServiceCommandTag />
                          </div>
                        )}
                      {text && <RichText text={text} />}
                      {batches
                        .filter((batch) => batch.messageId === m.id)
                        .map(renderServiceBatch)}
                      {m.role === 'assistant' && text && (
                        <div className="message-actions">
                          <CopyButton value={text} />
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}
            {batches
              .filter((batch) => !messageIds.has(batch.messageId))
              .map((batch) => (
                <article key={batch.id} className="chat-message assistant">
                  {renderServiceBatch(batch)}
                </article>
              ))}
            {currentDetail?.approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                session={currentDetail}
                hub={hub}
                onDone={reload}
              />
            ))}
            {activeSession(live) && !currentDetail?.approvals.length && (
              <div className="agent-working">
                <LoaderCircle size={15} className="spin" />
                {live ? sessionLabels[live.status] : 'Подключение'}
                <span>Можно остановить в любой момент</span>
              </div>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>
      {session && (
        <div className="composer-area">
          <ErrorText
            error={
              commandUnavailable
                ? 'Команда /services доступна после обновления серверной части MayPlane.'
                : error || live?.authError || currentDetail?.errorMessage || ''
            }
          />
          {live?.authError && (
            <button className="hub-button" type="button" onClick={onAccounts}>
              Подключить аккаунт в настройках
            </button>
          )}
          <div className="composer-entry">
            <form
              className={`chat-composer ${disabled || session.archived ? 'disabled' : ''}${commandAttached ? ' with-command' : ''}`}
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {commandAttached && (
                <div className="composer-command-token">
                  <ServiceCommandTag onRemove={removeCommand} />
                </div>
              )}
              <textarea
                ref={composer}
                rows={3}
                aria-label="Сообщение агенту"
                aria-autocomplete="list"
                aria-controls={commandMenuOpen ? commandMenuId : undefined}
                aria-activedescendant={
                  commandMenuOpen ? commandMenuId + '-services' : undefined
                }
                value={draftContent}
                maxLength={
                  32000 - (commandAttached ? serviceChatCommand.length + 1 : 0)
                }
                placeholder={
                  session.archived
                    ? 'Диалог в архиве'
                    : drafting || commandAttached
                      ? 'Что оформить? Можно добавить ссылку на репозиторий…'
                      : 'Сообщение агенту. Введите / для подсказок…'
                }
                disabled={disabled || session.archived}
                onFocus={() => {
                  setComposerFocused(true);
                  setCommandsDismissed(false);
                }}
                onBlur={() => setComposerFocused(false)}
                onChange={(e) => {
                  setCommandsDismissed(false);
                  rememberDraft(
                    commandAttached
                      ? serviceChatCommand + ' ' + e.target.value
                      : e.target.value,
                  );
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (commandMenuOpen && e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setCommandsDismissed(true);
                    return;
                  }
                  if (
                    commandMenuOpen &&
                    !e.shiftKey &&
                    (e.key === 'Enter' || e.key === 'Tab')
                  ) {
                    e.preventDefault();
                    chooseCommand();
                    return;
                  }
                  if (
                    commandAttached &&
                    e.key === 'Backspace' &&
                    e.currentTarget.selectionStart === 0 &&
                    e.currentTarget.selectionEnd === 0
                  ) {
                    e.preventDefault();
                    removeCommand();
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {!session.archived && (
                <div className="composer-service-mode">
                  <button
                    type="button"
                    className="chat-service-trigger"
                    aria-pressed={drafting}
                    title={
                      drafting
                        ? 'Завершить оформление сервисов'
                        : 'Команда ' + serviceChatCommand
                    }
                    disabled={chatBusy || !serviceChatAvailable}
                    onClick={() => void changeServiceMode(!drafting)}
                  >
                    {changingMode ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Boxes size={14} />
                    )}
                    {drafting ? 'Оформление сервисов' : 'Оформить сервисы'}
                  </button>
                  {(drafting || commandAttached) && (
                    <span>
                      {providerNames[session.provider]} использует контекст
                      этого чата. Сюда же можно прислать ссылку на репозиторий.
                    </span>
                  )}
                </div>
              )}
              <div className="composer-toolbar">
                <div>
                  <span className={`provider-dot ${session.provider}`} />
                  <strong>{providerNames[session.provider]}</strong>
                  <ChatModelSettings
                    accountOnly
                    key={session.id + ':account'}
                    hub={hub}
                    session={live || session}
                    disabled={
                      disabled ||
                      sending ||
                      activeSession(live) ||
                      session.archived
                    }
                    onAccounts={onAccounts}
                  />
                  <ChatModelSettings
                    onAccounts={onAccounts}
                    key={session.id}
                    hub={hub}
                    session={live || session}
                    disabled={
                      disabled ||
                      sending ||
                      activeSession(live) ||
                      session.archived
                    }
                  />
                  <span className="composer-mode">
                    <ShieldCheck size={13} />
                    {session.mode === 'read-only'
                      ? 'Только чтение'
                      : 'Права по запросу'}
                  </span>
                  <AgentLimitsControl
                    key={`${session.id}:${live?.accountId || 'native'}`}
                    hub={hub}
                    machineId={session.machineId}
                    provider={session.provider}
                    accountId={live?.accountId || null}
                    sessionId={session.id}
                    usage={currentDetail?.usage}
                    disabled={disabled}
                  />
                </div>
                {activeSession(live) ? (
                  <button
                    type="button"
                    className="send-button stop"
                    aria-label="Остановить выполнение"
                    onClick={async () => {
                      try {
                        await hub.mutate(`/sessions/${session.id}/stop`);
                        await reload();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="submit"
                    disabled={!draft.trim() || chatBusy || commandUnavailable}
                    aria-label="Отправить сообщение"
                  >
                    {sending ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <ArrowUp size={20} />
                    )}
                  </button>
                )}
              </div>
            </form>
            {commandMenuOpen && (
              <ServiceCommandSuggestion
                id={commandMenuId}
                available={serviceChatAvailable}
                onSelect={chooseCommand}
              />
            )}
          </div>
          <p className="composer-footnote">
            <span>
              <Folder size={12} />
              {session.cwd || project?.path || 'Без проекта'}
            </span>
            <span>
              {commandMenuOpen
                ? 'Enter — выбрать · Esc — закрыть'
                : 'Enter — отправить · Shift + Enter — новая строка'}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
