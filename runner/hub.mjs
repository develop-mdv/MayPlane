import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import {
  claudeLoginUrl,
  isClaudeSubscription,
} from '../lib/claude-runtime.mjs';
import { AgentRpc } from './agent-rpc.mjs';
import { automaticApproval } from './agent-approvals.mjs';
import { unwrapHarnessInput, harnessReport } from '../lib/chat-harness.mjs';
import {
  beginHarnessTurn,
  finishHarnessTurn,
  recordHarnessEvidence,
} from './chat-harness.mjs';
import {
  machineProcess,
  localMetrics,
  projectPath,
  providers,
} from './machine-process.mjs';
import { attachConnectors } from './connectors.mjs';
import { connect, metrics } from './ssh.mjs';
import { assert, redact } from './security.mjs';
import { machineHome, separateServices } from './workspace-model.mjs';
import { createWorkspaceInspector } from './workspace-transport.mjs';
import {
  acpFileEdits,
  addAgentFileChanges,
  agentChangeSummaries,
  codexFileEdits,
  compareWorkspaceSnapshots,
} from './agent-file-changes.mjs';
import { agentVersion, agentError, claudeStatus } from './agent-status.mjs';
import { createAccounts } from './accounts.mjs';
import { connectorEndpoint } from '../lib/machine-connection.mjs';
import { createNativeSessions } from './native-sessions.mjs';
import { metricSample } from '../lib/machine-metrics.mjs';
import { createAgentLimits, sessionUsage } from './agent-limits.mjs';
import { createServices } from './services.mjs';
import { serviceCustomization } from './service-model.mjs';
import { addCustomizationDraft, customizationRevision, customizeServiceInput } from './service-customization.mjs';
import { serviceCustomizationBlock, unwrapServiceCustomizationInput } from '../lib/service-customization.mjs';
import { sameWorkspaceDirectory, serviceChatLocation } from '../lib/service-workspace.mjs';
import {
  serviceChatBlock,
  serviceChatCommand,
  serviceChatRequest,
  visibleServiceChatInput,
} from '../lib/service-chat.mjs';
import {
  addServiceConversationBatch,
  serviceConversationInput,
} from './service-conversation.mjs';
import {
  removalPlan,
  removalPreview,
  assertRemovalJobs,
  commitRemoval,
} from './workspace-delete.mjs';
import {
  createModelCatalog,
  codexModels,
  setAcpSelection,
  validateSelection,
} from './model-catalog.mjs';

const now = () => new Date().toISOString();
const authorizationError = (message = '') =>
  /401|unauthorized|authentication|not logged|sign.?in|авторизац/i.test(
    message,
  );
const signInHelp =
  'Сервис отклонил авторизацию. Проверьте выбранный аккаунт в настройках и повторите вход.';
const publicRecord = (record) => {
  const { secret: _secret, ...rest } = record;
  return rest;
};

export function createHub(
  server,
  store,
  {
    openProcess = machineProcess,
    resolveHome = machineHome,
    accountOptions = {},
    publicUrl = '',
    serviceOptions = {},
  } = {},
) {
  const connectors = attachConnectors(server, store);
  const inspect = createWorkspaceInspector(connectors);
  const connectorUrl = publicUrl ? connectorEndpoint(publicUrl) : null;
  const nativeSessions = createNativeSessions({ openProcess, connectors });
  const nativeChanges = new Set();
  const deletingSessions = new Set(),
    deletingProjects = new Set(),
    deletingMachines = new Set();
  const runtimes = new Map(),
    tasks = new Map(),
    refreshing = new Map();
  let closed = false;
  const modelCatalog = createModelCatalog({
    openProcess,
    connectors,
    isClosed: () => closed,
    prepareAccount: (...args) => accounts.prepare(...args),
    authenticateAccount: (...args) => accounts.authenticate(...args),
    refreshAccount: (...args) => accounts.refresh(...args),
  });
  const agentLimits = createAgentLimits({
    openProcess,
    connectors,
    prepareAccount: (...args) => accounts.prepare(...args),
    authenticateAccount: (...args) => accounts.authenticate(...args),
    refreshAccount: (...args) => accounts.refresh(...args),
  });
  const accounts = createAccounts(store, {
    openProcess,
    connectors,
    ...accountOptions,
    onChanged: (id) => {
      modelCatalog.invalidateAccount(id);
      agentLimits.invalidateAccount(id);
      for (const r of runtimes.values())
        if (
          r.accountId === id &&
          (!r.sessionId ||
            !['running', 'connecting', 'approval'].includes(
              load(r.sessionId, 'session').status,
            ))
        )
          r.rpc?.close();
    },
  });
  const modelChanges = new Set();
  const openingTasks = new Set();
  const records = (kind) =>
    store
      .list('settings')
      .filter((x) => x.recordType === kind)
      .map((x) =>
        kind === 'session'
          ? {
              ...x,
              title:
                store.get('settings', x.id).secret.title || x.title || 'Диалог',
            }
          : x,
      );
  const save = (record) => {
    if (['session', 'workspace', 'service'].includes(record.recordType)) {
      assert(
        !deletingMachines.has(record.machineId) &&
          store.get('servers', record.machineId),
        'Машина удалена или удаляется',
        409,
      );
      assert(
        !deletingSessions.has(record.id) && !deletingProjects.has(record.id),
        'Объект удаляется',
        409,
      );
      if (record.projectId)
        assert(
          !deletingProjects.has(record.projectId) &&
            store.get('settings', record.projectId)?.recordType === 'workspace',
          'Проект удалён или удаляется',
          409,
        );
    }
    if (record.recordType === 'session') {
      const { title, ...data } = record;
      store.save('settings', data, {
        ...record.secret,
        title: title || record.secret?.title || 'Диалог',
      });
    } else store.save('settings', record, record.secret || {});
  };
  const load = (id, kind) => {
    const record = store.get('settings', id);
    assert(record?.recordType === kind, 'Объект не найден', 404);
    if (kind === 'session')
      record.title = record.secret.title || record.title || 'Диалог';
    return record;
  };
  const machine = (id) => {
    assert(
      !deletingMachines.has(id),
      'Машина удаляется. Дождитесь завершения.',
      409,
    );
    assert(typeof id === 'string' && id, 'Выберите машину', 404);
    const m = store.get('servers', id);
    assert(m, 'Машина не найдена', 404);
    return m;
  };
  separateServices(store);
  const services = createServices({
    store, machine, save, accounts, openProcess, connectors, ...serviceOptions,
  });
  const sessions = () =>
    records('session').map((s) => ({
      ...s,
      cwd:
        s.cwd ||
        (s.projectId ? load(s.projectId, 'workspace').path : undefined),
    }));
  function locationForService(id) {
    const service = services.get(id);
    return serviceChatLocation(service, records('workspace'), machine(service.machineId).platform);
  }
  function customizationTarget(id) {
    const service = services.get(id);
    const selected = machine(service.machineId);
    return { service, selected };
  }
  // No turn is replayed after a runner restart. Native IDs remain resumable.
  for (const s of sessions())
    if (['running', 'connecting', 'approval'].includes(s.status)) {
      const full = load(s.id, 'session');
      full.status = 'interrupted';
      full.secret.approvals = [];
      full.secret.messages.push({
        id: randomUUID(),
        role: 'system',
        content:
          'Связь с агентом прервана при перезапуске панели. Проверьте результат перед продолжением.',
        createdAt: now(),
      });
      save(full);
    }
  for (const s of store.list('servers'))
    if (s.transport === 'connector' && s.status !== 'offline') {
      const m = machine(s.id);
      m.status = 'offline';
      saveMachine(m);
    }
  function saveMachine(m) {
    store.save('servers', m, m.secret || {});
  }
  function updateSession(id, update) {
    const session = load(id, 'session');
    update(session);
    session.updatedAt = now();
    save(session);
    return session;
  }
  function addMessage(
    id,
    role,
    content,
    itemId = randomUUID(),
    append = false,
    metadata,
  ) {
    if (!content) return;
    updateSession(id, (s) => {
      const found = s.secret.messages.find((m) => m.id === itemId);
      if (found) found.content = (append ? found.content : '') + content;
      else
        s.secret.messages.push({ id: itemId, role, content, createdAt: now() });
      s.secret.messages = s.secret.messages.slice(-2000);
      const last = s.secret.messages.find((m) => m.id === itemId);
      if (last) {
        last.content = last.content.slice(-262144);
        if (metadata) Object.assign(last, metadata);
      }
    });
  }
  function serviceTurnFor(runtime, params, turnId = params.turnId) {
    const turn = runtime.serviceTurn;
    if (!turn || (params.threadId && params.threadId !== runtime.nativeId))
      return null;
    return !turnId || !turn.id || turnId === turn.id ? turn : null;
  }
  function currentTurnEvent(runtime, params) {
    return (
      (!params.threadId || params.threadId === runtime.nativeId) &&
      (!params.turnId || !runtime.turnId || params.turnId === runtime.turnId) &&
      (!params.sessionId || params.sessionId === runtime.nativeId)
    );
  }
  function clearTurnTimer(runtime) {
    if (!runtime) return;
    clearTimeout(runtime.turnTimer);
    runtime.turnTimer = null;
  }
  function canUpdateSession(id) {
    if (closed || deletingSessions.has(id)) return false;
    const session = store.get('settings', id);
    return !!session && !deletingMachines.has(session.machineId) && !deletingProjects.has(session.projectId);
  }
  function recordWorkspaceChanges(runtime) {
    const turn = runtime?.changeTurn;
    if (!turn?.baseline || closed) return null;
    return (turn.recording ??= (async () => {
      try {
        const after = await inspect(machine(runtime.machineId), 'snapshot', { root: turn.cwd });
        const workspace = compareWorkspaceSnapshots(turn.baseline, after);
        if (workspace?.edits.length && canUpdateSession(runtime.sessionId))
          updateSession(runtime.sessionId, (s) => addAgentFileChanges(s.secret, turn, { workspace }));
      } catch {
        // File access is optional. The agent and its protocol reports still work.
      } finally {
        turn.baseline = null;
      }
    })());
  }
  function startTurnCompletion(runtime) {
    clearTurnTimer(runtime);
    runtime.finishingTurn = true;
    const recording = recordWorkspaceChanges(runtime);
    if (recording && canUpdateSession(runtime.sessionId) && load(runtime.sessionId, 'session').status === 'approval') {
      updateSession(runtime.sessionId, (s) => {
        s.status = 'running';
        s.secret.approvals = [];
      });
    }
    return recording;
  }
  function assistantMessage(runtime, params, text, id, append) {
    const turn = serviceTurnFor(runtime, params);
    const harness = currentTurnEvent(runtime, params) ? runtime.harnessTurn : null;
    const itemId = id || runtime.messageId || randomUUID();
    if (turn && text) turn.messages.add(itemId);
    if (harness && text) harness.messages.add(itemId);
    addMessage(runtime.sessionId, 'assistant', text, itemId, append, {
      ...(turn?.customization ? { serviceCustomizationOutput: true } : turn ? { serviceOutput: true } : {}),
      ...(harness ? { harnessOutput: true } : {}),
    });
  }
  function closeHarnessTurn(runtime, session, complete = false) {
    if (!runtime?.harnessTurn) return;
    finishHarnessTurn(
      session,
      runtime.harnessTurn,
      complete && !runtime.cancelled,
    );
    runtime.harnessTurn = null;
  }
  function finishServiceTurn(runtime, session, turn, complete, notice) {
    if (!turn || runtime.serviceTurn !== turn) return;
    runtime.serviceTurn = null;
    if (session.status === 'interrupted' || runtime.cancelled) return;
    if (complete && session.secret.messages.some((message) => turn.messages.has(message.id) && message.content.trim())) {
      if (turn.customization) {
        const { service, selected } = turn.customization;
        addCustomizationDraft(session, turn, (fields, previous) =>
          serviceCustomization(fields, selected, service.healthUrl, previous));
      } else {
        addServiceConversationBatch(session, turn.messages, (fields) => services.chatDraft(fields, session));
      }
      return;
    }
    const content = complete
      ? 'Агент завершил ход без ответа. Можно продолжить оформление следующим сообщением.'
      : notice;
    if (content) {
      session.secret.messages.push({ id: randomUUID(), role: 'system', content, createdAt: now() });
      session.secret.messages = session.secret.messages.slice(-2000);
    }
  }
  function onMessage(runtime, message) {
    const { method, params, id } = message;
    const p = params ?? {};
    if (
      method === 'account/rateLimits/updated' &&
      id === undefined &&
      runtime.limitsAuthenticated
    )
      agentLimits.update(
        runtime.machineId,
        runtime.provider,
        runtime.accountId,
        p,
      );
    if (method === 'account/updated' && runtime.limitsAuthenticated)
      agentLimits.invalidateMachine(runtime.machineId, runtime.provider);
    if (
      method === 'account/chatgptAuthTokens/refresh' &&
      id !== undefined &&
      runtime.accountId
    ) {
      void accounts.refresh(runtime.rpc, runtime.accountId, message);
      return;
    }
    if (!runtime.sessionId) {
      if (id !== undefined) runtime.rpc.reject(id);
      if (method === 'account/login/completed')
        runtime.login = { completed: true, success: p.success, error: p.error };
      return;
    }
    const sid = runtime.sessionId;
    if (!store.get('settings', sid) || deletingSessions.has(sid)) {
      if (id !== undefined) runtime.rpc?.reject(id);
      return;
    }
    if (runtime.replaying) {
      if (id !== undefined) runtime.rpc.reject(id);
      return;
    }
    if (id !== undefined) {
      if (runtime.cancelled || runtime.finishingTurn) return runtime.rpc.reject(id);
      const approval = runtime.provider === 'codex'
        ? ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)
        : method === 'session/request_permission';
      const input = method === 'item/tool/requestUserInput';
      if (!approval && !input) return runtime.rpc.reject(id);
      const session = load(sid, 'session');
      if (
        approval &&
        session.autoApprove === true &&
        !session.archived &&
        runtime.turnTimer &&
        ['running', 'approval'].includes(session.status) &&
        currentTurnEvent(runtime, p)
      ) {
        const response = automaticApproval(method, p);
        if (response) {
          runtime.autoApproved++;
          addMessage(
            sid,
            'system',
            `Автоматически одобрено действий · ${runtime.autoApproved}`,
            `${runtime.messageId}:auto-approval`,
          );
          return runtime.rpc.respond(id, response);
        }
      }
      updateSession(sid, (s) => {
        s.status = 'approval';
        s.secret.approvals.push({
          id: String(id),
          rpcId: id,
          method,
          params: p,
          kind: input ? 'input' : 'permission',
          createdAt: now(),
        });
      });
      return;
    }
    if (method === 'turn/started') {
      runtime.turnId = p.turn?.id;
      const turn = serviceTurnFor(runtime, p);
      if (turn) turn.id = runtime.turnId;
    }
    const changeTurn = runtime.turnTimer && !runtime.cancelled &&
      currentTurnEvent(runtime, p) ? runtime.changeTurn : null;
    if (changeTurn && method === 'turn/diff/updated' && typeof p.diff === 'string')
      updateSession(sid, (s) => addAgentFileChanges(s.secret, changeTurn, { aggregate: p.diff }));
    if (method === 'item/agentMessage/delta')
      assistantMessage(runtime, p, p.delta, p.itemId, true);
    if (method === 'item/completed' || method === 'item/started') {
      const item = p.item || {};
      if (item.type === 'agentMessage' && item.text)
        assistantMessage(runtime, p, item.text, item.id);
      if (item.type === 'commandExecution')
        addMessage(
          sid,
          'tool',
          `${item.command || ''}${item.aggregatedOutput ? '\n' + item.aggregatedOutput : ''}\n${item.status || ''}`,
          item.id,
        );
      if (
        method === 'item/completed' &&
        item.type === 'commandExecution' &&
        item.exitCode === 0 &&
        currentTurnEvent(runtime, p)
      ) recordHarnessEvidence(runtime.harnessTurn, item.aggregatedOutput);
      if (item.type === 'fileChange')
        addMessage(
          sid,
          'tool',
          JSON.stringify(item.changes || [], null, 2),
          item.id,
        );
      if (changeTurn && method === 'item/completed') {
        const edits = codexFileEdits(item);
        if (edits.length) updateSession(sid, (s) => addAgentFileChanges(s.secret, changeTurn, { edits }));
      }
    }
    if (method === 'item/commandExecution/outputDelta')
      addMessage(sid, 'tool', p.delta, p.itemId, true);
    if (method === 'turn/completed') {
      if (!runtime.turnTimer || runtime.cancelled) return;
      if (p.threadId && p.threadId !== runtime.nativeId) return;
      if (p.turn?.id && runtime.turnId && p.turn.id !== runtime.turnId) return;
      const turn = runtime.changeTurn;
      runtime.turnId = null;
      const recording = startTurnCompletion(runtime);
      const finish = () => {
        runtime.finishingTurn = false;
        if (!canUpdateSession(sid) || runtime.cancelled || runtime.changeTurn !== turn) return;
        runtime.changeTurn = null;
        updateSession(sid, (s) => {
          const outcome = p.turn?.status;
          closeHarnessTurn(runtime, s, outcome === 'completed' && s.status !== 'interrupted');
          finishServiceTurn(
            runtime,
            s,
            serviceTurnFor(runtime, p, p.turn?.id),
            outcome === 'completed',
            outcome !== 'interrupted' && !p.turn?.error?.message
              ? 'Агент не завершил оформление. Продолжите в этом чате.'
              : undefined,
          );
          s.status = outcome === 'completed' ? 'idle' : outcome === 'interrupted' ? 'interrupted' : 'error';
          s.secret.approvals = [];
          if (authorizationError(p.turn?.error?.message)) s.authError = signInHelp;
        });
        if (p.turn?.error?.message)
          addMessage(sid, 'system', authorizationError(p.turn.error.message) ? signInHelp : p.turn.error.message);
      };
      if (recording) void recording.then(finish);
      else finish();
    }
    if (method === 'serverRequest/resolved')
      updateSession(sid, (s) => {
        s.secret.approvals = s.secret.approvals.filter(
          (a) => a.id !== String(p.requestId),
        );
      });
    if (method === 'error' && !p.willRetry)
      addMessage(sid, 'system', p.error?.message || 'Ошибка агента');
    if (method === 'session/update') {
      const u = p.update || {};
      if (
        u.sessionUpdate === 'usage_update' &&
        !u._meta?.['opencode/child-session']
      ) {
        const usage = sessionUsage(u);
        if (usage)
          updateSession(sid, (s) => {
            s.secret.usage = usage;
          });
      }
      if (u.sessionUpdate === 'config_option_update')
        runtime.modelState = { configOptions: u.configOptions };
      if (
        u.sessionUpdate === 'agent_message_chunk' &&
        u.content?.type === 'text' &&
        (!(runtime.serviceTurn || runtime.harnessTurn) ||
          (!u._meta?.['opencode/child-session'] &&
            (!p.sessionId || p.sessionId === runtime.nativeId)))
      )
        assistantMessage(runtime, p, u.content.text, runtime.messageId, true);
      if (['tool_call', 'tool_call_update'].includes(u.sessionUpdate)) {
        addMessage(
          sid,
          'tool',
          JSON.stringify(
            {
              title: u.title,
              status: u.status,
              input: u.rawInput,
              content: u.content,
            },
            null,
            2,
          ),
          u.toolCallId,
        );
        if (changeTurn) {
          const edits = acpFileEdits(changeTurn, u);
          if (edits.length) updateSession(sid, (s) => addAgentFileChanges(s.secret, changeTurn, { edits }));
        }
      }
      if (
        runtime.harnessTurn &&
        ['tool_call', 'tool_call_update'].includes(u.sessionUpdate) &&
        u.status === 'completed' &&
        currentTurnEvent(runtime, p)
      ) {
        const output = typeof u.rawOutput === 'string'
          ? u.rawOutput
          : Array.isArray(u.content)
            ? u.content.map((entry) => entry?.content?.text || '').join('\n')
            : '';
        recordHarnessEvidence(runtime.harnessTurn, output);
      }
    }
  }
  async function runtimeFor(m, provider, session) {
    machine(m.id);
    assert(!closed, 'Исполнитель останавливается', 503);
    const accountId = session
      ? session.accountId || null
      : m.agentAccounts?.[provider] || null;
    if (accountId) accounts.connected(accountId, provider);
    const profileId = accountId
      ? session?.profileId || session?.id || accountId
      : session?.profileId;
    const key =
      session?.id || `account:${m.id}:${provider}:${accountId || 'native'}`;
    if (runtimes.has(key)) return runtimes.get(key);
    assert(
      runtimes.size < 16,
      'Открыто слишком много агентов. Завершите лишние диалоги.',
      429,
    );
    const runtime = {
      key,
      sessionId: session?.id,
      provider,
      machineId: m.id,
      accountId,
    };
    runtimes.set(key, runtime);
    runtime.ready = (async () => {
      if (provider === 'claude' && session && !accountId) {
        const auth = await claudeStatus(m, openProcess, connectors);
        assert(
          auth.ready,
          auth.error ||
            'Войдите с подпиской Claude в настройках аккаунтов или в карточке машины.',
          403,
        );
      }
      const cwd = session
        ? session.cwd ||
          (session.projectId
            ? load(session.projectId, 'workspace').path
            : await resolveHome(m))
        : undefined;
      runtime.cwd = cwd;
      if (accountId)
        runtime.releaseAccount = await accounts.prepare(
          m,
          provider,
          accountId,
          profileId,
        );
      const opened = await openProcess(
        m,
        {
          provider,
          operation: 'agent',
          cwd,
          nativeDesktop: !!session?.nativeSource,
          ...(profileId ? { profileId } : {}),
        },
        connectors,
      );
      if (closed || !store.get('servers', m.id) || deletingMachines.has(m.id)) {
        opened.close();
        throw new Error('Исполнитель останавливается');
      }
      runtime.rpc = new AgentRpc(opened);
      runtime.rpc.on('message', (msg) => onMessage(runtime, msg));
      runtime.rpc.on('disconnected', () => {
        const expected = runtime.managedClose;
        clearTurnTimer(runtime);
        runtimes.delete(key);
        if (runtime.releaseAccount)
          void releaseRuntime(runtime).catch(() => {});
        if (session && !expected && !runtime.finishingTurn && !runtime.cancelled && canUpdateSession(session.id)) {
          const finish = () => {
            runtime.changeTurn = null;
            if (!canUpdateSession(session.id)) return;
            updateSession(session.id, (s) => {
              closeHarnessTurn(runtime, s);
              if (['running', 'connecting', 'approval'].includes(s.status))
                s.status = 'interrupted';
              s.secret.approvals = [];
            });
          };
          const recording = recordWorkspaceChanges(runtime);
          if (recording) void recording.then(finish);
          else finish();
        }
      });
      try {
        if (provider === 'codex') {
          await runtime.rpc.request('initialize', {
            clientInfo: {
              name: 'mayplane',
              title: 'mayplane',
              version: '0.2.0',
            },
            ...(accountId || session?.nativeSource
              ? { capabilities: { experimentalApi: true } }
              : {}),
          });
          runtime.rpc.notify('initialized');
          if (accountId) await accounts.authenticate(runtime.rpc, accountId);
          runtime.limitsAuthenticated = true;
          if (session) {
            const auth = await runtime.rpc.request('account/read', {
              refreshToken: false,
            });
            assert(
              auth.account ||
                auth.requiresOpenaiAuth === false ||
                (session.nativeModelProvider &&
                  !['openai', 'openai_chatgpt_plan'].includes(
                    session.nativeModelProvider,
                  )),
              'Для Codex нужна авторизация. Добавьте аккаунт в Настройках и выберите его под полем сообщения.',
              403,
            );
            if (session.model || session.reasoning) {
              const catalog = await codexModels(runtime.rpc);
              validateSelection(
                catalog,
                session.model || '',
                session.reasoning || '',
              );
              runtime.defaultReasoning = catalog.models.find(
                (m) => m.id === session.model,
              )?.defaultReasoning;
            }
            const params = {
              ...(session.nativeModelProvider
                ? { modelProvider: session.nativeModelProvider }
                : {}),
              cwd,
              approvalPolicy: 'on-request',
              sandbox:
                session.mode === 'read-only' ? 'read-only' : 'workspace-write',
              ...(session.model ? { model: session.model } : {}),
            };
            const result = await runtime.rpc.request(
              session.nativeId ? 'thread/resume' : 'thread/start',
              {
                ...params,
                ...(session.nativeId ? { threadId: session.nativeId } : {}),
              },
            );
            runtime.nativeId = result.thread.id;
          }
        } else {
          const result = await runtime.rpc.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'mayplane', version: '0.2.0' },
          });
          if (session) {
            assert(
              !session.nativeId || result.agentCapabilities?.loadSession,
              'Эта версия агента не поддерживает возобновление. Обновите установку или создайте новый диалог.',
              409,
            );
            runtime.replaying = !!session.nativeId;
            const loaded = await runtime.rpc.request(
              session.nativeId ? 'session/load' : 'session/new',
              {
                cwd,
                mcpServers: [],
                ...(session.nativeId ? { sessionId: session.nativeId } : {}),
              },
            );
            runtime.replaying = false;
            runtime.nativeId = session.nativeId || loaded.sessionId;
            runtime.modelState = loaded;
            if (session.model || session.reasoning)
              await setAcpSelection(
                runtime.rpc,
                runtime,
                session.model || '',
                session.reasoning || '',
              );
          }
        }
        if (session && store.get('settings', session.id))
          updateSession(session.id, (s) => {
            s.nativeId = runtime.nativeId;
          });
      } catch (error) {
        runtime.rpc.close();
        throw error;
      }
      return runtime;
    })().catch(async (error) => {
      runtimes.delete(key);
      if (runtime.releaseAccount || runtime.cleanupPromise)
        await releaseRuntime(runtime).catch(() => {});
      throw Object.assign(
        new Error(
          error.status === 403
            ? error.message
            : `Не удалось подключить ${providers[provider].name}. Проверьте установку, вход и путь проекта. ${error.message}`,
        ),
        { status: error.status || 400 },
      );
    });
    return runtime;
  }
  async function releaseRuntime(runtime) {
    if (runtime.cleanupPromise) return runtime.cleanupPromise;
    const release = runtime.releaseAccount;
    runtime.releaseAccount = null;
    runtime.managedClose = true;
    runtime.rpc?.close();
    runtime.cleanupPromise = Promise.resolve().then(() => release?.());
    return runtime.cleanupPromise;
  }
  async function status(m, provider) {
    if (provider === 'claude')
      return claudeStatus(
        m,
        openProcess,
        connectors,
        m.agentAccounts?.claude
          ? accounts.connected(m.agentAccounts.claude, 'claude')
          : null,
      );
    const version = await agentVersion(m, provider, openProcess, connectors);
    if (!version.installed || provider !== 'codex')
      return { ...version, account: null, models: [] };
    try {
      if (provider === 'codex') {
        const r = await (await runtimeFor(m, provider)).ready;
        const account = await r.rpc.request('account/read', {
          refreshToken: false,
        });
        let catalog = { models: [] },
          catalogError;
        try {
          catalog = await codexModels(r.rpc);
        } catch (error) {
          catalogError = agentError(m, error.message);
        }
        return {
          ...version,
          ready: true,
          ...(catalogError
            ? { error: `Каталог моделей недоступен: ${catalogError}` }
            : {}),
          account: account.account
            ? {
                type: account.account.type,
                email: account.account.email,
                planType: account.account.planType,
              }
            : null,
          models: catalog.models,
          login: r.login || null,
        };
      }
    } catch (error) {
      return {
        ...version,
        ready: false,
        account: null,
        models: [],
        error: agentError(m, error.message),
      };
    }
  }
  function snapshot() {
    return {
      accounts: accounts.list(),
      tasks: [...tasks.values()]
        .filter((t) => t.status === 'running')
        .map(({ id, machineId, provider, operation, status }) => ({
          id,
          machineId,
          provider,
          operation,
          status,
        })),
      projects: records('workspace'),
      services: services.list(),
      capabilities: { serviceChat: true, chatExecution: true, serviceWorkspace: true },
      sessions: sessions().sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      providers: Object.entries(providers).map(([id, p]) => ({
        id,
        name: p.name,
      })),
      localMachineId: store.list('servers').find((s) => s.transport === 'local')
        ?.id,
      host: {
        name: os.hostname(),
        platform: process.platform,
        username: os.userInfo().username,
      },
      connection: { connectorUrl },
    };
  }
  async function syncNative(session, allowLegacy = false, mode) {
    assert(
      (session.nativeSource || allowLegacy) && !session.profileId,
      'Этот чат уже хранится в панели',
    );
    assert(
      !nativeChanges.has(session.id) &&
        !['running', 'connecting', 'approval'].includes(session.status),
      'Дождитесь завершения работы диалога',
      409,
    );
    nativeChanges.add(session.id);
    try {
      runtimes.get(session.id)?.rpc?.close();
      const data = await nativeSessions.read(
        machine(session.machineId),
        session.provider,
        session.nativeId,
        session.cwd,
      );
      return updateSession(session.id, (s) => {
        s.nativeSource = true;
        s.nativeModelProvider = data.modelProvider;
        if (!sameWorkspaceDirectory(s.cwd, data.cwd, machine(s.machineId).platform)) s.projectId = null;
        s.cwd = data.cwd;
        if (allowLegacy && s.provider === 'codex' && mode) s.mode = mode;
        let draftingTurn = false, harnessTurn = false, customizingTurn = false;
        s.secret.messages = data.messages.map((message) => {
          if (message.role === 'user') {
            const task = unwrapHarnessInput(message.content);
            harnessTurn = task !== null;
            const input = task ?? message.content;
            const customization = unwrapServiceCustomizationInput(input);
            customizingTurn = customization !== null;
            if (customizingTurn) {
              draftingTurn = false;
              return { ...message, content: customization };
            }
            const visible = visibleServiceChatInput(input);
            draftingTurn = visible.content !== input;
            return { ...message, ...visible };
          }
          if (message.role === 'assistant') {
            let content = harnessTurn
              ? (harnessReport(message.content)?.text ?? message.content)
              : message.content;
            if (customizingTurn) content = serviceCustomizationBlock(content)?.text ?? content;
            return {
              ...message,
              content,
              ...(draftingTurn && serviceChatBlock(content)
                ? { serviceOutput: true }
                : {}),
            };
          }
          return message;
        });
        s.secret.approvals = [];
        s.authError = null;
        s.secret.errorMessage = null;
        s.nativeSyncedAt = now();
      });
    } finally {
      nativeChanges.delete(session.id);
    }
  }
  async function sample(id) {
    if (refreshing.has(id)) return refreshing.get(id);
    const pending = sampleMachine(id);
    refreshing.set(id, pending);
    try {
      return await pending;
    } finally {
      if (refreshing.get(id) === pending) refreshing.delete(id);
    }
  }
  async function sampleMachine(id) {
    const m = machine(id);
    const identity = (value) =>
      JSON.stringify([
        value.host,
        value.port,
        value.username,
        value.fingerprint,
        value.secret,
      ]);
    const originalIdentity = identity(m);
    try {
      if (m.transport === 'connector')
        assert(connectors.connected(id), 'Компьютер отключён', 409);
      else {
        if (m.transport === 'local') Object.assign(m, localMetrics());
        else {
          const ssh = await connect(m);
          try {
            Object.assign(m, await metrics(ssh));
          } finally {
            ssh.end();
          }
        }
        const current = machine(id);
        assert(
          identity(current) === originalIdentity,
          'Параметры подключения изменились. Измерение пропущено.',
          409,
        );
        const measured = Object.fromEntries(
          [
            'cpu',
            'memory',
            'disk',
            'cpuCores',
            'memoryUsedBytes',
            'memoryTotalBytes',
            'memoryAvailableBytes',
            'diskUsedBytes',
            'diskTotalBytes',
            'diskAvailableBytes',
            'status',
            'platform',
            'ipv4',
            'ipv6',
            'uptime',
            'specs',
            'checkedAt',
            'networkRx',
            'networkTx',
            'homePath',
          ]
            .filter((k) => m[k] !== undefined)
            .map((k) => [k, m[k]]),
        );
        Object.assign(current, measured);
        current.history = [
          ...(current.history || []),
          metricSample(current),
        ].slice(-120);
        saveMachine(current);
      }
      void accounts.cleanupMachine(machine(id));
      return publicRecord(machine(id));
    } catch (error) {
      const current = machine(id);
      if (identity(current) === originalIdentity && error.status !== 409) {
        current.status = 'offline';
        current.cpu = null;
        current.memory = null;
        current.disk = null;
        current.checkedAt = now();
        saveMachine(current);
      }
      throw error;
    }
  }
  async function task(m, provider, operation) {
    assert(
      !openingTasks.has(m.id) &&
        ![...tasks.values()].some(
          (t) => t.machineId === m.id && t.status === 'running',
        ),
      'На машине уже выполняется установка или вход',
      409,
    );
    if (tasks.size > 40)
      for (const [id, t] of tasks) if (t.status !== 'running') tasks.delete(id);
    openingTasks.add(m.id);
    let p;
    try {
      p = await openProcess(m, { provider, operation }, connectors);
    } finally {
      openingTasks.delete(m.id);
    }
    const t = {
      id: randomUUID(),
      machineId: m.id,
      provider,
      operation,
      status: 'running',
      output: '',
      createdAt: now(),
      process: p,
      secrets: [],
    };
    tasks.set(t.id, t);
    const finish = (code) => {
      if (t.status !== 'running') return;
      clearTimeout(t.timer);
      t.status = code === 0 ? 'success' : 'error';
      if (code === 0 && ['install', 'login', 'logout'].includes(operation)) {
        for (const r of runtimes.values())
          if (r.machineId === m.id && r.provider === provider) r.rpc?.close();
        modelCatalog.invalidate(m.id, provider);
        accounts.invalidateMachine(m.id);
        agentLimits.invalidateMachine(m.id, provider);
      }
      p.close();
    };
    let terminalOutput = '';
    const capture = (bytes) => {
      if (provider === 'claude')
        terminalOutput = (terminalOutput + bytes.toString()).slice(-65536);
      t.output = redact(
        provider === 'claude'
          ? stripVTControlCharacters(terminalOutput)
          : t.output + bytes.toString(),
        [...Object.values(m.secret || {}), ...t.secrets],
      ).slice(-32768);
      if (provider === 'claude' && operation === 'login')
        t.loginUrl = claudeLoginUrl(terminalOutput) || t.loginUrl;
    };
    p.stdout.on('data', capture);
    p.stderr.on('data', capture);
    p.events.on('close', finish);
    p.events.on('error', () => {
      t.output +=
        '\nНе удалось запустить процесс. Проверьте соединение, путь и установку агента.';
      finish(1);
    });
    t.timer = setTimeout(
      () => {
        t.output +=
          '\nОперация не завершилась за 10 минут. Проверьте соединение и повторите.';
        finish(1);
      },
      10 * 60 * 1000,
    );
    t.timer.unref();
    return { id: t.id };
  }
  async function removeObject(plan, body) {
    assert(body.confirm === true, 'Подтвердите удаление из панели');
    if (
      plan.kind === 'machine' &&
      (plan.chats.length || plan.projects.length || plan.services.length)
    )
      assert(
        body.confirmName === plan.name,
        'Введите название машины для подтверждения удаления связанных данных',
      );
    if (body.revision !== undefined)
      assert(
        body.revision === plan.revision,
        'Состав объекта изменился. Закройте окно и подтвердите удаление заново.',
        409,
      );
    const changedSessions = plan.chats;
    assert(
      !changedSessions.some(
        (s) =>
          deletingSessions.has(s.id) ||
          nativeChanges.has(s.id) ||
          modelChanges.has(s.id) ||
          ['running', 'connecting', 'approval'].includes(s.status),
      ),
      'Сначала остановите активные чаты и дождитесь синхронизации',
      409,
    );
    assert(
      !changedSessions.some((s) => {
        const runtime = runtimes.get(s.id);
        return runtime && !runtime.rpc;
      }),
      'Дождитесь завершения подключения агента после остановки',
      409,
    );
    assert(
      !plan.projects.some((p) => deletingProjects.has(p.id)) &&
        !deletingMachines.has(plan.id),
      'Объект уже удаляется',
      409,
    );
    assertRemovalJobs(store, plan);
    if (plan.kind === 'machine') {
      assert(
        !openingTasks.has(plan.id) &&
          ![...tasks.values()].some(
            (t) => t.machineId === plan.id && t.status === 'running',
          ),
        'Сначала завершите установку или вход агента на машине',
        409,
      );
      assert(
        ![...nativeChanges].some((key) => {
          try {
            return JSON.parse(key)[0] === plan.id;
          } catch {
            return false;
          }
        }),
        'Дождитесь подключения истории с машины',
        409,
      );
    }
    for (const s of changedSessions) deletingSessions.add(s.id);
    for (const p of plan.projects) deletingProjects.add(p.id);
    if (plan.kind === 'machine') deletingMachines.add(plan.id);
    try {
      for (const runtime of [...runtimes.values()].filter(
        (r) =>
          changedSessions.some((s) => s.id === r.sessionId) ||
          (plan.kind === 'machine' && r.machineId === plan.id),
      )) {
        runtime.cancelled = true;
        await releaseRuntime(runtime).catch(() => {});
        runtimes.delete(runtime.key);
      }
      // Re-read credential targets: closing a runtime may just have saved rotated OAuth credentials.
      const current = removalPlan(store, plan.kind, plan.id, {
        deleteChats: plan.deleteChats,
      });
      assert(
        current.revision === plan.revision,
        'Состав объекта изменился. Закройте окно и подтвердите удаление заново.',
        409,
      );
      assertRemovalJobs(store, current);
      if (plan.kind === 'machine')
        assert(
          !current.targets.some((t) => t.credentialPresent) ||
            body.allowUnclearedCredentials === true,
          'На машине остаются копии доступа к агентам. Подключите её и отключите аккаунты либо подтвердите удаление без очистки профилей.',
          409,
        );
      store.db.exec('BEGIN IMMEDIATE');
      let result;
      try {
        result = commitRemoval(store, current);
        store.db.exec('COMMIT');
      } catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
      }
      services.forgetServices(result.deletedServices);
      if (plan.kind === 'machine') {
        services.forgetMachine(plan.id);
        connectors.revoke(plan.id);
        for (const provider of Object.keys(providers))
          modelCatalog.invalidate(plan.id, provider);
        agentLimits.invalidateMachine(plan.id);
        accounts.invalidateMachine(plan.id);
        for (const [id, t] of tasks)
          if (t.machineId === plan.id) tasks.delete(id);
      } else if (current.targets.some((t) => t.credentialPresent)) {
        const m = store.get('servers', current.chats[0]?.machineId);
        if (m) void accounts.cleanupMachine(m).catch(() => {});
      }
      return result;
    } finally {
      for (const s of changedSessions) deletingSessions.delete(s.id);
      for (const p of plan.projects) deletingProjects.delete(p.id);
      if (plan.kind === 'machine') deletingMachines.delete(plan.id);
    }
  }
  async function handle(path, method, body, send) {
    if (!path.startsWith('/api/hub')) return false;
    const browse = path.match(/^\/api\/hub\/machines\/([a-f0-9-]+)\/files\/(browse|roots)$/);
    if (browse && method === 'POST') {
      send(await inspect(machine(browse[1]), browse[2], body));
      return true;
    }
    const files = path.match(/^\/api\/hub\/(projects|sessions)\/([a-f0-9-]+)\/files\/(tree|file|git|patch)$/);
    if (files && method === 'POST') {
      const [, kind, id, operation] = files;
      const work = load(id, kind === 'projects' ? 'workspace' : 'session');
      const m = machine(work.machineId);
      assert(!deletingSessions.has(id) && !deletingProjects.has(id), 'Рабочая папка удаляется из панели', 409);
      const root = work.path || work.cwd || (work.projectId
        ? load(work.projectId, 'workspace').path : await resolveHome(m));
      send(await inspect(m, operation, { ...body, root }));
      return true;
    }
    const history = path.match(/^\/api\/hub\/sessions\/([a-f0-9-]+)\/changes(?:\/([a-f0-9-]+))?$/);
    if (history && method === 'GET') {
      const { secret } = load(history[1], 'session');
      if (history[2]) {
        const turn = secret.fileChanges?.find((item) => item.id === history[2]);
        assert(turn, 'Отчёт об изменениях больше не доступен', 404);
        send(turn);
      } else send({ turns: agentChangeSummaries(secret) });
      return true;
    }
    const removal = path.match(
      /^\/api\/hub\/removals\/(chat|project|service|machine)\/([a-f0-9-]+)$/,
    );
    if (removal && ['GET', 'DELETE'].includes(method)) {
      const plan = removalPlan(store, removal[1], removal[2], {
        deleteChats: body.deleteChats === true,
      });
      if (method === 'GET') send(removalPreview(plan));
      else send(await removeObject(plan, body));
      return true;
    }
    if (await accounts.handle(path, method, body, send)) return true;
    if (await services.handle(path, method, body, send)) return true;
    if (path === '/api/hub' && method === 'GET') {
      send(snapshot());
      return true;
    }
    if (
      ['/api/hub/local', '/api/hub/host'].includes(path) &&
      method === 'POST'
    ) {
      assert(
        body.name === undefined ||
          (typeof body.name === 'string' &&
            body.name.trim() &&
            body.name.length <= 64),
        'Название хоста: от 1 до 64 символов',
      );
      let m = store.list('servers').find((s) => s.transport === 'local');
      if (!m) {
        m = {
          id: randomUUID(),
          name: body.name?.trim() || `Хост панели · ${os.hostname()}`,
          host: '127.0.0.1',
          port: 0,
          username: os.userInfo().username,
          region: 'Хост панели',
          transport: 'local',
          ...localMetrics(),
        };
        saveMachine(m);
      }
      send(m, 201);
      return true;
    }
    if (path === '/api/hub/pair' && method === 'POST') {
      send(connectors.pair(body.name), 201);
      return true;
    }
    const nativeMatch = path.match(
      /^\/api\/hub\/machines\/([a-f0-9-]+)\/agents\/(codex|opencode|claude)\/native-sessions$/,
    );
    if (nativeMatch && method === 'POST') {
      const m = machine(nativeMatch[1]);
      const result = await nativeSessions.list(m, nativeMatch[2], {
        cursor: body.cursor || null,
        cwd: body.cwd,
      });
      send({
        ...result,
        sessions: result.sessions.map((s) => ({
          ...s,
          importedSessionId:
            sessions().find(
              (r) =>
                r.machineId === m.id &&
                r.provider === nativeMatch[2] &&
                r.nativeId === s.nativeId &&
                r.nativeSource &&
                !r.profileId,
            )?.id || null,
        })),
      });
      return true;
    }
    if (path === '/api/hub/sessions/import' && method === 'POST') {
      assert(
        body.mode === undefined ||
          ['read-only', 'workspace-write'].includes(body.mode),
        'Некорректный режим доступа',
      );
      const m = machine(body.machineId),
        provider = body.provider;
      assert(
        body.stopped === true,
        'Завершите активный ход в исходном приложении и подтвердите переход',
      );
      const key = JSON.stringify([m.id, provider, body.nativeId]);
      assert(!nativeChanges.has(key), 'Этот диалог уже подключается', 409);
      nativeChanges.add(key);
      try {
        const existing = sessions().find(
          (s) =>
            s.machineId === m.id &&
            s.provider === provider &&
            s.nativeId === body.nativeId &&
            !s.profileId,
        );
        if (existing) {
          assert(
            !['running', 'connecting', 'approval'].includes(existing.status),
            'Диалог уже выполняется в панели',
            409,
          );
          send(
            publicRecord(
              await syncNative(
                {
                  ...load(existing.id, 'session'),
                  cwd: body.cwd || existing.cwd,
                },
                true,
                body.mode,
              ),
            ),
          );
          return true;
        }
        const data = await nativeSessions.read(
          m,
          provider,
          body.nativeId,
          body.cwd,
        );
        const project = records('workspace').find(
          (p) => p.machineId === m.id && sameWorkspaceDirectory(p.path, data.cwd, m.platform),
        );
        const session = {
          id: randomUUID(),
          recordType: 'session',
          machineId: m.id,
          provider,
          projectId: project?.id || null,
          cwd: data.cwd,
          nativeId: data.nativeId,
          nativeModelProvider: data.modelProvider,
          accountId: null,
          model: '',
          reasoning: '',
          mode:
            provider === 'codex' ? body.mode || 'read-only' : 'workspace-write',
          title: data.title,
          customTitle: true,
          nativeSource: true,
          nativeSyncedAt: now(),
          status: 'idle',
          archived: false,
          createdAt: now(),
          updatedAt: now(),
          secret: { messages: data.messages, approvals: [] },
        };
        save(session);
        send(publicRecord(session), 201);
        return true;
      } finally {
        nativeChanges.delete(key);
      }
    }
    const pairing = path.match(/^\/api\/hub\/pair\/([a-f0-9-]+)$/);
    if (pairing && ['GET', 'DELETE'].includes(method)) {
      send(connectors.pairStatus(pairing[1], method === 'DELETE'));
      return true;
    }
    if (path === '/api/hub/projects' && method === 'POST') {
      const m = machine(body.machineId);
      assert(
        typeof body.name === 'string' &&
          body.name.trim() &&
          body.name.length <= 80,
        'Укажите название проекта',
      );
      const path = projectPath(body.path, m.platform || 'linux');
      assert(
        !records('workspace').some(
          (p) => p.machineId === m.id && sameWorkspaceDirectory(p.path, path, m.platform),
        ),
        'Этот каталог уже добавлен',
        409,
      );
      const project = {
        id: randomUUID(),
        recordType: 'workspace',
        name: body.name.trim(),
        machineId: m.id,
        path,
        repo: String(body.repo || '').slice(0, 500),
        createdAt: now(),
      };
      if (project.repo) {
        const url = new URL(project.repo);
        assert(
          url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash,
          'Репозиторий: HTTPS URL без секретов',
        );
      }
      save(project);
      send(project, 201);
      return true;
    }
    const projectMatch = path.match(/^\/api\/hub\/projects\/([a-f0-9-]+)$/);
    if (projectMatch && method === 'PATCH') {
      const p = load(projectMatch[1], 'workspace');
      assert(
        typeof body.name === 'string' &&
          body.name.trim() &&
          body.name.length <= 80,
        'Название проекта: от 1 до 80 символов',
      );
      p.name = body.name.trim();
      save(p);
      send(p);
      return true;
    }
    if (projectMatch && method === 'DELETE') {
      const deleteChats = body.deleteChats === true;
      const result = await removeObject(
        removalPlan(store, 'project', projectMatch[1], { deleteChats }),
        deleteChats ? body : { ...body, confirm: true },
      );
      send(deleteChats ? result : { ok: true });
      return true;
    }
    if (path === '/api/hub/sessions' && method === 'POST') {
      const location = body.serviceId ? locationForService(body.serviceId) : null;
      const projectId = location ? location.projectId : body.projectId;
      const p = projectId ? load(projectId, 'workspace') : null;
      const m = machine(location?.machineId || p?.machineId || body.machineId);
      if (location && Object.hasOwn(body, 'serviceCwd'))
        assert(body.serviceCwd === location.cwd || sameWorkspaceDirectory(body.serviceCwd, location.cwd, m.platform),
          'Рабочая папка сервиса изменилась. Откройте создание чата ещё раз.', 409);
      const accountId = Object.hasOwn(body, 'accountId')
        ? body.accountId
        : m.agentAccounts?.[body.provider] || null;
      if (accountId) accounts.connected(accountId, body.provider);
      if ((p || location) && body.machineId)
        assert(
          m.id === body.machineId,
          'Рабочая папка находится на другой машине',
        );
      assert(providers[body.provider], 'Выберите агента');
      assert(
        ['read-only', 'workspace-write'].includes(
          body.mode || 'workspace-write',
        ),
        'Выберите режим',
      );
      assert(
        body.provider === 'codex' || body.mode !== 'read-only',
        'Для этого агента используйте его штатные подтверждения инструментов',
      );
      const session = {
        id: randomUUID(),
        recordType: 'session',
        projectId: p?.id || null,
        machineId: m.id,
        ...(location ? { serviceId: body.serviceId } : {}),
        cwd: projectPath(p?.path || location?.cwd || (!location && body.cwd) || (await resolveHome(m)), m.platform || 'linux'),
        provider: body.provider,
        accountId: accountId || null,
        mode:
          body.mode ||
          (!p && body.provider === 'codex' ? 'read-only' : 'workspace-write'),
        model: body.model ?? '',
        reasoning: body.reasoning ?? '',
        title: 'Новый чат',
        status: 'idle',
        archived: false,
        createdAt: now(),
        updatedAt: now(),
        secret: { messages: [], approvals: [] },
      };
      if (session.accountId) session.profileId = session.id;
      if (session.model || session.reasoning) {
        const catalog = await modelCatalog.get(
          m,
          session.provider,
          session.cwd,
          { model: session.model, accountId: session.accountId },
        );
        validateSelection(catalog, session.model, session.reasoning);
      } else
        validateSelection({ models: [] }, session.model, session.reasoning);
      if (location) assert(JSON.stringify(locationForService(body.serviceId)) === JSON.stringify(location),
        'Рабочая папка сервиса изменилась. Откройте создание чата ещё раз.', 409);
      save(session);
      send(publicRecord(session), 201);
      return true;
    }
    const syncMatch = path.match(/^\/api\/hub\/sessions\/([a-f0-9-]+)\/sync$/);
    if (syncMatch && method === 'POST') {
      send(publicRecord(await syncNative(load(syncMatch[1], 'session'))));
      return true;
    }
    const customizationMatch = path.match(
      /^\/api\/hub\/sessions\/([a-f0-9-]+)\/service-customizations\/([a-f0-9-]+)\/apply$/,
    );
    if (customizationMatch && method === 'POST') {
      const [, sessionId, draftId] = customizationMatch;
      const session = load(sessionId, 'session');
      assert(!session.archived && !deletingSessions.has(sessionId) && !deletingMachines.has(session.machineId) &&
        !nativeChanges.has(sessionId) && !['running', 'connecting', 'approval'].includes(session.status),
        'Дождитесь ответа агента или восстановите чат из архива.', 409);
      const draft = session.secret.serviceCustomizations?.find((entry) => entry.id === draftId);
      assert(draft?.configuration, 'Предложение не найдено', 404);
      let appliedAt = draft.appliedAt;
      if (!appliedAt) {
        assert(!draft.replaced, 'В чате есть более новое предложение для этого сервиса.', 409);
        const service = services.get(draft.serviceId);
        appliedAt = now();
        services.saveCustomization(service, draft.configuration, draft.revision, () => {
          updateSession(sessionId, (record) => {
            record.secret.serviceCustomizations.find((entry) => entry.id === draftId).appliedAt = appliedAt;
          });
        });
      }
      send({ serviceId: draft.serviceId, appliedAt });
      return true;
    }
    const serviceChatMatch = path.match(
      /^\/api\/hub\/sessions\/([a-f0-9-]+)\/service-drafts(?:\/([a-f0-9-]+)\/save)?$/,
    );
    if (serviceChatMatch && method === (serviceChatMatch[2] ? 'POST' : 'PATCH')) {
      const [, sessionId, batchId] = serviceChatMatch;
      const s = load(sessionId, 'session');
      assert(
        !s.archived &&
          !deletingSessions.has(s.id) &&
          !deletingMachines.has(s.machineId) &&
          !nativeChanges.has(s.id) &&
          !['running', 'connecting', 'approval'].includes(s.status),
        'Дождитесь ответа агента или восстановите чат из архива.',
        409,
      );
      if (!batchId) {
        assert(typeof body?.active === 'boolean', 'Укажите режим оформления');
        send(publicRecord(updateSession(s.id, (x) => {
          x.serviceDrafting = body.active;
        })));
        return true;
      }
      const batch = s.secret.serviceBatches?.find((entry) => entry.id === batchId);
      assert(batch, 'Черновики не найдены', 404);
      const ids = body?.ids;
      assert(
        Array.isArray(ids) && ids.length > 0 && ids.length <= 8 &&
          new Set(ids).size === ids.length,
        'Выберите карточки для сохранения',
      );
      const cards = batch.cards.filter((card) => ids.includes(card.id));
      assert(cards.length === ids.length, 'Черновик карточки не найден', 404);
      if (cards.every((card) => card.result)) {
        send({ results: cards.map((card) => ({ id: card.id, ...card.result })) });
        return true;
      }
      assert(
        !batch.replaced,
        'Агент подготовил более новые черновики. Откройте последний ответ.',
        409,
      );
      const results = services.saveChatDrafts(s.machineId, cards, (receipts) => {
        updateSession(s.id, (x) => {
          const saved = x.secret.serviceBatches.find((entry) => entry.id === batchId);
          for (const { id, ...result } of receipts)
            saved.cards.find((card) => card.id === id).result = result;
          if (saved.cards.every((card) => card.result)) x.serviceDrafting = false;
        });
      });
      send({ results });
      return true;
    }
    const sm = path.match(
      /^\/api\/hub\/sessions\/([a-f0-9-]+)(?:\/(message|stop|approval|execution))?$/,
    );
    if (sm) {
      const s = load(sm[1], 'session');
      assert(
        !deletingSessions.has(s.id) && !deletingMachines.has(s.machineId),
        'Чат удаляется',
        409,
      );
      if (!sm[2] && method === 'DELETE') {
        send(await removeObject(removalPlan(store, 'chat', s.id), body));
        return true;
      }
      if (!sm[2] && method === 'GET') {
        send({
          ...publicRecord(s),
          cwd:
            s.cwd ||
            (s.projectId ? load(s.projectId, 'workspace').path : undefined),
          messages: s.secret.messages,
          changedTurns: (s.secret.fileChanges || []).map((item) => item.id),
          serviceBatches: s.secret.serviceBatches || [],
          serviceCustomizations: s.secret.serviceCustomizations || [],
          usage: s.secret.usage || null,
          errorMessage: s.secret.errorMessage || null,
          approvals: s.secret.approvals,
        });
        return true;
      }
      if (sm[2] === 'execution' && method === 'PATCH') {
        const changes = {};
        for (const key of ['harnessEnabled', 'autoApprove']) {
          if (!Object.hasOwn(body, key)) continue;
          assert(
            typeof body[key] === 'boolean',
            'Укажите состояние переключателя',
          );
          if (body[key] !== (s[key] === true)) changes[key] = body[key];
        }
        const keys = Object.keys(changes);
        assert(
          Object.hasOwn(body, 'harnessEnabled') || Object.hasOwn(body, 'autoApprove'),
          'Выберите режим выполнения',
        );
        if (!keys.length) {
          send(publicRecord(s));
          return true;
        }
        assert(!s.archived, 'Восстановите чат из архива', 409);
        const onlyRevoking = keys.length === 1 && changes.autoApprove === false;
        if (!onlyRevoking)
          assert(
            !['running', 'connecting', 'approval'].includes(s.status) &&
              !modelChanges.has(s.id) && !nativeChanges.has(s.id),
            'Дождитесь завершения хода или остановите чат',
            409,
          );
        if (changes.autoApprove === true)
          assert(
            body.confirmAutoApprove === true,
            'Подтвердите включение автоаппрува',
          );
        send(publicRecord(updateSession(s.id, (session) => {
          Object.assign(session, changes);
        })));
        return true;
      }
      if (!sm[2] && method === 'PATCH') {
        assert(
          !nativeChanges.has(s.id),
          'Дождитесь синхронизации диалога',
          409,
        );
        const accountChanged =
          Object.hasOwn(body, 'accountId') &&
          (body.accountId || null) !== (s.accountId || null);
        assert(!modelChanges.has(s.id), 'Дождитесь сохранения модели', 409);
        if (body.title !== undefined)
          assert(
            typeof body.title === 'string' &&
              body.title.trim() &&
              body.title.length <= 100,
            'Название: от 1 до 100 символов',
          );
        assert(
          !['running', 'connecting', 'approval'].includes(s.status),
          'Сначала остановите диалог',
          409,
        );
        if (Object.hasOwn(body, 'accountId')) {
          const accountId = body.accountId || null;
          if (accountId) accounts.connected(accountId, s.provider);
          assert(
            !s.profileId || accountId,
            'Для этого чата выберите сохранённый аккаунт. Аккаунт машины доступен в новом чате.',
            409,
          );
          if (accountId && !s.profileId) {
            assert(
              !s.secret.messages.some((m) =>
                ['assistant', 'tool'].includes(m.role),
              ),
              'Этот чат использует прежний профиль машины. Создайте новый чат с выбранным аккаунтом; история этого чата сохранится.',
              409,
            );
            s.profileId = s.id;
            s.nativeId = null;
            s.nativeSource = false;
          }
          s.accountId = accountId;
          s.model = '';
          s.reasoning = '';
          s.authError = null;
          s.secret.errorMessage = null;
        }
        if (
          Object.hasOwn(body, 'model') ||
          Object.hasOwn(body, 'reasoning') ||
          accountChanged
        ) {
          assert(!modelChanges.has(s.id), 'Настройки модели уже меняются', 409);
          assert(
            !Object.hasOwn(body, 'projectId'),
            'Сначала перенесите чат, затем выберите модель',
          );
          modelChanges.add(s.id);
          try {
            let model = body.model ?? s.model ?? '';
            const reasoning =
              body.reasoning ?? (model === s.model ? s.reasoning || '' : '');
            const catalog =
              model || reasoning || (accountChanged && s.accountId)
                ? await modelCatalog.get(
                    machine(s.machineId),
                    s.provider,
                    s.cwd ||
                      (s.projectId
                        ? load(s.projectId, 'workspace').path
                        : await resolveHome(machine(s.machineId))),
                    { model, accountId: s.accountId || null },
                  )
                : { models: [] };
            if (!model && accountChanged && s.accountId)
              model = catalog.defaultModelId || '';
            validateSelection(catalog, model, reasoning);
            assert(
              load(s.id, 'session').updatedAt === s.updatedAt &&
                !['running', 'connecting', 'approval'].includes(
                  load(s.id, 'session').status,
                ),
              'Диалог изменился. Повторите выбор модели.',
              409,
            );
            s.model = model;
            s.reasoning = reasoning;
          } finally {
            modelChanges.delete(s.id);
          }
        }
        if (body.title) {
          s.title = body.title.trim();
          s.customTitle = true;
        }
        if (Object.hasOwn(body, 'projectId')) {
          const target = body.projectId
            ? load(body.projectId, 'workspace')
            : null;
          assert(
            !target || target.machineId === s.machineId,
            'Диалог можно перенести только в проект на той же машине',
            409,
          );
          const oldCwd =
            s.cwd ||
            (s.projectId
              ? load(s.projectId, 'workspace').path
              : await resolveHome(machine(s.machineId)));
          s.projectId = target?.id || null;
          assert(
            !s.nativeSource || !target || target.path === oldCwd,
            'Диалог машины продолжает работу в исходной папке. Выберите проект с той же папкой.',
            409,
          );
          s.cwd = target?.path || oldCwd;
          if (s.cwd !== oldCwd && s.secret.messages.length)
            s.secret.messages.push({
              id: randomUUID(),
              role: 'system',
              content: `Рабочая папка диалога изменена: ${s.cwd}`,
              createdAt: now(),
            });
        }
        if (typeof body.archived === 'boolean') s.archived = body.archived;
        // Preserve settings saved through /execution while an edit was awaiting a probe.
        const latest = load(s.id, 'session');
        for (const key of ['harnessEnabled', 'autoApprove']) {
          if (Object.hasOwn(latest, key)) s[key] = latest[key];
        }
        runtimes.get(s.id)?.rpc?.close();
        save(s);
        send(publicRecord(s));
        return true;
      }
      if (method === 'POST' && sm[2] === 'message') {
        assert(
          !nativeChanges.has(s.id),
          'Дождитесь синхронизации истории',
          409,
        );
        if (s.nativeSource) {
          await syncNative(s);
          Object.assign(s, load(s.id, 'session'));
        }
        assert(!modelChanges.has(s.id), 'Дождитесь сохранения модели', 409);
        assert(!s.archived, 'Восстановите диалог из архива', 409);
        const sessionMachine = machine(s.machineId);
        const cwd = s.cwd || (s.projectId ? load(s.projectId, 'workspace').path : undefined);
        assert(
          s.mode === 'read-only' ||
            !sessions().some(
              (other) =>
                other.id !== s.id &&
                other.machineId === s.machineId &&
                sameWorkspaceDirectory(other.cwd, cwd, sessionMachine.platform) &&
                other.mode !== 'read-only' &&
                ['running', 'connecting', 'approval'].includes(other.status),
            ),
          'В этом проекте уже работает другой агент с правом записи. Остановите его или дождитесь завершения.',
          409,
        );
        assert(
          !['running', 'connecting', 'approval'].includes(s.status),
          'Дождитесь ответа или остановите выполнение',
          409,
        );
        assert(
          typeof body.message === 'string' &&
            body.message.trim() &&
            body.message.length <= 32000,
          'Сообщение: от 1 до 32000 символов',
        );
        const serviceRequest = serviceChatRequest(body.message);
        assert(!serviceRequest || !body.customizeServiceId, 'Выберите оформление или настройку сервиса для этого сообщения');
        const customization = body.customizeServiceId ? customizationTarget(body.customizeServiceId) : null;
        const command = serviceRequest ? serviceChatCommand : undefined;
        const message = serviceRequest || body.message.trim();
        const drafting = !customization && (!!serviceRequest || !!s.serviceDrafting);
        if (s.accountId) accounts.connected(s.accountId, s.provider);
        updateSession(s.id, (x) => {
          x.status = 'connecting';
          x.authError = null;
          x.secret.errorMessage = null;
          if (serviceRequest) x.serviceDrafting = true;
          if (
            !x.customTitle &&
            !x.secret.messages.some((m) => m.role === 'user')
          )
            x.title = message.slice(0, 70);
        });
        let connectingRuntime;
        try {
          connectingRuntime = await runtimeFor(
              sessionMachine,
            s.provider,
            s,
          );
          const ready = await connectingRuntime.ready;
          if (load(s.id, 'session').status !== 'connecting') {
            await releaseRuntime(ready).catch(() => {});
            throw Object.assign(
              new Error('Отправка отменена. Черновик можно отправить снова.'),
              { status: 409 },
            );
          }
        } catch (error) {
          if (connectingRuntime?.cancelled)
            throw Object.assign(
              new Error('Отправка отменена. Черновик можно отправить снова.'),
              { status: 409 },
            );
          if (!connectingRuntime?.cancelled)
            updateSession(s.id, (x) => {
              x.status = 'error';
              x.authError = error.status === 403 ? error.message : null;
              x.secret.errorMessage = error.message?.slice(0, 2000);
            });
          throw error;
        }
        const userMessageId = randomUUID();
        addMessage(s.id, 'user', message, userMessageId, false, command ? { command } : undefined);
        // Accept promptly; native agent events update the durable session asynchronously.
        void (async () => {
          let runningRuntime, messageId;
          try {
            const r = await (
              await runtimeFor(machine(s.machineId), s.provider, s)
            ).ready;
            if (load(s.id, 'session').status !== 'connecting') return;
            updateSession(s.id, (x) => {
              x.status = 'running';
            });
            runningRuntime = r;
            r.cancelled = false;
            messageId = randomUUID();
            r.messageId = messageId;
            const changeTurn = { id: userMessageId, at: now(), cwd: r.cwd, pending: new Map() };
            r.changeTurn = changeTurn;
            changeTurn.baseline = await inspect(sessionMachine, 'snapshot', { root: r.cwd }).catch(() => null);
            if (r.cancelled || r.rpc.dead || r.changeTurn !== changeTurn || !canUpdateSession(s.id)) return;
            r.autoApproved = 0;
            const serviceTurn = drafting || customization ? { messages: new Set() } : null;
            if (customization) serviceTurn.customization = {
              ...customization,
              revision: customizationRevision(customization.service),
            };
            r.serviceTurn = serviceTurn;
            const task = customization
              ? customizeServiceInput(message, customization.service, customization.selected, s)
              : drafting ? serviceConversationInput(
                  message, s, sessionMachine,
                  s.projectId ? load(s.projectId, 'workspace') : null,
                  services.list(),
                  command,
                )
                : message;
            r.harnessTurn = s.harnessEnabled === true
              ? beginHarnessTurn(s, r.cwd, task)
              : null;
            const text = r.harnessTurn?.input ?? task;
            const timer = setTimeout(
              () => {
                r.rpc.close();
                addMessage(
                  s.id,
                  'system',
                  'Достигнут предел хода — 30 минут. Проверьте состояние перед продолжением.',
                );
              },
              30 * 60 * 1000,
            );
            r.turnTimer = timer;
            timer.unref();
            if (s.provider === 'codex') {
              const result = await r.rpc.request('turn/start', {
                threadId: r.nativeId,
                input: [{ type: 'text', text }],
                ...(s.model ? { model: s.model } : {}),
                effort: s.reasoning || r.defaultReasoning || null,
              });
              if (
                r.messageId === messageId &&
                r.turnTimer === timer &&
                (!serviceTurn || r.serviceTurn === serviceTurn)
              ) {
                r.turnId = result.turn?.id;
                if (serviceTurn) serviceTurn.id = r.turnId;
              }
            } else {
              const result = await r.rpc.request(
                'session/prompt',
                {
                  sessionId: r.nativeId,
                  prompt: [{ type: 'text', text }],
                },
                30 * 60 * 1000,
              );
              clearTimeout(timer);
              if (r.messageId !== messageId) return;
              const recording = startTurnCompletion(r);
              if (recording) await recording;
              r.finishingTurn = false;
              if (r.changeTurn === changeTurn) r.changeTurn = null;
              if (r.accountId) await releaseRuntime(r);
              if (
                canUpdateSession(s.id) &&
                !r.cancelled &&
                r.messageId === messageId
              )
                updateSession(s.id, (x) => {
                  closeHarnessTurn(
                    r,
                    x,
                    result.stopReason === 'end_turn' && x.status !== 'interrupted',
                  );
                  finishServiceTurn(
                    r,
                    x,
                    serviceTurn,
                    result.stopReason === 'end_turn',
                    result.stopReason === 'max_tokens'
                      ? 'Агент остановился на лимите ответа. Продолжите оформление следующим сообщением.'
                      : result.stopReason !== 'cancelled'
                        ? 'Агент не завершил оформление. Продолжите в этом чате.'
                        : undefined,
                  );
                  if (x.status !== 'interrupted')
                    x.status =
                      result.stopReason === 'cancelled'
                        ? 'interrupted'
                        : 'idle';
                  x.secret.approvals = [];
                });
            }
          } catch (error) {
            if (
              closed ||
              deletingSessions.has(s.id) ||
              !store.get('settings', s.id)
            )
              return;
            if (runningRuntime && runningRuntime.messageId !== messageId)
              return;
            const failed = runningRuntime || runtimes.get(s.id);
            clearTurnTimer(failed);
            if (failed) failed.serviceTurn = null;
            if (failed?.accountId) await releaseRuntime(failed).catch(() => {});
            const recording = recordWorkspaceChanges(failed);
            if (recording) await recording;
            if (failed) failed.changeTurn = null;
            if (runningRuntime?.cancelled || !canUpdateSession(s.id)) return;
            const stopped = load(s.id, 'session').status === 'interrupted';
            if (!stopped) {
              updateSession(s.id, (x) => {
                closeHarnessTurn(failed, x);
                x.status = 'error';
                if (authorizationError(error.message)) x.authError = signInHelp;
                x.secret.approvals = [];
              });
              addMessage(
                s.id,
                'system',
                authorizationError(error.message) ? signInHelp : error.message,
              );
            }
          }
        })();
        send({ accepted: true }, 202);
        return true;
      }
      if (method === 'POST' && sm[2] === 'stop') {
        const r = runtimes.get(s.id);
        const closeAfterStop = r?.serviceTurn || r?.harnessTurn ||
          r?.autoApproved > 0 || s.autoApprove === true;
        if (r) {
          r.cancelled = true;
          r.serviceTurn = null;
          clearTurnTimer(r);
        }
        if (r?.rpc) {
          try {
            if (s.provider === 'codex' && r.turnId)
              await r.rpc.request('turn/interrupt', {
                threadId: r.nativeId,
                turnId: r.turnId,
              });
            else if (s.provider !== 'codex')
              r.rpc.notify('session/cancel', { sessionId: r.nativeId });
            else r.rpc.close();
          } catch {
            r.rpc.close();
          }
        }
        if (closeAfterStop && r?.rpc && !r.rpc.dead)
          await releaseRuntime(r).catch(() => {});
        const recording = recordWorkspaceChanges(r);
        if (recording) await recording;
        if (r) r.changeTurn = null;
        updateSession(s.id, (x) => {
          closeHarnessTurn(r, x);
          x.status = 'interrupted';
          x.secret.approvals = [];
        });
        send({ ok: true });
        return true;
      }
      if (method === 'POST' && sm[2] === 'approval') {
        const a = s.secret.approvals.find((a) => a.id === body.id);
        assert(a, 'Запрос уже закрыт', 409);
        const r = runtimes.get(s.id);
        assert(r?.rpc && !r.rpc.dead, 'Связь с агентом потеряна', 409);
        let response;
        if (a.kind === 'input') {
          const answers = {};
          for (const q of a.params.questions || []) {
            const answer = body.answers?.[q.id];
            assert(
              typeof answer === 'string' && answer.length <= 8000,
              'Ответьте на вопросы агента',
            );
            answers[q.id] = { answers: [answer] };
          }
          response = { answers };
        } else if (s.provider === 'codex') {
          assert(
            ['accept', 'decline'].includes(body.decision),
            'Некорректное решение',
          );
          response = { decision: body.decision };
        } else {
          const option = (a.params.options || []).find(
            (x) =>
              x.optionId === body.decision &&
              ['allow_once', 'reject_once'].includes(x.kind),
          );
          assert(option, 'Выберите разрешение для одного действия');
          response = {
            outcome: { outcome: 'selected', optionId: option.optionId },
          };
        }
        updateSession(s.id, (x) => {
          x.secret.approvals = x.secret.approvals.filter((y) => y.id !== a.id);
          x.status = x.secret.approvals.length ? 'approval' : 'running';
        });
        r.rpc.respond(a.rpcId, response);
        send({ ok: true });
        return true;
      }
    }
    const mm = path.match(
      /^\/api\/hub\/machines\/([a-f0-9-]+)\/(metrics|credentials|revoke)$/,
    );
    if (mm) {
      const m = machine(mm[1]);
      if (mm[2] === 'metrics' && method === 'POST') {
        send(await sample(m.id));
        return true;
      }
      if (mm[2] === 'credentials' && method === 'POST') {
        assert(body.reveal === true, 'Подтвердите показ пароля');
        assert(
          m.secret?.password,
          'Для этой машины используется ключ или коннектор',
          404,
        );
        send({ password: m.secret.password });
        return true;
      }
      if (mm[2] === 'revoke' && method === 'POST') {
        assert(
          m.transport === 'connector',
          'Отзыв доступен только для коннектора',
        );
        m.secret.connectorToken = randomUUID();
        m.status = 'offline';
        saveMachine(m);
        connectors.revoke(m.id);
        send({ ok: true });
        return true;
      }
    }
    const am = path.match(
      /^\/api\/hub\/machines\/([a-f0-9-]+)\/agents\/(codex|opencode|claude)(?:\/(install|login|logout|models|limits|account|subscription))?$/,
    );
    if (am) {
      const m = machine(am[1]),
        provider = am[2];
      if (am[3] === 'subscription') {
        assert(
          provider === 'claude',
          'Этот способ входа доступен для Claude',
          400,
        );
        assert(
          ['GET', 'POST'].includes(method),
          'Метод не поддерживается',
          405,
        );
        if (method === 'POST')
          assert(
            body.confirm === true,
            'Подтвердите использование подписки на машине',
          );
        const native = await claudeStatus(m, openProcess, connectors);
        if (method === 'GET') {
          send(native);
          return true;
        }
        assert(
          native.ready && isClaudeSubscription(native.account),
          'Войдите в Claude с подпиской на этой машине. API-ключ не является подпиской.',
          403,
        );
        const current = machine(m.id);
        current.agentAccounts = { ...current.agentAccounts, claude: null };
        saveMachine(current);
        modelCatalog.invalidate(m.id, provider);
        agentLimits.invalidateMachine(m.id, provider);
        send({ ok: true, account: native.account });
        return true;
      }
      if (method === 'POST' && am[3] === 'account') {
        const accountId = body.accountId || null;
        if (accountId) accounts.connected(accountId, provider);
        m.agentAccounts = { ...m.agentAccounts, [provider]: accountId };
        saveMachine(m);
        for (const r of runtimes.values())
          if (r.machineId === m.id && r.provider === provider && !r.sessionId)
            r.rpc?.close();
        modelCatalog.invalidate(m.id, provider);
        agentLimits.invalidateMachine(m.id, provider);
        send({ ok: true, accountId });
        return true;
      }
      if (method === 'POST' && ['models', 'limits'].includes(am[3])) {
        const session = body.sessionId ? load(body.sessionId, 'session') : null;
        const project = body.projectId
          ? load(body.projectId, 'workspace')
          : null;
        assert(
          !session ||
            (session.machineId === m.id && session.provider === provider),
          'Агент чата находится на другой машине',
        );
        assert(
          !project || project.machineId === m.id,
          'Проект находится на другой машине',
        );
        const accountId = Object.hasOwn(body, 'accountId')
          ? body.accountId
          : session
            ? session.accountId || null
            : m.agentAccounts?.[provider] || null;
        assert(
          accountId == null || typeof accountId === 'string',
          'Некорректный аккаунт',
        );
        if (accountId) accounts.connected(accountId, provider);
        if (am[3] === 'limits') {
          const limits = await agentLimits.get(m, provider, {
            accountId,
            refresh: body.refresh === true,
          });
          if (accountId) accounts.connected(accountId, provider);
          send(limits);
          return true;
        }
        const location = body.serviceId && !session ? locationForService(body.serviceId) : null;
        assert(!location || location.machineId === m.id, 'Сервис использует рабочую папку на другой машине');
        const cwd = projectPath(
          session?.cwd || location?.cwd || project?.path ||
            (!session && !location && body.cwd) || (await resolveHome(m)),
          m.platform || 'linux',
        );
        send(
          await modelCatalog.get(m, provider, cwd, {
            model: body.model ?? '',
            refresh: body.refresh === true,
            accountId: Object.hasOwn(body, 'accountId')
              ? body.accountId
              : session
                ? session.accountId || null
                : m.agentAccounts?.[provider] || null,
          }),
        );
        return true;
      }
      if (method === 'GET' && !am[3]) {
        send(await status(m, provider));
        return true;
      }
      if (method === 'POST' && am[3] === 'login' && provider === 'codex') {
        const r = await (await runtimeFor(m, provider)).ready;
        r.login = null;
        const result = await r.rpc.request('account/login/start', {
          type: 'chatgptDeviceCode',
        });
        const url = new URL(result.verificationUrl);
        assert(
          url.protocol === 'https:' &&
            ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(
              url.hostname,
            ) &&
            !url.username &&
            !url.password,
          'Агент вернул недопустимый адрес входа',
        );
        const login = {
          type: 'chatgptDeviceCode',
          verificationUrl: url.href,
          userCode: String(result.userCode || '').slice(0, 128),
        };
        r.login = login;
        send(login);
        return true;
      }
      if (method === 'POST' && am[3] === 'logout') {
        if (provider === 'claude') {
          assert(body.confirm === true, 'Подтвердите выход из аккаунта машины');
          assert(
            !sessions().some(
              (s) =>
                s.machineId === m.id &&
                ['running', 'connecting', 'approval'].includes(s.status),
            ),
            'Сначала остановите активные чаты',
            409,
          );
          send(await task(m, provider, 'logout'), 202);
          return true;
        }
        assert(provider === 'codex', 'Выйдите из OpenCode через его терминал');
        assert(
          !sessions().some(
            (s) =>
              s.machineId === m.id &&
              s.provider === provider &&
              ['running', 'connecting', 'approval'].includes(s.status),
          ),
          'Сначала остановите диалоги',
          409,
        );
        const r = await (await runtimeFor(m, provider)).ready;
        await r.rpc.request('account/logout');
        r.rpc.close();
        agentLimits.invalidateMachine(m.id, provider);
        send({ ok: true });
        return true;
      }
      if (method === 'POST' && ['install', 'login'].includes(am[3])) {
        assert(body.confirm === true, 'Подтвердите запуск на выбранной машине');
        assert(
          !sessions().some(
            (s) =>
              s.machineId === m.id &&
              ['running', 'connecting', 'approval'].includes(s.status),
          ),
          'Сначала остановите активные диалоги',
          409,
        );
        send(await task(m, provider, am[3]), 202);
        return true;
      }
    }
    const tm = path.match(
      /^\/api\/hub\/tasks\/([a-f0-9-]+)(?:\/(input|stop))?$/,
    );
    if (tm) {
      const t = tasks.get(tm[1]);
      assert(t, 'Операция не найдена. Проверьте установку на машине.', 404);
      if (method === 'GET') {
        const {
          process: _process,
          timer: _timer,
          secrets: _secrets,
          ...data
        } = t;
        send(data);
        return true;
      }
      if (method === 'POST' && tm[2] === 'input') {
        assert(
          t.status === 'running' && t.operation === 'login',
          'Ввод закрыт',
        );
        assert(
          typeof body.input === 'string' && body.input.length <= 4096,
          'Слишком длинный ввод',
        );
        if (body.input.length >= 4) {
          t.secrets.push(body.input);
          t.output = redact(t.output, t.secrets);
        }
        t.process.input.write(
          body.input + (t.provider === 'claude' ? '\r' : '\n'),
        );
        send({ ok: true });
        return true;
      }
      if (method === 'POST' && tm[2] === 'stop') {
        t.status = 'error';
        clearTimeout(t.timer);
        t.process.close();
        send({ ok: true });
        return true;
      }
    }
    send({ error: 'Маршрут не найден' }, 404);
    return true;
  }
  const sampler = setInterval(() => {
    for (const m of store.list('servers'))
      if (
        m.transport === 'local' ||
        ((!m.transport || m.transport === 'ssh') &&
          Date.now() - new Date(m.checkedAt || 0).getTime() > 30000)
      )
        void sample(m.id).catch(() => {});
  }, 10000);
  sampler.unref();
  return {
    handle,
    connectors,
    close() {
      nativeSessions.close();
      if (closed) return;
      closed = true;
      services.close();
      modelCatalog.close();
      agentLimits.close();
      accounts.close();
      clearInterval(sampler);
      for (const r of runtimes.values()) r.rpc?.close();
      for (const t of tasks.values()) {
        clearTimeout(t.timer);
        t.process.close();
      }
      connectors.close();
    },
  };
}
