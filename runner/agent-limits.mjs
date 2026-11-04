import { randomUUID } from 'node:crypto';
import { AgentRpc } from './agent-rpc.mjs';
import { assert } from './security.mjs';

const finite = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v) =>
  typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').slice(0, 160) : null;
function window(value) {
  const used = finite(value?.usedPercent);
  if (used == null) return null;
  const duration = finite(value.windowDurationMins);
  const reset = finite(value.resetsAt);
  return {
    usedPercent: Math.min(100, used),
    windowDurationMins: duration > 0 ? duration : null,
    resetsAt:
      reset > 0 && reset < 32503680000
        ? new Date(reset * 1000).toISOString()
        : null,
  };
}

// Strict projection: credentials, provider error bodies and arbitrary metadata
// must never travel to the browser with a quota response.
export function codexLimits(payload) {
  const buckets = new Map();
  const project = (value, fallback = 'codex') => {
    if (!value || typeof value !== 'object') return;
    const id = text(value.limitId) || text(fallback) || 'codex';
    const primary = window(value.primary),
      secondary = window(value.secondary);
    const c = value.credits;
    const balance =
      typeof c?.balance === 'string' && /^\d+(\.\d+)?$/.test(c.balance)
        ? Number(c.balance)
        : c?.balance;
    const credits =
      c && typeof c === 'object'
        ? {
            unlimited: c.unlimited === true,
            hasCredits: typeof c.hasCredits === 'boolean' ? c.hasCredits : null,
            balance: finite(balance),
          }
        : null;
    if (!primary && !secondary && !credits) return;
    buckets.set(id, {
      id,
      name: text(value.limitName) || (id === 'codex' ? 'Codex' : id),
      planType: text(value.planType),
      primary,
      secondary,
      credits,
    });
  };
  project(payload?.rateLimits);
  if (
    payload?.rateLimitsByLimitId &&
    typeof payload.rateLimitsByLimitId === 'object'
  )
    for (const [id, value] of Object.entries(payload.rateLimitsByLimitId).slice(
      0,
      32,
    ))
      project(value, id);
  const count = payload?.rateLimitResetCredits?.availableCount;
  return {
    buckets: [...buckets.values()],
    availableResets: Number.isSafeInteger(count) && count >= 0 ? count : null,
  };
}

export function sessionUsage(update) {
  const used = finite(update?.used),
    size = finite(update?.size);
  if (used == null || !size) return null;
  const amount = finite(update.cost?.amount);
  return {
    used,
    size,
    cost:
      amount != null && /^[A-Z]{3}$/.test(update.cost?.currency)
        ? { amount, currency: update.cost.currency }
        : null,
    updatedAt: new Date().toISOString(),
  };
}

export function createAgentLimits({
  openProcess,
  connectors,
  prepareAccount,
  authenticateAccount,
  refreshAccount,
}) {
  const entries = new Map(),
    probes = new Set();
  let closed = false,
    opening = 0;
  const keyOf = (machineId, provider, accountId) =>
    JSON.stringify([machineId, provider, accountId || null]);
  function entryFor(machineId, provider, accountId) {
    const key = keyOf(machineId, provider, accountId);
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= 64) {
        const idle = [...entries].find(([, e]) => !e.pending);
        assert(idle, 'Слишком много запросов лимитов', 429);
        entries.delete(idle[0]);
      }
      entry = {
        machineId,
        provider,
        accountId: accountId || null,
        profileId: accountId ? randomUUID() : undefined,
      };
      entries.set(key, entry);
    }
    return entry;
  }
  const response = (entry, value) => ({
    machineId: entry.machineId,
    provider: entry.provider,
    accountId: entry.accountId,
    buckets: [],
    availableResets: null,
    fetchedAt: new Date().toISOString(),
    ...value,
  });
  async function get(
    machine,
    provider,
    { accountId = null, refresh = false } = {},
  ) {
    assert(!closed, 'Исполнитель останавливается', 503);
    const entry = entryFor(machine.id, provider, accountId);
    if (provider !== 'codex')
      return response(entry, { status: 'unsupported', reason: 'provider' });
    if (entry.pending) return entry.pending;
    if (
      entry.value &&
      ((entry.expiresAt > Date.now() && !refresh) ||
        Date.now() - entry.lastAttempt < 5000)
    )
      return entry.value;
    assert(
      opening < 4,
      'Проверки лимитов уже выполняются. Повторите позже.',
      429,
    );
    const initialValue = entry.value;
    entry.lastAttempt = Date.now();
    entry.pending = (async () => {
      let rpc, release, deadline;
      opening++;
      try {
        if (accountId)
          release = await prepareAccount(
            machine,
            provider,
            accountId,
            entry.profileId,
          );
        const opened = await openProcess(
          machine,
          {
            provider,
            operation: 'agent',
            ...(entry.profileId ? { profileId: entry.profileId } : {}),
          },
          connectors,
        );
        if (closed) {
          opened.close();
          throw new Error('closed');
        }
        rpc = new AgentRpc(opened, { timeout: 15000 });
        probes.add(rpc);
        rpc.on('message', (message) => {
          if (message.id === undefined) return;
          if (
            message.method === 'account/chatgptAuthTokens/refresh' &&
            accountId
          )
            void refreshAccount(rpc, accountId, message).catch(() => {});
          else rpc.reject(message.id);
        });
        deadline = setTimeout(
          () => rpc.close(new Error('limits deadline')),
          20000,
        );
        await rpc.request('initialize', {
          clientInfo: { name: 'mayplane', version: '0.2.0' },
          ...(accountId ? { capabilities: { experimentalApi: true } } : {}),
        });
        rpc.notify('initialized');
        if (accountId) await authenticateAccount(rpc, accountId);
        const auth = await rpc.request('account/read', { refreshToken: false });
        let value;
        if (!auth.account)
          value = response(entry, {
            status:
              auth.requiresOpenaiAuth === false
                ? 'unsupported'
                : 'unauthenticated',
            reason: 'sign-in',
          });
        else if (
          ![
            'chatgpt',
            'chatgptAuthTokens',
            'agentIdentity',
            'personalAccessToken',
          ].includes(auth.account.type)
        )
          value = response(entry, { status: 'unsupported', reason: 'api-key' });
        else {
          const result = codexLimits(
            await rpc.request('account/rateLimits/read'),
          );
          value = response(entry, {
            status: result.buckets.length ? 'available' : 'unavailable',
            ...result,
          });
        }
        assert(
          !closed &&
            entries.get(keyOf(machine.id, provider, accountId)) === entry,
          'Аккаунт изменился. Обновите лимиты.',
          409,
        );
        // A notification received during the request is newer than its response.
        if (
          !(entry.value?.status === 'available' && entry.value !== initialValue)
        )
          entry.value = value;
        entry.expiresAt = Date.now() + 60000;
        return entry.value;
      } catch (error) {
        if (
          closed ||
          entries.get(keyOf(machine.id, provider, accountId)) !== entry
        )
          return response(entry, {
            status: 'unavailable',
            reason: 'unavailable',
          });
        const value =
          entry.value?.status === 'available'
            ? { ...entry.value, stale: true }
            : response(entry, {
                status:
                  error.status === 403
                    ? 'unauthenticated'
                    : /method.*not.*found|unknown.*method|unsupported/i.test(
                          error.message,
                        )
                      ? 'unsupported'
                      : 'unavailable',
                reason: error.status === 403 ? 'sign-in' : 'unavailable',
              });
        entry.value = value;
        entry.expiresAt = Date.now() + 15000;
        return value;
      } finally {
        opening--;
        clearTimeout(deadline);
        if (rpc) {
          probes.delete(rpc);
          rpc.close();
        }
        await release?.();
      }
    })();
    try {
      return await entry.pending;
    } finally {
      entry.pending = null;
    }
  }
  return {
    get,
    update(machineId, provider, accountId, payload) {
      if (closed || provider !== 'codex') return;
      const parsed = codexLimits(payload);
      if (!parsed.buckets.length) return;
      if (
        entries.size >= 64 &&
        !entries.has(keyOf(machineId, provider, accountId)) &&
        [...entries.values()].every((e) => e.pending)
      )
        return;
      const entry = entryFor(machineId, provider, accountId);
      const buckets = new Map(
        (entry.value?.buckets || []).map((b) => [b.id, b]),
      );
      for (const b of parsed.buckets) {
        const raw =
          Object.entries(payload.rateLimitsByLimitId || {}).find(
            ([id, v]) => (v?.limitId || id) === b.id,
          )?.[1] || payload.rateLimits;
        const previous = buckets.get(b.id);
        const merged = { ...previous, ...b };
        for (const field of ['primary', 'secondary', 'credits'])
          if (previous && raw && !Object.hasOwn(raw, field))
            merged[field] = previous[field];
        if (previous && !raw?.limitName) merged.name = previous.name;
        if (previous && !raw?.planType) merged.planType = previous.planType;
        buckets.set(b.id, merged);
      }
      entry.value = response(entry, {
        status: 'available',
        ...parsed,
        buckets: [...buckets.values()],
        availableResets:
          parsed.availableResets ?? entry.value?.availableResets ?? null,
      });
      entry.updatedAt = Date.now();
      entry.lastAttempt = Date.now();
      entry.expiresAt = Date.now() + 60000;
    },
    invalidateAccount(id) {
      for (const [key, entry] of entries)
        if (entry.accountId === id) entries.delete(key);
    },
    invalidateMachine(id, provider) {
      for (const [key, entry] of entries)
        if (
          entry.machineId === id &&
          (!provider || entry.provider === provider)
        )
          entries.delete(key);
    },
    close() {
      closed = true;
      for (const rpc of probes) rpc.close();
      entries.clear();
    },
  };
}
