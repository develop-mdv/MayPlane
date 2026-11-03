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
  Copy,
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
  type AgentStatus,
} from '@/lib/hub';
import { CopyButton, ErrorText, Field, Modal, Submit } from './hub-ui';

export function NewSession({
  hub,
  projects,
  machines,
  initialProject,
  onCreated,
  onClose,
}: {
  hub: Hub;
  projects: HubProject[];
  machines: Server[];
  initialProject?: string;
  onCreated: (s: AgentSession) => void;
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(
    initialProject || projects[0]?.id || '',
  );
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [model, setModel] = useState(''),
    [mode, setMode] = useState('workspace-write');
  const [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="Новый диалог"
      description="Выберите проект и агента. Диалог будет выполняться на машине проекта."
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
              projectId,
              provider,
              model,
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
            required
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ·{' '}
                {machines.find((m) => m.id === p.machineId)?.name || 'Машина'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Агент">
          <div className="provider-options">
            {(['codex', 'opencode'] as const).map((p) => (
              <button
                className={provider === p ? 'selected' : ''}
                type="button"
                key={p}
                onClick={() => setProvider(p)}
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
        </Field>
        <Field
          label="Модель"
          hint="Пустое поле — модель из настроек агента на выбранной машине."
        >
          <input
            list="agent-model-options"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={
              provider === 'codex'
                ? 'По умолчанию у Codex'
                : 'provider/model — необязательно'
            }
            maxLength={120}
          />
          <datalist id="agent-model-options">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </datalist>
        </Field>
        {provider === 'codex' && (
          <button
            type="button"
            className="text-button"
            disabled={loadingModels || !projectId}
            onClick={async () => {
              setLoadingModels(true);
              setError('');
              try {
                const p = projects.find((p) => p.id === projectId);
                if (p) {
                  const result = await hub.api<AgentStatus>(
                    `/hub/machines/${p.machineId}/agents/codex`,
                  );
                  if (!result.installed)
                    throw new Error(
                      'Codex не запущен. Проверьте установку и вход в карточке машины.',
                    );
                  setModels(result.models);
                }
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setLoadingModels(false);
              }
            }}
          >
            {loadingModels ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <ChevronDown size={13} />
            )}
            Загрузить доступные модели с машины
          </button>
        )}
        {provider === 'codex' ? (
          <Field label="Доступ к проекту">
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="workspace-write">
                Изменения в проекте · дополнительные права по запросу
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
          <Submit busy={busy}>Создать диалог</Submit>
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
  disabled,
}: {
  session?: AgentSession;
  project?: HubProject;
  machine?: Server;
  hub: Hub;
  onNewProject: () => void;
  onNewSession: () => void;
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
    setDraft('');
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
        setDraft('');
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
                ? `${providerNames[session.provider]} работает в проекте ${project?.name || ''} на ${machine?.name || 'выбранной машине'}.`
                : 'Ваши агенты, проекты и машины. Один спокойный интерфейс.'}
            </p>
            {session ? (
              <div className="prompt-suggestions">
                {[
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
                ].map(({ icon: Icon, text, sub }) => (
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
          <ErrorText error={error} />
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
              onChange={(e) => setDraft(e.target.value)}
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
                <span className="composer-model">
                  {session.model || 'По умолчанию'}
                </span>
                <span className="composer-mode">
                  <ShieldCheck size={13} />
                  {session.mode === 'read-only'
                    ? 'Только чтение'
                    : 'Права по запросу'}
                </span>
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
              {project?.path}
            </span>
            <span>Enter — отправить · Shift + Enter — новая строка</span>
          </p>
        </div>
      )}
    </div>
  );
}
