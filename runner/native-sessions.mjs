import { randomUUID } from 'node:crypto';
import { AgentRpc } from './agent-rpc.mjs';
import { assert } from './security.mjs';
import { projectPath } from './machine-process.mjs';

const iso = (value) => {
  const date = new Date(
    typeof value === 'number' ? value * 1000 : value || Date.now(),
  );
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
};
const validId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const title = (value) => String(value || 'Диалог с машины').slice(0, 100);
export function createNativeSessions({ openProcess, connectors }) {
  const probes = new Set();
  let opening = 0,
    closed = false;
  async function probe(machine, provider, fn) {
    assert(
      !closed && probes.size + opening < 4,
      'Дождитесь завершения чтения диалогов',
      429,
    );
    opening++;
    let rpc;
    try {
      const p = await openProcess(
        machine,
        { provider, operation: 'agent', nativeDesktop: provider === 'codex' },
        connectors,
      );
      rpc = new AgentRpc(p);
      probes.add(rpc);
      rpc.on('message', (m) => {
        if (m.id !== undefined) rpc.reject(m.id);
      });
    } finally {
      opening--;
    }
    if (closed) {
      rpc.close();
      throw new Error('Панель останавливается');
    }
    const deadline = setTimeout(
      () => rpc.close(new Error('Агент не вернул историю за 25 секунд')),
      25000,
    );
    try {
      const init = await rpc.request(
        'initialize',
        provider === 'codex'
          ? {
              clientInfo: { name: 'mayplane_history', version: '0.3.0' },
              capabilities: { experimentalApi: true },
            }
          : {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: 'mayplane_history', version: '0.3.0' },
            },
      );
      if (provider === 'codex') rpc.notify('initialized');
      return await fn(rpc, init);
    } catch (error) {
      if (/paginated_threads|not supported yet/.test(error.message))
        throw Object.assign(
          new Error(
            'CLI Codex не поддерживает формат истории приложения. Обновите CLI или используйте встроенный CLI настольного Codex через MAYPLANE_CODEX_BIN.',
          ),
          { status: 409 },
        );
      throw error;
    } finally {
      clearTimeout(deadline);
      probes.delete(rpc);
      rpc.close();
    }
  }
  function summary(machine, provider, row) {
    const id = provider === 'codex' ? row.id : row.sessionId;
    assert(validId(id), 'Агент вернул некорректный ID диалога');
    const cwd = projectPath(row.cwd, machine.platform || 'linux');
    return {
      nativeId: id,
      cwd,
      title: title(row.name || row.title || row.preview),
      updatedAt: iso(row.updatedAt),
      active: row.status?.type === 'active',
      ...(provider === 'codex' ? { modelProvider: row.modelProvider } : {}),
    };
  }
  return {
    async list(machine, provider, { cursor = null, cwd } = {}) {
      assert(['codex', 'opencode'].includes(provider), 'Выберите агента');
      assert(
        cursor === null ||
          (typeof cursor === 'string' && cursor.length <= 4096),
        'Некорректная страница',
      );
      if (cwd) cwd = projectPath(cwd, machine.platform || 'linux');
      return probe(machine, provider, async (rpc, init) => {
        if (provider === 'opencode')
          assert(
            init.agentCapabilities?.sessionCapabilities?.list,
            'Эта версия OpenCode не поддерживает список диалогов через ACP. Обновите OpenCode до версии 2.',
            409,
          );
        const result = await rpc.request(
          provider === 'codex' ? 'thread/list' : 'session/list',
          provider === 'codex'
            ? {
                limit: 50,
                cursor,
                modelProviders: [],
                sourceKinds: ['cli', 'vscode', 'appServer'],
                sortKey: 'updated_at',
                useStateDbOnly: true,
                ...(cwd ? { cwd } : {}),
              }
            : { ...(cursor ? { cursor } : {}), ...(cwd ? { cwd } : {}) },
        );
        const rows = provider === 'codex' ? result.data : result.sessions;
        assert(Array.isArray(rows), 'Агент не вернул список диалогов');
        const sessions = [];
        for (const row of rows.slice(0, 100)) {
          try {
            sessions.push(summary(machine, provider, row));
          } catch {
            /* Ignore incompatible entries, never accept unsafe paths. */
          }
        }
        return { sessions, nextCursor: result.nextCursor || null };
      });
    },
    async read(machine, provider, nativeId, cwd) {
      assert(
        ['codex', 'opencode'].includes(provider) && validId(nativeId),
        'Некорректный диалог',
      );
      return probe(machine, provider, async (rpc, init) => {
        const messages = [];
        let total = 0;
        function add(role, text, id = randomUUID(), at) {
          if (!text || total >= 4 * 1024 * 1024) return;
          const content = String(text).slice(0, 262144);
          const previous = messages.find((m) => m.id === String(id));
          if (previous) {
            previous.content = content;
            return;
          }
          total += content.length;
          messages.push({ id: String(id), role, content, createdAt: iso(at) });
          if (messages.length > 2000) messages.shift();
        }
        if (provider === 'codex') {
          const { thread } = await rpc.request('thread/read', {
            threadId: nativeId,
            includeTurns: false,
          });
          assert(thread?.id === nativeId, 'Диалог не найден', 404);
          assert(
            thread.status?.type !== 'active',
            'Сначала завершите ход в исходном Codex',
            409,
          );
          let turns;
          try {
            const entries = [];
            let cursor;
            for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
              const page = await rpc.request('thread/items/list', {
                threadId: nativeId,
                limit: 20,
                sortDirection: 'desc',
                ...(cursor ? { cursor } : {}),
              });
              assert(
                Array.isArray(page.data),
                'Codex не вернул элементы истории',
              );
              entries.push(...page.data);
              cursor = page.nextCursor;
              if (!cursor || JSON.stringify(entries).length > 3 * 1024 * 1024)
                break;
            }
            turns = entries.reverse().map((entry) => ({
              items: [entry.item],
              startedAt: entry.startedAt,
            }));
          } catch (error) {
            if (rpc.dead) throw error;
            turns = (
              await rpc.request('thread/read', {
                threadId: nativeId,
                includeTurns: true,
              })
            ).thread.turns;
          }
          assert(Array.isArray(turns), 'Codex не вернул историю диалога');
          for (const turn of turns)
            for (const item of turn.items || []) {
              if (!item) continue;
              if (item.type === 'userMessage')
                add(
                  'user',
                  (item.content || [])
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text)
                    .join('\n'),
                  item.id,
                  turn.startedAt,
                );
              if (item.type === 'agentMessage')
                add('assistant', item.text, item.id, turn.startedAt);
              if (item.type === 'commandExecution')
                add(
                  'tool',
                  [item.command, item.aggregatedOutput]
                    .filter(Boolean)
                    .join('\n'),
                  item.id,
                  turn.startedAt,
                );
              if (item.type === 'fileChange')
                add(
                  'tool',
                  JSON.stringify(item.changes || []),
                  item.id,
                  turn.startedAt,
                );
            }
          return { ...summary(machine, provider, thread), messages };
        }
        assert(
          init.agentCapabilities?.loadSession,
          'OpenCode не поддерживает загрузку диалогов',
          409,
        );
        cwd = projectPath(cwd, machine.platform || 'linux');
        let chunk;
        rpc.on('message', (m) => {
          const u = m.params?.update;
          if (m.method !== 'session/update' || m.params?.sessionId !== nativeId)
            return;
          const role =
            u?.sessionUpdate === 'user_message_chunk'
              ? 'user'
              : u?.sessionUpdate === 'agent_message_chunk'
                ? 'assistant'
                : null;
          if (role && u.content?.type === 'text') {
            if (chunk?.role === role && total < 4 * 1024 * 1024) {
              chunk.content = (chunk.content + u.content.text).slice(0, 262144);
              total += u.content.text.length;
            } else {
              add(role, u.content.text);
              chunk = messages.at(-1);
            }
          } else if (
            ['tool_call', 'tool_call_update'].includes(u?.sessionUpdate)
          ) {
            chunk = null;
            add(
              'tool',
              JSON.stringify({
                title: u.title,
                status: u.status,
                content: u.content,
              }),
              u.toolCallId,
            );
          }
        });
        await rpc.request('session/load', {
          sessionId: nativeId,
          cwd,
          mcpServers: [],
        });
        return {
          nativeId,
          cwd,
          title: title(messages.find((m) => m.role === 'user')?.content),
          messages,
        };
      });
    },
    close() {
      closed = true;
      for (const rpc of probes) rpc.close();
      probes.clear();
    },
  };
}
