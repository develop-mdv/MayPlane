import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { AgentRpc } from './agent-rpc.mjs';
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
import { agentVersion, agentError } from './agent-status.mjs';
import { createAccounts } from './accounts.mjs';
import { connectorEndpoint } from '../lib/machine-connection.mjs';
import { createNativeSessions } from './native-sessions.mjs';
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
  const { secret, ...rest } = record;
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
  } = {},
) {
  const connectors = attachConnectors(server, store);
  const connectorUrl = publicUrl ? connectorEndpoint(publicUrl) : null;
  const nativeSessions = createNativeSessions({ openProcess, connectors });
  const nativeChanges = new Set();
  const runtimes = new Map(),
    tasks = new Map(),
    refreshing = new Set();
  let closed = false;
  const modelCatalog = createModelCatalog({
    openProcess,
    connectors,
    isClosed: () => closed,
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
    assert(typeof id === 'string' && id, 'Выберите машину', 404);
    const m = store.get('servers', id);
    assert(m, 'Машина не найдена', 404);
    return m;
  };
  separateServices(store);
  const sessions = () =>
    records('session').map((s) => ({
      ...s,
      cwd:
        s.cwd ||
        (s.projectId ? load(s.projectId, 'workspace').path : undefined),
    }));
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
  ) {
    if (!content) return;
    updateSession(id, (s) => {
      const found = s.secret.messages.find((m) => m.id === itemId);
      if (found) found.content = (append ? found.content : '') + content;
      else
        s.secret.messages.push({ id: itemId, role, content, createdAt: now() });
      s.secret.messages = s.secret.messages.slice(-2000);
      const last = s.secret.messages.find((m) => m.id === itemId);
      if (last) last.content = last.content.slice(-262144);
    });
  }
  function onMessage(runtime, message) {
    const { method, params: p = {}, id } = message;
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
    if (runtime.replaying) {
      if (id !== undefined) runtime.rpc.reject(id);
      return;
    }
    if (id !== undefined) {
      const approval = [
        'session/request_permission',
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
      ].includes(method);
      const input = method === 'item/tool/requestUserInput';
      if (!approval && !input) return runtime.rpc.reject(id);
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
    if (method === 'turn/started') runtime.turnId = p.turn?.id;
    if (method === 'item/agentMessage/delta')
      addMessage(sid, 'assistant', p.delta, p.itemId, true);
    if (method === 'item/completed' || method === 'item/started') {
      const item = p.item || {};
      if (item.type === 'agentMessage' && item.text)
        addMessage(sid, 'assistant', item.text, item.id);
      if (item.type === 'commandExecution')
        addMessage(
          sid,
          'tool',
          `${item.command || ''}${item.aggregatedOutput ? '\n' + item.aggregatedOutput : ''}\n${item.status || ''}`,
          item.id,
        );
      if (item.type === 'fileChange')
        addMessage(
          sid,
          'tool',
          JSON.stringify(item.changes || [], null, 2),
          item.id,
        );
    }
    if (method === 'item/commandExecution/outputDelta')
      addMessage(sid, 'tool', p.delta, p.itemId, true);
    if (method === 'turn/completed') {
      runtime.turnId = null;
      clearTimeout(runtime.turnTimer);
      updateSession(sid, (s) => {
        s.status =
          p.turn?.status === 'completed'
            ? 'idle'
            : p.turn?.status === 'interrupted'
              ? 'interrupted'
              : 'error';
        s.secret.approvals = [];
        if (authorizationError(p.turn?.error?.message))
          s.authError = signInHelp;
      });
      if (p.turn?.error?.message)
        addMessage(
          sid,
          'system',
          authorizationError(p.turn.error.message)
            ? signInHelp
            : p.turn.error.message,
        );
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
      if (u.sessionUpdate === 'config_option_update')
        runtime.modelState = { configOptions: u.configOptions };
      if (
        u.sessionUpdate === 'agent_message_chunk' &&
        u.content?.type === 'text'
      )
        addMessage(sid, 'assistant', u.content.text, runtime.messageId, true);
      if (['tool_call', 'tool_call_update'].includes(u.sessionUpdate))
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
    }
  }
  async function runtimeFor(m, provider, session) {
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
      const cwd = session
        ? session.cwd ||
          (session.projectId
            ? load(session.projectId, 'workspace').path
            : await resolveHome(m))
        : undefined;
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
      if (closed) {
        opened.close();
        throw new Error('Исполнитель останавливается');
      }
      runtime.rpc = new AgentRpc(opened);
      runtime.rpc.on('message', (msg) => onMessage(runtime, msg));
      runtime.rpc.on('disconnected', () => {
        const expected = runtime.managedClose;
        clearTimeout(runtime.turnTimer);
        runtimes.delete(key);
        if (runtime.releaseAccount)
          void releaseRuntime(runtime).catch(() => {});
        if (session && !expected)
          updateSession(session.id, (s) => {
            if (['running', 'connecting', 'approval'].includes(s.status))
              s.status = 'interrupted';
            s.secret.approvals = [];
          });
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
              'Эта версия OpenCode не поддерживает возобновление. Создайте новый диалог.',
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
        if (session)
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
      projects: records('workspace'),
      services: store.list('projects').map((s) => ({
        id: s.id,
        name: s.name,
        machineId: s.serverId,
        repo: s.repo,
        kind: s.kind,
        status: s.status,
        domain: s.domain,
      })),
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
        if (s.cwd !== data.cwd) s.projectId = null;
        s.cwd = data.cwd;
        if (allowLegacy && s.provider === 'codex' && mode) s.mode = mode;
        s.secret.messages = data.messages;
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
    assert(!refreshing.has(id), 'Проверка уже выполняется', 409);
    refreshing.add(id);
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
          {
            at: current.checkedAt,
            cpu: current.cpu,
            memory: current.memory,
            disk: current.disk,
            networkRx: current.networkRx,
            networkTx: current.networkTx,
          },
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
    } finally {
      refreshing.delete(id);
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
      if (code === 0 && operation === 'install') {
        for (const r of runtimes.values())
          if (r.machineId === m.id && r.provider === provider) r.rpc?.close();
        modelCatalog.invalidate(m.id, provider);
        accounts.invalidateMachine(m.id);
      }
      p.close();
    };
    const capture = (bytes) => {
      t.output = redact(t.output + bytes.toString(), [
        ...Object.values(m.secret || {}),
        ...t.secrets,
      ]).slice(-32768);
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
  async function handle(path, method, body, send) {
    if (!path.startsWith('/api/hub')) return false;
    if (await accounts.handle(path, method, body, send)) return true;
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
      /^\/api\/hub\/machines\/([a-f0-9-]+)\/agents\/(codex|opencode)\/native-sessions$/,
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
        const samePath = (path) =>
          m.platform === 'win32'
            ? path?.toLowerCase() === data.cwd.toLowerCase()
            : path === data.cwd;
        const project = records('workspace').find(
          (p) => p.machineId === m.id && samePath(p.path),
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
          (p) => p.machineId === m.id && p.path === path,
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
      assert(
        !sessions().some(
          (s) =>
            s.projectId === projectMatch[1] &&
            ['running', 'connecting', 'approval'].includes(s.status),
        ),
        'Остановите активные диалоги',
        409,
      );
      const project = load(projectMatch[1], 'workspace');
      // Removing a folder from the sidebar never deletes files or chat history.
      for (const item of sessions().filter((s) => s.projectId === project.id)) {
        runtimes.get(item.id)?.rpc?.close();
        updateSession(item.id, (s) => {
          s.projectId = null;
          s.cwd = item.cwd || project.path;
        });
      }
      store.db.prepare('DELETE FROM settings WHERE id=?').run(projectMatch[1]);
      send({ ok: true });
      return true;
    }
    if (path === '/api/hub/sessions' && method === 'POST') {
      const p = body.projectId ? load(body.projectId, 'workspace') : null;
      const m = machine(p?.machineId || body.machineId);
      const accountId = Object.hasOwn(body, 'accountId')
        ? body.accountId
        : m.agentAccounts?.[body.provider] || null;
      if (accountId) accounts.connected(accountId, body.provider);
      if (p && body.machineId)
        assert(
          p.machineId === body.machineId,
          'Проект находится на другой машине',
        );
      assert(providers[body.provider], 'Выберите агента');
      assert(
        ['read-only', 'workspace-write'].includes(
          body.mode || 'workspace-write',
        ),
        'Выберите режим',
      );
      assert(
        body.provider !== 'opencode' || body.mode !== 'read-only',
        'Для OpenCode используйте разрешения его конфигурации',
      );
      const session = {
        id: randomUUID(),
        recordType: 'session',
        projectId: p?.id || null,
        machineId: m.id,
        cwd:
          p?.path || projectPath(await resolveHome(m), m.platform || 'linux'),
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
      save(session);
      send(publicRecord(session), 201);
      return true;
    }
    const syncMatch = path.match(/^\/api\/hub\/sessions\/([a-f0-9-]+)\/sync$/);
    if (syncMatch && method === 'POST') {
      send(publicRecord(await syncNative(load(syncMatch[1], 'session'))));
      return true;
    }
    const sm = path.match(
      /^\/api\/hub\/sessions\/([a-f0-9-]+)(?:\/(message|stop|approval))?$/,
    );
    if (sm) {
      const s = load(sm[1], 'session');
      if (!sm[2] && method === 'GET') {
        send({
          ...publicRecord(s),
          cwd:
            s.cwd ||
            (s.projectId ? load(s.projectId, 'workspace').path : undefined),
          messages: s.secret.messages,
          errorMessage: s.secret.errorMessage || null,
          approvals: s.secret.approvals,
        });
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
          s.secret = load(s.id, 'session').secret;
        }
        assert(!modelChanges.has(s.id), 'Дождитесь сохранения модели', 409);
        assert(!s.archived, 'Восстановите диалог из архива', 409);
        assert(
          s.mode === 'read-only' ||
            !sessions().some(
              (other) =>
                other.id !== s.id &&
                other.machineId === s.machineId &&
                other.cwd ===
                  (s.cwd ||
                    (s.projectId
                      ? load(s.projectId, 'workspace').path
                      : undefined)) &&
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
        if (s.accountId) accounts.connected(s.accountId, s.provider);
        updateSession(s.id, (x) => {
          x.status = 'connecting';
          x.authError = null;
          x.secret.errorMessage = null;
          if (
            !x.customTitle &&
            !x.secret.messages.some((m) => m.role === 'user')
          )
            x.title = body.message.trim().slice(0, 70);
        });
        let connectingRuntime;
        try {
          connectingRuntime = await runtimeFor(
            machine(s.machineId),
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
        addMessage(s.id, 'user', body.message.trim());
        // Accept promptly; native agent events update the durable session asynchronously.
        void (async () => {
          try {
            const r = await (
              await runtimeFor(machine(s.machineId), s.provider, s)
            ).ready;
            if (load(s.id, 'session').status !== 'connecting') return;
            updateSession(s.id, (x) => {
              x.status = 'running';
            });
            r.messageId = randomUUID();
            r.turnTimer = setTimeout(
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
            r.turnTimer.unref();
            if (s.provider === 'codex') {
              const result = await r.rpc.request('turn/start', {
                threadId: r.nativeId,
                input: [{ type: 'text', text: body.message.trim() }],
                ...(s.model ? { model: s.model } : {}),
                effort: s.reasoning || r.defaultReasoning || null,
              });
              r.turnId = result.turn?.id;
            } else {
              const result = await r.rpc.request(
                'session/prompt',
                {
                  sessionId: r.nativeId,
                  prompt: [{ type: 'text', text: body.message.trim() }],
                },
                30 * 60 * 1000,
              );
              clearTimeout(r.turnTimer);
              if (r.accountId) await releaseRuntime(r);
              updateSession(s.id, (x) => {
                if (x.status !== 'interrupted')
                  x.status =
                    result.stopReason === 'cancelled' ? 'interrupted' : 'idle';
                x.secret.approvals = [];
              });
            }
          } catch (error) {
            if (closed) return;
            const failed = runtimes.get(s.id);
            if (failed?.accountId) await releaseRuntime(failed).catch(() => {});
            const stopped = load(s.id, 'session').status === 'interrupted';
            if (!stopped) {
              updateSession(s.id, (x) => {
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
        if (r) r.cancelled = true;
        if (r?.rpc) {
          try {
            if (s.provider === 'codex' && r.turnId)
              await r.rpc.request('turn/interrupt', {
                threadId: r.nativeId,
                turnId: r.turnId,
              });
            else if (s.provider === 'opencode')
              r.rpc.notify('session/cancel', { sessionId: r.nativeId });
            else r.rpc.close();
          } catch {
            r.rpc.close();
          }
        }
        updateSession(s.id, (x) => {
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
      /^\/api\/hub\/machines\/([a-f0-9-]+)\/agents\/(codex|opencode)(?:\/(install|login|logout|models|account))?$/,
    );
    if (am) {
      const m = machine(am[1]),
        provider = am[2];
      if (method === 'POST' && am[3] === 'account') {
        const accountId = body.accountId || null;
        if (accountId) accounts.connected(accountId, provider);
        m.agentAccounts = { ...m.agentAccounts, [provider]: accountId };
        saveMachine(m);
        for (const r of runtimes.values())
          if (r.machineId === m.id && r.provider === provider && !r.sessionId)
            r.rpc?.close();
        modelCatalog.invalidate(m.id, provider);
        send({ ok: true, accountId });
        return true;
      }
      if (method === 'POST' && am[3] === 'models') {
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
        const cwd = projectPath(
          session?.cwd || project?.path || (await resolveHome(m)),
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
        const { process, timer, secrets, ...data } = t;
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
        t.process.input.write(body.input + '\n');
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
      modelCatalog.close();
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
