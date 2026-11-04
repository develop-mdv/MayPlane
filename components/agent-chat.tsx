'use client';
import { useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import type { Server } from '@/lib/domain';
import {
  activeSession,
  providerNames,
  sessionLabels,
  type Hub,
  type AgentSession,
  type SessionDetail,
  type AgentApproval,
  type HubProject,
  type AgentProvider,
} from '@/lib/hub';
import { CopyButton, ErrorText, Field, Modal, Submit } from './hub-ui';
import { AgentModelSelector, ChatModelSettings } from './agent-model-selector';
import { AccountSelect } from './agent-accounts';
import { AgentLimitsControl } from './agent-limits';
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
              mode: provider === 'opencode' ? 'workspace-write' : mode,
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
            {(['codex', 'opencode'] as const).map((p) => (
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
            <ShieldCheck size={16} /> OpenCode запрашивает разрешение на
            инструменты. Разрешить можно одно действие за раз.
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
  disabled,
}: {
  session?: AgentSession;
  project?: HubProject;
  machine?: Server;
  hub: Hub;
  onNewProject: () => void;
  onNewSession: () => void;
  onAccounts: () => void;
  disabled: boolean;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null),
    [draft, setDraft] = useState(''),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    composer = useRef<HTMLTextAreaElement>(null);
  const current = useRef(session?.id);
  current.current = session?.id;
  const api = hub.api;
  function rememberDraft(text: string) {
    if (session) {
      let drafts = chatDrafts.get(api);
      if (!drafts) {
        drafts = new Map();
        chatDrafts.set(api, drafts);
      }
      if (text) drafts.set(session.id, text);
      else drafts.delete(session.id);
    }
    setDraft(text);
  }
  async function reload() {
    if (!session) return;
    const s = await api<SessionDetail>(`/hub/sessions/${session.id}`);
    if (current.current === s.id) {
      setDetail(s);
      setError('');
    }
  }
  useEffect(() => {
    setDetail(null);
    setDraft(session ? chatDrafts.get(api)?.get(session.id) || '' : '');
    setError('');
    follow.current = true;
    if (!session) return;
    let alive = true,
      loading = false;
    const poll = async () => {
      if (loading) return;
      loading = true;
      try {
        const s = await api<SessionDetail>(`/hub/sessions/${session.id}`);
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
      clearInterval(timer);
    };
  }, [session?.id, api]);
  useEffect(() => {
    if (follow.current)
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [detail]);
  const live = detail || session;
  async function send() {
    if (!session || !draft.trim() || sending || activeSession(live)) return;
    const text = draft;
    setSending(true);
    setError('');
    try {
      await hub.mutate(`/sessions/${session.id}/message`, { message: text });
      if (current.current === session.id) {
        rememberDraft('');
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
  const messages = detail?.messages || [];
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
        {!messages.length ? (
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
                      setDraft(text);
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
            {messages.map((m) => (
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
                    <RichText text={m.content} />
                    {m.role === 'assistant' && (
                      <div className="message-actions">
                        <CopyButton value={m.content} />
                      </div>
                    )}
                  </>
                )}
              </article>
            ))}
            {detail?.approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                session={detail}
                hub={hub}
                onDone={reload}
              />
            ))}
            {activeSession(live) && !detail?.approvals.length && (
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
            error={error || live?.authError || detail?.errorMessage || ''}
          />
          {live?.authError && (
            <button className="hub-button" type="button" onClick={onAccounts}>
              Подключить аккаунт в настройках
            </button>
          )}
          <form
            className={`chat-composer ${disabled || session.archived ? 'disabled' : ''}`}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={composer}
              rows={3}
              aria-label="Сообщение агенту"
              value={draft}
              maxLength={32000}
              placeholder={
                session.archived
                  ? 'Диалог в архиве'
                  : 'Опишите задачу, задайте вопрос или продолжите работу…'
              }
              disabled={disabled || session.archived}
              onChange={(e) => rememberDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
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
                  usage={detail?.usage}
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
                  disabled={
                    !draft.trim() || sending || disabled || session.archived
                  }
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
          <p className="composer-footnote">
            <span>
              <Folder size={12} />
              {session.cwd || project?.path || 'Без проекта'}
            </span>
            <span>Enter — отправить · Shift + Enter — новая строка</span>
          </p>
        </div>
      )}
    </div>
  );
}
