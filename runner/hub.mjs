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

const now = () => new Date().toISOString();
const publicRecord = (record) => {
  const { secret, ...rest } = record;
  return rest;
};

export function createHub(
  server,
  store,
  { openProcess = machineProcess, resolveHome = machineHome } = {},
) {
  const connectors = attachConnectors(server, store);
  const runtimes = new Map(),
    tasks = new Map(),
    refreshing = new Set();
  let closed = false;
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
      });
      if (p.turn?.error?.message)
        addMessage(sid, 'system', p.turn.error.message);
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
    const key = session?.id || `account:${m.id}:${provider}`;
    if (runtimes.has(key)) return runtimes.get(key);
    assert(
      runtimes.size < 16,
      'Открыто слишком много агентов. Завершите лишние диалоги.',
      429,
    );
    const runtime = { key, sessionId: session?.id, provider, machineId: m.id };
    runtimes.set(key, runtime);
    runtime.ready = (async () => {
      const cwd = session
        ? session.cwd ||
          (session.projectId
            ? load(session.projectId, 'workspace').path
            : await resolveHome(m))
        : undefined;
      const opened = await openProcess(
        m,
        { provider, operation: 'agent', cwd },
        connectors,
      );
      if (closed) {
        opened.close();
        throw new Error('Исполнитель останавливается');
      }
      runtime.rpc = new AgentRpc(opened);
      runtime.rpc.on('message', (msg) => onMessage(runtime, msg));
      runtime.rpc.on('disconnected', () => {
        clearTimeout(runtime.turnTimer);
        runtimes.delete(key);
        if (session)
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
              name: 'ezdeploy',
              title: 'ezdeploy',
              version: '0.2.0',
            },
          });
          runtime.rpc.notify('initialized');
          if (session) {
            const params = {
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
            clientInfo: { name: 'ezdeploy', version: '0.2.0' },
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
            runtime.models = loaded.models;
            if (session.model)
              await runtime.rpc.request('session/set_model', {
                sessionId: runtime.nativeId,
                modelId: session.model,
              });
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
    })().catch((error) => {
      runtimes.delete(key);
      throw Object.assign(
        new Error(
          `Не удалось подключить ${providers[provider].name}. Проверьте установку, вход и путь проекта. ${error.message}`,
        ),
        { status: 400 },
      );
    });
    return runtime;
  }
  async function status(m, provider) {
    try {
      if (provider === 'codex') {
        const r = await (await runtimeFor(m, provider)).ready;
        const account = await r.rpc.request('account/read', {
          refreshToken: false,
        });
        const models = await r.rpc
          .request('model/list', {})
          .catch(() => ({ data: [] }));
        return {
          installed: true,
          account: account.account
            ? {
                type: account.account.type,
                email: account.account.email,
                planType: account.account.planType,
              }
            : null,
          models: (models.data || []).map((x) => ({
            id: x.id,
            name: x.displayName || x.id,
          })),
          login: r.login || null,
        };
      }
      const p = await openProcess(
        m,
        { provider, operation: 'version' },
        connectors,
      );
      return await new Promise((resolve) => {
        let output = '';
        let done = false;
        const finish = (installed) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          p.close();
          resolve({
            installed,
            version: output.trim().slice(0, 100),
            account: null,
            models: [],
          });
        };
        const timer = setTimeout(() => finish(false), 15000);
        p.stdout.on('data', (chunk) => {
          output = (output + chunk).slice(-200);
        });
        p.stderr.on('data', () => {});
        p.events.on('close', (code) => finish(code === 0));
        p.events.on('error', () => finish(false));
      });
    } catch {
      return { installed: false, account: null, models: [] };
    }
  }
  function snapshot() {
    return {
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
    };
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
      ![...tasks.values()].some(
        (t) => t.machineId === m.id && t.status === 'running',
      ),
      'На машине уже выполняется установка или вход',
      409,
    );
    if (tasks.size > 40)
      for (const [id, t] of tasks) if (t.status !== 'running') tasks.delete(id);
    const p = await openProcess(m, { provider, operation }, connectors);
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
        '\nНе удалось запустить процесс. Проверьте Node.js/npm и установку агента.';
      finish(1);
    });
    t.timer = setTimeout(() => finish(1), 10 * 60 * 1000);
    t.timer.unref();
    return { id: t.id };
  }
  async function handle(path, method, body, send) {
    if (!path.startsWith('/api/hub')) return false;
    if (path === '/api/hub' && method === 'GET') {
      send(snapshot());
      return true;
    }
    if (path === '/api/hub/local' && method === 'POST') {
      let m = store.list('servers').find((s) => s.transport === 'local');
      if (!m) {
        m = {
          id: randomUUID(),
          name: os.hostname(),
          host: '127.0.0.1',
          port: 0,
          username: os.userInfo().username,
          region: 'Этот компьютер',
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
        mode:
          body.mode ||
          (!p && body.provider === 'codex' ? 'read-only' : 'workspace-write'),
        model: String(body.model || '').slice(0, 120),
        title: 'Новый чат',
        status: 'idle',
        archived: false,
        createdAt: now(),
        updatedAt: now(),
        secret: { messages: [], approvals: [] },
      };
      save(session);
      send(publicRecord(session), 201);
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
          approvals: s.secret.approvals,
        });
        return true;
      }
      if (!sm[2] && method === 'PATCH') {
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
        s.status = 'connecting';
        if (!s.customTitle && !s.secret.messages.some((m) => m.role === 'user'))
          s.title = body.message.trim().slice(0, 70);
        save(s);
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
              updateSession(s.id, (x) => {
                if (x.status !== 'interrupted')
                  x.status =
                    result.stopReason === 'cancelled' ? 'interrupted' : 'idle';
                x.secret.approvals = [];
              });
            }
          } catch (error) {
            if (closed) return;
            const stopped = load(s.id, 'session').status === 'interrupted';
            if (!stopped) {
              updateSession(s.id, (x) => {
                x.status = 'error';
                x.secret.approvals = [];
              });
              addMessage(s.id, 'system', error.message);
            }
          }
        })();
        send({ accepted: true }, 202);
        return true;
      }
      if (method === 'POST' && sm[2] === 'stop') {
        const r = runtimes.get(s.id);
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
      /^\/api\/hub\/machines\/([a-f0-9-]+)\/agents\/(codex|opencode)(?:\/(install|login|logout))?$/,
    );
    if (am) {
      const m = machine(am[1]),
        provider = am[2];
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
      if (closed) return;
      closed = true;
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
