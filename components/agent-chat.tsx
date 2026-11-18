'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  AtSign,
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
  ShieldAlert,
  Settings2,
  ArrowUpRight,
  FileDiff,
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
  type HubService,
  type AgentProvider,
  type ServiceConversationBatch,
  type ServiceCustomizationDraft,
  type ChatMention,
} from '@/lib/hub';
import {
  attachServiceChatCommand,
  serviceChatBlock,
  serviceChatCommand,
  splitServiceChatCommand,
  suggestsServiceChatCommand,
} from '@/lib/service-chat.mjs';
import { serviceCustomizationBlock } from '@/lib/service-customization.mjs';
import { serviceChatLocation, serviceHasChat } from '@/lib/service-workspace.mjs';
import { harnessReport } from '@/lib/chat-harness.mjs';
import { CopyButton, ErrorText, Field, Modal, Submit } from './hub-ui';
import { AgentModelSelector, ChatModelSettings } from './agent-model-selector';
import { AccountSelect } from './agent-accounts';
import { AgentLimitsControl } from './agent-limits';
import {
  ServiceChatBatch,
  ServiceCommandSuggestion,
  ServiceCommandTag,
} from './service-chat';
import { ServiceCustomizationCard } from './service-customization';
import { PathField } from './path-picker';
import { ChatEditor, type ChatEditorHandle, type DraftMention } from './chat-editor';
import { MentionPicker, MentionTag, mentionOptions } from './chat-mentions';
import {
  inlineMentionRanges,
  isSshMachine,
  maxChatMentions,
  mentionQuery,
  mentionText,
  sshActions,
} from '@/lib/chat-references.mjs';

type ChatDraft = { text: string; mentions: DraftMention[] };
const chatDrafts = new WeakMap<object, Map<string, ChatDraft>>();
const chatCustomization = new WeakMap<object, Map<string, string>>();
const shiftMentions = (mentions: DraftMention[], offset: number) => offset
  ? mentions.map((mention) => ({ ...mention, start: mention.start + offset, end: mention.end + offset }))
  : mentions;

function ChatExecutionSwitch({
  label,
  hint,
  checked,
  disabled,
  risky = false,
  onClick,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  risky?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`chat-execution-switch${risky ? ' risky' : ''}`}
      title={hint}
      disabled={disabled}
      onClick={onClick}
    >
      {risky && <ShieldAlert size={13} aria-hidden="true" />}
      {label}
      <span className="chat-execution-track" aria-hidden="true" />
    </button>
  );
}

export function NewSession({
  hub,
  projects,
  machines,
  initialProject,
  initialMachine,
  service,
  onCreated,
  onClose,
  onAccounts,
}: {
  hub: Hub;
  projects: HubProject[];
  machines: Server[];
  initialProject?: string;
  initialMachine?: Server;
  service?: HubService;
  onCreated: (s: AgentSession) => void;
  onClose: () => void;
  onAccounts: () => void;
}) {
  const targetMachine = service ? machines.find((m) => m.id === service.machineId) : initialMachine;
  const allowHost = !!hub.data.capabilities?.hostSsh && isSshMachine(targetMachine);
  const [runOnHost, setRunOnHost] = useState(() => !!initialMachine && allowHost);
  const viaSsh = allowHost && runOnHost;
  const workingService = viaSsh ? undefined : service;
  const serviceLocation = service ? serviceChatLocation(
    service, projects, targetMachine?.platform,
  ) : null;
  const [projectId, setProjectId] = useState(initialProject || '');
  const [machineId, setMachineId] = useState(
    initialMachine?.id || projects.find((p) => p.id === initialProject)?.machineId ||
      hub.data.localMachineId ||
      machines.find((m) => ['online', 'needs_setup'].includes(m.status))?.id ||
      machines[0]?.id ||
      (hub.data.capabilities?.hostSsh ? '__local' : ''),
  );
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [cwd, setCwd] = useState('');
  const [modelCwd, setModelCwd] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setModelCwd(cwd.trim()), 450);
    return () => clearTimeout(timer);
  }, [cwd]);
  const [accountChoice, setAccountChoice] = useState('__default');
  const [model, setModel] = useState(''),
    [reasoning, setReasoning] = useState(''),
    [mode, setMode] = useState(
      initialProject ? 'workspace-write' : 'read-only',
    );
  const [loadingModels, setLoadingModels] = useState(false);
  const chatProject = viaSsh ? null : serviceLocation ? serviceLocation.projectId : projectId;
  const createOnHost = viaSsh || (!service && !chatProject && machineId === '__local');
  const chatMachine = createOnHost ? hub.data.localMachineId || '' : serviceLocation?.machineId ||
    projects.find((p) => p.id === projectId)?.machineId || machineId;
  const selectedMachine = machines.find((m) => m.id === chatMachine);
  const defaultAccount = (hub.data.accounts || []).find(
    (a) => a.id === selectedMachine?.agentAccounts?.[provider],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="Новый чат"
      description={service || initialMachine ? undefined : 'Начните чат в рабочей папке проекта или без проекта на выбранной машине.'}
      onClose={onClose}
    >
      <form
        className="hub-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const machineId = createOnHost && !chatMachine
              ? (await hub.mutate<Server>('/local')).id
              : chatMachine;
            const s = await hub.mutate<AgentSession>('/sessions', {
              ...(workingService ? { serviceId: workingService.id, serviceCwd: serviceLocation?.cwd } : {
                projectId: chatProject || null,
                ...(!chatProject && !viaSsh && cwd.trim() ? { cwd: cwd.trim() } : {}),
              }),
              ...(viaSsh && targetMachine ? { sshTarget: service
                ? { kind: 'service', id: service.id }
                : { kind: 'machine', id: targetMachine.id } } : {}),
              machineId,
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
        {allowHost && (
          <Field label="Где запустить агента">
            <select aria-label="Где запустить агента" value={viaSsh ? 'host' : 'machine'} onChange={(event) => {
              setRunOnHost(event.target.value === 'host');
              setAccountChoice('__default');
              setModel('');
              setReasoning('');
            }}>
              <option value="machine">На машине · {machines.find((m) => m.id === serviceLocation?.machineId)?.name || targetMachine?.name}</option>
              <option value="host">На хосте панели · доступ к цели по SSH</option>
            </select>
            {viaSsh && <small>Цель SSH будет доступна в чате. Действия, меняющие состояние сервиса, требуют подтверждения.</small>}
          </Field>
        )}
        {service || initialMachine ? (
          <div className="hub-field">
            <span>{service ? [service.name, targetMachine?.name].filter(Boolean).join(' · ') : initialMachine?.name}</span>
            <code>{viaSsh ? 'Домашний каталог на хосте' : serviceLocation?.cwd || 'Домашний каталог'}</code>
          </div>
        ) : <Field label="Проект">
          <select
            aria-label="Проект"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setCwd('');
              setModelCwd('');
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
        </Field>}
        {!service && !initialMachine && !projectId && (
          <>
          <Field label="Машина">
            <select
              aria-label="Машина"
              required
              value={machineId}
              onChange={(e) => {
                setMachineId(e.target.value);
                setCwd('');
                setModelCwd('');
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
              {hub.data.capabilities?.hostSsh && (!hub.data.localMachineId || machineId === '__local') && (
                <option value="__local">Хост панели</option>
              )}
            </select>
          </Field>
          <PathField api={hub.api} machineId={selectedMachine?.id} machineName={selectedMachine?.name} platform={selectedMachine?.platform}
            label="Рабочая папка · необязательно" hint="Если оставить пустым, чат начнётся в домашней папке на выбранной машине."
            value={cwd} onChange={(path) => { setCwd(path); setModel(''); setReasoning(''); }} />
          </>
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
          key={provider + ':' + (workingService?.id || chatProject || chatMachine) + ':' + accountChoice}
          hub={hub}
          machineId={chatMachine}
          provider={provider}
          projectId={chatProject || undefined}
          serviceId={workingService?.id}
          cwd={!chatProject && !service && !initialMachine ? modelCwd || undefined : undefined}
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

function RichText({
  text,
  mentions = [],
}: {
  text: string;
  mentions?: ChatMention[];
}) {
  const references = inlineMentionRanges(text, mentions);
  let offset = 0;
  const markup = references
    .map(({ start, end }) => {
      const prefix = text.slice(offset, start);
      offset = end;
      // A name can contain Markdown delimiters. Keep token offsets while parsing.
      return prefix + '\uFFFC'.repeat(end - start);
    })
    .join('') + text.slice(offset);
  function renderRange(start: number, end: number) {
    const parts = [];
    for (const mention of references) {
      if (mention.start < start || mention.end > end) continue;
      parts.push(
        text.slice(start, mention.start),
        <MentionTag key={mention.start} mention={mention} />,
      );
      start = mention.end;
    }
    return parts.length ? [...parts, text.slice(start, end)] : text.slice(start, end);
  }
  offset = 0;
  return (
    <div className="message-text">
      {markup.split(/(```[\s\S]*?```)/g).map((part, i) => {
        const start = offset;
        offset += part.length;
        if (part.startsWith('```')) {
          const codeEnd = offset - 3;
          const codeStart = Math.min(
            codeEnd,
            start + (part.match(/^```[^\n]*\n?/)?.[0].length ?? 3),
          );
          return (
            <div className="code-block" key={i}>
              <div>
                <span>{text.slice(start + 3, offset).split('\n')[0] || 'code'}</span>
                <CopyButton value={text.slice(codeStart, codeEnd)} />
              </div>
              <pre><code>{renderRange(codeStart, codeEnd)}</code></pre>
            </div>
          );
        }
        let inline = start;
        return (
          <span key={i}>
            {part
              .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
              .map((segment, index) => {
                const start = inline;
                inline += segment.length;
                if (segment.startsWith('`'))
                  return <code key={index}>{renderRange(start + 1, inline - 1)}</code>;
                if (segment.startsWith('**'))
                  return <strong key={index}>{renderRange(start + 2, inline - 2)}</strong>;
                return renderRange(start, inline);
              })}
          </span>
        );
      })}
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
  const ssh = a.kind === 'ssh' ? a.params.sshOperation : undefined;
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
          {ssh ? `${sshActions[ssh.action]} «${ssh.service}»?` : a.kind === 'input' ? 'Агенту нужен ваш ответ' : 'Запрос разрешения'}
        </strong>
        <span>Ожидает вас</span>
      </div>
      {ssh && <p>SSH · {ssh.machine} · <code>{ssh.address}</code> · <code>{ssh.source}</code></p>}
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
          {a.kind === 'ssh' || session.provider === 'codex' ? (
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
  machines,
  initialCustomizeServiceId,
  hub,
  onNewProject,
  onNewSession,
  onAccounts,
  onOpenService,
  onOpenChanges,
  disabled,
}: {
  session?: AgentSession;
  project?: HubProject;
  machine?: Server;
  machines: Server[];
  initialCustomizeServiceId?: string;
  hub: Hub;
  onNewProject: () => void;
  onNewSession: () => void;
  onAccounts: () => void;
  onOpenService: (id: string) => void;
  onOpenChanges: (turnId: string) => void;
  disabled: boolean;
}) {
  const api = hub.api;
  const sessionId = session?.id;
  const [customizeServiceId, setCustomizeServiceId] = useState(() => initialCustomizeServiceId ||
    (sessionId ? chatCustomization.get(api)?.get(sessionId) || '' : ''));
  const [detail, setDetail] = useState<SessionDetail | null>(null),
    [composition, setComposition] = useState<ChatDraft>(() => {
      const saved = (sessionId && chatDrafts.get(api)?.get(sessionId)) || { text: '', mentions: [] };
      const text = customizeServiceId ? splitServiceChatCommand(saved.text)?.content ?? saved.text : saved.text;
      return text === saved.text ? saved : { text, mentions: shiftMentions(saved.mentions, text.length - saved.text.length) };
    }),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false),
    [changingMode, setChangingMode] = useState(false);
  const [changingExecution, setChangingExecution] = useState(false);
  const [autoApproveDialog, setAutoApproveDialog] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const [caret, setCaret] = useState<number | null>(null);
  const [mentionSelection, setMentionSelection] = useState({ key: '', index: 0 });
  const commandMenuId = useId();
  const mentionMenuId = useId();
  const bottom = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    composer = useRef<ChatEditorHandle>(null);
  const mounted = useRef(false);
  const { text: draft, mentions } = composition;
  function rememberDraft(text: string, references: DraftMention[] = []) {
    const next = { text, mentions: references };
    if (sessionId) {
      let drafts = chatDrafts.get(api);
      if (!drafts) {
        drafts = new Map();
        chatDrafts.set(api, drafts);
      }
      if (text) drafts.set(sessionId, next);
      else drafts.delete(sessionId);
    }
    setComposition(next);
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
  useEffect(() => {
    if (!sessionId) return;
    let choices = chatCustomization.get(api);
    if (!choices) {
      if (!customizeServiceId) return;
      choices = new Map();
      chatCustomization.set(api, choices);
    }
    if (customizeServiceId) choices.set(sessionId, customizeServiceId);
    else choices.delete(sessionId);
  }, [api, customizeServiceId, sessionId]);
  const currentDetail = detail?.id === session?.id ? detail : null;
  const live = currentDetail || session;
  const drafting = !!live?.serviceDrafting;
  const harnessEnabled = live?.harnessEnabled === true;
  const autoApprove = live?.autoApprove === true;
  const chatBusy =
    disabled ||
    sending ||
    changingMode ||
    changingExecution ||
    activeSession(live) ||
    !!session?.archived;
  const command = splitServiceChatCommand(draft);
  const commandAttached = !!command?.separated;
  const serviceChatAvailable = !!hub.data.capabilities?.serviceChat;
  const mentionsAvailable = !!hub.data.capabilities?.chatMentions;
  const chatOnHost = session?.machineId === hub.data.localMachineId;
  const executionAvailable = !!hub.data.capabilities?.chatExecution;
  const customizationsAvailable = !!hub.data.capabilities?.serviceWorkspace;
  const availableServices = session && customizationsAvailable ? hub.data.services : [];
  const relatedServices = session
    ? availableServices.filter((service) => serviceHasChat(
        service, session, hub.data.projects,
        machines.find((item) => item.id === service.machineId)?.platform,
      ))
    : [];
  const otherServices = availableServices.filter((service) => !relatedServices.includes(service));
  const customizeService = availableServices.find((service) => service.id === customizeServiceId);
  const missingCustomization = !!customizeServiceId && !customizeService;
  const pinned = session?.sshTarget;
  const serviceLink = customizeService || relatedServices.find((service) =>
    service.id === session?.serviceId || (pinned?.kind === 'service' && pinned.id === service.id));
  const pinnedTarget = pinned?.kind === 'machine'
    ? machines.find((m) => m.id === pinned.id)
    : hub.data.services.find((s) => s.id === pinned?.id);
  const commandUnavailable = !!command && !serviceChatAvailable;
  const commandMenuOpen =
    composerFocused &&
    !commandsDismissed &&
    !disabled &&
    !session?.archived &&
    suggestsServiceChatCommand(draft);
  const draftContent = commandAttached && command ? command.content : draft;
  const draftOffset = draft.length - draftContent.length;
  const editorMentions = useMemo(() => shiftMentions(mentions, -draftOffset), [mentions, draftOffset]);
  const query = mentionsAvailable && caret !== null ? mentionQuery(draft, draftOffset + caret, mentions) : null;
  const mentionMenuOpen = !!query && composerFocused && !commandsDismissed && !disabled && !session?.archived;
  const mentionMatches = mentionMenuOpen
    ? mentionOptions(machines, hub.data.services, hub.data.projects, query.query, chatOnHost)
    : [];
  const queryKey = query ? `${query.start}:${query.query}` : '';
  const activeMention = mentionSelection.key === queryKey && mentionSelection.index < mentionMatches.length
    ? mentionSelection.index : 0;
  function chooseMention(option: (typeof mentionMatches)[number]) {
    if (!query) return;
    if (mentions.length >= maxChatMentions) {
      setError(`До ${maxChatMentions} упоминаний в сообщении`);
      setCommandsDismissed(true);
      return;
    }
    const text = mentionText(option.name);
    const rest = draft.slice(query.end);
    const suffix = !rest || /^[\p{L}\p{N}_@]/u.test(rest) ? ' ' : '';
    composer.current?.replace(query.start - draftOffset, query.end - draftOffset, suffix, { ...option, text });
    setCommandsDismissed(true);
  }
  function openMentions() {
    setCommandsDismissed(false);
    if (query) {
      composer.current?.focus();
      return;
    }
    const { start, end } = composer.current?.getSelection() ?? { start: draftContent.length, end: draftContent.length };
    const insert = start && !/[\s([{«]/u.test(draftContent[start - 1]) ? ' @' : '@';
    composer.current?.replace(start, end, insert);
  }
  function chooseCustomization(id: string) {
    setCustomizeServiceId(id);
    if (id && command) rememberDraft(command.content, editorMentions);
    composer.current?.focus();
  }
  function chooseCommand() {
    if (customizeServiceId) setCustomizeServiceId('');
    const next = attachServiceChatCommand(draft);
    rememberDraft(next, shiftMentions(mentions, next.length - draft.length));
    composer.current?.focus();
  }
  function removeCommand() {
    rememberDraft(draftContent, editorMentions);
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
  async function changeExecution(
    key: 'harnessEnabled' | 'autoApprove',
    value: boolean,
  ) {
    if (!session || disabled || session.archived || changingExecution) return;
    const enablingAuto = key === 'autoApprove' && value;
    setChangingExecution(true);
    setExecutionError('');
    try {
      const updated = await hub.mutate<AgentSession>(
        `/sessions/${session.id}/execution`,
        { [key]: value, ...(enablingAuto ? { confirmAutoApprove: true } : {}) },
        'PATCH',
      );
      setDetail((current) =>
        current?.id === updated.id
          ? {
              ...current,
              autoApprove: updated.autoApprove,
              harnessEnabled: updated.harnessEnabled,
            }
          : current,
      );
      if (enablingAuto) setAutoApproveDialog(null);
    } catch (reason) {
      setExecutionError((reason as Error).message);
    } finally {
      setChangingExecution(false);
    }
  }
  async function send() {
    if (!session || !draft.trim() || chatBusy || commandUnavailable || missingCustomization) return;
    const sent = composition;
    const savedDraft = chatDrafts.get(api)?.get(session.id);
    setSending(true);
    setError('');
    try {
      await hub.mutate(`/sessions/${session.id}/message`, {
        message: sent.text,
        ...(mentionsAvailable && sent.mentions.length ? {
          mentions: sent.mentions.map(({ kind, id, start, end }) => ({ kind, id, start, end })),
        } : {}),
        ...(customizeService ? { customizeServiceId: customizeService.id } : {}),
      });
      const drafts = chatDrafts.get(api);
      if (drafts && drafts.get(session.id) === savedDraft) drafts.delete(session.id);
      if (mounted.current) {
        setComposition((value) => (value === sent ? { text: '', mentions: [] } : value));
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
  const customizations = currentDetail?.serviceCustomizations || [];
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
  function renderCustomization(draft: ServiceCustomizationDraft) {
    return session && <ServiceCustomizationCard
      key={draft.id}
      draft={draft}
      sessionId={session.id}
      hub={hub}
      disabled={chatBusy}
      onOpen={onOpenService}
      onRefresh={reload}
    />;
  }
  return (
    <div className="chat-layout">
      {session && autoApproveDialog === session.id && (
        <Modal
          title="Включить автоаппрув?"
          description="Одноразовые запросы на команды, изменение файлов и расширение доступа будут одобряться автоматически. Эти действия могут затронуть данные и запущенные сервисы."
          onClose={() => {
            if (!changingExecution) setAutoApproveDialog(null);
          }}
        >
          <ErrorText error={executionError} />
          <div className="form-actions">
            <button
              className="hub-button"
              type="button"
              disabled={changingExecution}
              onClick={() => setAutoApproveDialog(null)}
            >
              Отмена
            </button>
            <button
              className="hub-button auto-approve-confirm"
              type="button"
              disabled={chatBusy}
              onClick={() => void changeExecution('autoApprove', true)}
            >
              {changingExecution ? 'Включаем…' : 'Включить для этого чата'}
            </button>
          </div>
        </Modal>
      )}
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
              const content = m.harnessOutput
                ? (harnessReport(m.content)?.text ?? m.content)
                : m.content;
              const text = m.serviceCustomizationOutput
                ? (serviceCustomizationBlock(content)?.text ?? content)
                : m.serviceOutput
                ? (serviceChatBlock(content)?.text ?? content)
                : content;
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
                      {text && <RichText text={text} mentions={m.mentions} />}
                      {m.role === 'user' && currentDetail?.changedTurns?.includes(m.id) && (
                        <button type="button" className="text-button chat-turn-changes" onClick={() => onOpenChanges(m.id)}>
                          <FileDiff size={14} /> Правки по этому запросу
                        </button>
                      )}
                      {batches
                        .filter((batch) => batch.messageId === m.id)
                        .map(renderServiceBatch)}
                      {customizations.filter((draft) => draft.messageId === m.id).map(renderCustomization)}
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
            {customizations.filter((draft) => !messageIds.has(draft.messageId)).map((draft) => (
              <article key={draft.id} className="chat-message assistant">
                {renderCustomization(draft)}
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
              missingCustomization ? 'Карточка недоступна из этого чата. Выберите другой сервис или сбросьте настройку.' : commandUnavailable
                ? 'Команда /services доступна после обновления серверной части MayPlane.'
                : error || live?.authError || currentDetail?.errorMessage || ''
            }
          />
          {live?.authError && (
            <button className="hub-button" type="button" onClick={onAccounts}>
              Подключить аккаунт в настройках
            </button>
          )}
          {autoApproveDialog !== session.id && <ErrorText error={executionError} />}
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
              <ChatEditor
                ref={composer}
                controls={mentionMenuOpen ? mentionMenuId : commandMenuOpen ? commandMenuId : undefined}
                activeDescendant={
                  mentionMenuOpen && mentionMatches.length ? `${mentionMenuId}-${activeMention}`
                    : commandMenuOpen ? commandMenuId + '-services' : undefined
                }
                text={draftContent}
                mentions={editorMentions}
                maxLength={32000 - draftOffset}
                placeholder={
                  session.archived
                    ? 'Диалог в архиве'
                    : customizeService
                      ? 'Что изменить в карточке «' + customizeService.name + '»?'
                    : drafting || commandAttached
                      ? 'Что оформить? Можно добавить ссылку на репозиторий…'
                      : mentionsAvailable ? 'Сообщение агенту. Введите @ для упоминаний или / для команд…'
                        : 'Сообщение агенту. Введите / для подсказок…'
                }
                disabled={disabled || session.archived}
                onFocus={() => {
                  setComposerFocused(true);
                  setCommandsDismissed(false);
                }}
                onBlur={() => setComposerFocused(false)}
                onCaret={setCaret}
                onChange={({ text, mentions }) => {
                  setCommandsDismissed(false);
                  if (customizeServiceId && splitServiceChatCommand(text)) setCustomizeServiceId('');
                  rememberDraft(
                    draft.slice(0, draftOffset) + text,
                    shiftMentions(mentions, draftOffset),
                  );
                }}
                onKeyDown={(e) => {
                  if ((commandMenuOpen || mentionMenuOpen) && e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setCommandsDismissed(true);
                    return;
                  }
                  if (mentionMenuOpen && mentionMatches.length) {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      const length = mentionMatches.length;
                      setMentionSelection({ key: queryKey,
                        index: (activeMention + (e.key === 'ArrowUp' ? -1 : 1) + length) % length,
                      });
                      return;
                    }
                    if (!e.shiftKey && (e.key === 'Enter' || e.key === 'Tab')) {
                      e.preventDefault();
                      chooseMention(mentionMatches[activeMention]);
                      return;
                    }
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
                    e.key === 'Backspace'
                  ) {
                    const selection = composer.current?.getSelection();
                    if (selection?.start === 0 && selection.end === 0) {
                      e.preventDefault();
                      removeCommand();
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {!session.archived && (
                <div className="composer-service-mode">
                  {mentionsAvailable && (
                    <button type="button" className="chat-service-trigger" title="Упомянуть сервер, сервис или проект"
                      aria-label="Упомянуть сервер, сервис или проект" aria-expanded={mentionMenuOpen}
                      disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={openMentions}>
                      <AtSign size={15} /> Упомянуть
                    </button>
                  )}
                  {pinned && !mentions.some(({ kind }) => kind !== 'project') && <span className="chat-ssh-target" title="Цель SSH по умолчанию">
                    <Terminal size={13} /> {pinnedTarget ? `SSH · ${pinnedTarget.name}` : 'Цель SSH недоступна'}
                  </span>}
                  <button
                    type="button"
                    className="chat-service-trigger"
                    title={'Добавить команду ' + serviceChatCommand}
                    disabled={disabled || !serviceChatAvailable}
                    onClick={chooseCommand}
                  >
                    <Boxes size={14} />
                    Оформить сервисы
                  </button>
                  {drafting && (
                    <button
                      type="button"
                      className="chat-service-trigger"
                      disabled={chatBusy || !serviceChatAvailable}
                      onClick={() => void changeServiceMode(false)}
                    >
                      {changingMode && <LoaderCircle size={14} className="spin" />}
                      Завершить оформление
                    </button>
                  )}
                  {(availableServices.length > 0 || missingCustomization) && (
                    <label className="composer-service-picker">
                      <Settings2 size={14} aria-hidden="true" />
                      <select
                        aria-label="Настроить карточку сервиса"
                        disabled={disabled}
                        value={customizeServiceId}
                        onChange={(event) => chooseCustomization(event.target.value)}
                      >
                        <option value="">Настроить сервис…</option>
                        {missingCustomization && <option value={customizeServiceId}>Карточка недоступна</option>}
                        {relatedServices.length > 0 && <optgroup label="Связанные с чатом">
                          {relatedServices.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
                        </optgroup>}
                        {otherServices.length > 0 && <optgroup label="Другие сервисы">
                          {otherServices.map((service) => (
                            <option key={service.id} value={service.id}>
                              {service.name} · {machines.find((item) => item.id === service.machineId)?.name || 'Машина недоступна'}
                            </option>
                          ))}
                        </optgroup>}
                      </select>
                    </label>
                  )}
                  {serviceLink && <button type="button" className="chat-service-trigger" onClick={() => onOpenService(serviceLink.id)}>
                    Карточка сервиса <ArrowUpRight size={13} />
                  </button>}
                  {executionAvailable && (
                    <>
                      <ChatExecutionSwitch
                        label="Harness²"
                        hint="Агент сравнит подходы, проверит выбранный вариант и учтёт наблюдения из этого чата."
                        checked={harnessEnabled}
                        disabled={chatBusy}
                        onClick={() =>
                          void changeExecution('harnessEnabled', !harnessEnabled)
                        }
                      />
                      <ChatExecutionSwitch
                        label="Автоаппрув"
                        hint={
                          autoApprove
                            ? 'Отключить автоматическое разрешение действий'
                            : 'Разрешать действия агента автоматически'
                        }
                        checked={autoApprove}
                        disabled={
                          disabled || changingExecution || (!autoApprove && chatBusy)
                        }
                        risky
                        onClick={() => {
                          if (autoApprove) void changeExecution('autoApprove', false);
                          else {
                            setExecutionError('');
                            setAutoApproveDialog(session.id);
                          }
                        }}
                      />
                    </>
                  )}
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
                  {(!autoApprove || session.provider === 'codex') && (
                    <span className="composer-mode">
                      <ShieldCheck size={13} />
                      {session.mode === 'read-only'
                        ? (autoApprove ? 'Песочница чтения' : 'Только чтение')
                        : (autoApprove ? 'Песочница проекта' : 'Права по запросу')}
                    </span>
                  )}
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
                    disabled={!draft.trim() || chatBusy || commandUnavailable || missingCustomization}
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
            {mentionMenuOpen && (
              <MentionPicker id={mentionMenuId} options={mentionMatches} active={activeMention} onSelect={chooseMention} />
            )}
          </div>
          <p className="composer-footnote">
            <span>
              <Folder size={12} />
              {session.cwd || project?.path || 'Без проекта'}
            </span>
            <span>
              {mentionMenuOpen && mentionMatches.length
                ? '↑ ↓ — выбрать · Enter — добавить · Esc — закрыть'
                : commandMenuOpen
                ? 'Enter — выбрать · Esc — закрыть'
                : 'Enter — отправить · Shift + Enter — новая строка'}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
