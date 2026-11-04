import { randomUUID } from 'node:crypto';
import { assert } from './security.mjs';
import {
  codexBroker,
  openCodeBroker,
  codexTokenData,
  credentialBundle,
  removeBrokerProfile,
} from './account-brokers.mjs';
import { agentVersion } from './agent-status.mjs';
import { profileTransfer } from './agent-profile.mjs';

const now = () => new Date().toISOString();
export function createAccounts(
  store,
  {
    openProcess,
    connectors,
    onChanged = () => {},
    codexLogin = codexBroker,
    openCodeLogin = openCodeBroker,
  } = {},
) {
  const pending = new Map(),
    locks = new Map(),
    leases = new Map(),
    versions = new Map();
  const starting = new Set();
  const refreshing = new Map(),
    profileLocks = new Map();
  let discovery;
  let closed = false;
  const list = () =>
    store.list('settings').filter((a) => a.recordType === 'agent_account');
  const save = (a) => {
    a.updatedAt = now();
    store.save('settings', a, a.secret || {});
  };
  const load = (id) => {
    assert(
      typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id),
      'Некорректный аккаунт',
    );
    const a = store.get('settings', id);
    assert(a?.recordType === 'agent_account', 'Аккаунт не найден', 404);
    return a;
  };
  const publicAccount = (a) => ({
    id: a.id,
    provider: a.provider,
    vendor: a.vendor,
    name: a.name,
    status: a.status,
    authType: a.authType,
    methodName: a.methodName,
    email: a.email,
    planType: a.planType,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    error: a.error,
    pendingCleanup: store
      .list('settings')
      .filter(
        (t) =>
          t.recordType === 'account_target' &&
          t.accountId === a.id &&
          t.credentialPresent &&
          (t.retired ||
            a.status === 'disconnected' ||
            (a.authGeneration || 0) !== (t.authGeneration || 0)),
      ).length,
  });
  const connected = (id, provider) => {
    assert(!starting.has(id), 'Дождитесь завершения авторизации аккаунта', 409);
    const a = load(id);
    assert(
      !provider || a.provider === provider,
      'Аккаунт принадлежит другому агенту',
    );
    assert(
      a.status === 'connected' && a.secret.credentials,
      'Подключите аккаунт в настройках или выберите другой.',
      403,
    );
    return a;
  };
  for (const meta of list()) {
    if (meta.status === 'pending') {
      const a = load(meta.id);
      a.status = a.secret.credentials ? 'connected' : 'disconnected';
      a.error = 'Вход прерван перезапуском панели. Повторите авторизацию.';
      save(a);
    }
    if (meta.brokerId)
      void removeBrokerProfile(meta.provider, meta.brokerId).catch(() => {});
  }
  async function serial(id, fn) {
    const before = locks.get(id) || Promise.resolve();
    const work = before.catch(() => {}).then(fn);
    locks.set(id, work);
    try {
      return await work;
    } finally {
      if (locks.get(id) === work) locks.delete(id);
    }
  }
  async function withProfile(target, fn) {
    const key = `${target.machineId}:${target.provider}:${target.profileId}`;
    const before = profileLocks.get(key) || Promise.resolve();
    const work = before.catch(() => {}).then(fn);
    profileLocks.set(key, work);
    try {
      return await work;
    } finally {
      if (profileLocks.get(key) === work) profileLocks.delete(key);
    }
  }
  const inUse = (id) =>
    store
      .list('settings')
      .some(
        (s) =>
          s.recordType === 'session' &&
          s.accountId === id &&
          ['connecting', 'running', 'approval'].includes(s.status),
      );
  async function providers(provider) {
    if (provider === 'codex')
      return [
        {
          id: 'chatgpt',
          name: 'ChatGPT / OpenAI',
          methods: [
            { id: 'oauth', type: 'oauth', name: 'Войти с ChatGPT', fields: [] },
            { id: 'api', type: 'api', name: 'OpenAI API-ключ', fields: [] },
          ],
        },
      ];
    assert(provider === 'opencode', 'Выберите агента');
    if (discovery) return discovery;
    discovery = (async () => {
      const id = randomUUID(),
        broker = await openCodeLogin(id);
      try {
        return await broker.providers();
      } finally {
        await broker.close();
      }
    })();
    try {
      return await discovery;
    } finally {
      discovery = null;
    }
  }
  async function cancel(id) {
    const work = pending.get(id);
    pending.delete(id);
    if (work) {
      clearTimeout(work.timer);
      clearInterval(work.poll);
      await work.broker.close().catch(() => {});
    }
    const a = load(id);
    if (a.status === 'pending') {
      a.status = a.secret.credentials ? 'connected' : 'disconnected';
      a.error = '';
      save(a);
    }
  }
  async function finish(id, work) {
    if (!work || closed || pending.get(id) !== work) return;
    if (work.finishing) return work.completion;
    work.finishing = true;
    work.completion = (async () => {
      try {
        const a = load(id);
        if (a.provider === 'codex') {
          const result = await work.broker.read();
          if (closed || pending.get(id) !== work) return;
          assert(result.account, 'Авторизация Codex не завершена');
          a.secret.credentials = result.credentials;
          a.email = result.account.email || null;
          a.planType = result.account.planType || null;
          a.authType = result.credentials.tokens ? 'oauth' : 'api';
        } else {
          const credentials = await work.broker.credentials(
            a.vendor,
            a.secret.credentials,
          );
          if (closed || pending.get(id) !== work) return;
          a.secret.credentials = credentials;
          a.authType =
            a.secret.credentials.legacy[a.vendor].type === 'oauth'
              ? 'oauth'
              : 'api';
        }
        a.status = 'connected';
        a.authGeneration = (a.authGeneration || 0) + 1;
        a.error = '';
        save(a);
        clearTimeout(work.timer);
        clearInterval(work.poll);
        pending.delete(id);
        onChanged(a.id);
        await work.broker.close();
      } catch {
        if (!closed && pending.get(id) === work) {
          const a = load(id);
          a.status = 'error';
          a.error =
            'Авторизация не завершилась. Повторите вход или проверьте способ авторизации.';
          save(a);
          pending.delete(id);
          clearTimeout(work.timer);
          clearInterval(work.poll);
          await work.broker.close().catch(() => {});
        }
      }
    })();
    return work.completion;
  }
  async function start(id, body) {
    assert(
      !starting.has(id) &&
        !locks.has(id) &&
        !leases.has(id) &&
        pending.size + starting.size < 4,
      'Вход уже выполняется. Завершите или отмените текущую авторизацию.',
      409,
    );
    starting.add(id);
    try {
      return await startWork(id, body);
    } finally {
      starting.delete(id);
    }
  }
  async function startWork(id, body) {
    assert(
      !inUse(id),
      'Остановите чаты этого аккаунта перед повторным входом',
      409,
    );
    await cancel(id);
    const a = load(id);
    assert(
      pending.size < 4,
      'Одновременно можно авторизовать не более четырёх аккаунтов',
      429,
    );
    const brokerId = randomUUID();
    a.brokerId = brokerId;
    a.status = 'pending';
    a.error = '';
    save(a);
    let work;
    try {
      const broker =
        a.provider === 'codex'
          ? await codexLogin(brokerId, null, (event) => {
              if (event.success) void finish(id, work);
              else if (work && pending.get(id) === work)
                void fail(id, work, 'Вход отменён или отклонён провайдером.');
            })
          : await openCodeLogin(brokerId);
      work = { broker, login: null, finishing: false };
      pending.set(id, work);
      const available =
        a.provider === 'codex'
          ? (await providers('codex'))[0].methods
          : (await broker.providers()).find((v) => v.id === a.vendor)?.methods;
      const method = available?.find((m) => m.id === body.method);
      assert(method, 'Выберите поддерживаемый способ входа');
      if (method.type === 'api')
        assert(
          typeof body.apiKey === 'string' &&
            body.apiKey.trim() &&
            body.apiKey.length <= 32768,
          'Введите API-ключ',
        );
      const key = method.type === 'api' ? body.apiKey.trim() : null;
      a.methodName = method.name;
      save(a);
      work.login =
        a.provider === 'codex'
          ? await broker.login(key)
          : await broker.login(
              a.vendor,
              method.id,
              body.inputs || {},
              a.name,
              key,
            );
      if (!work.login) await finish(id, work);
      else {
        work.timer = setTimeout(
          () =>
            void fail(
              id,
              work,
              'Срок ожидания входа истёк. Повторите авторизацию.',
            ),
          15 * 60 * 1000,
        );
        work.timer.unref();
        if (a.provider === 'opencode' && broker.version === 2) {
          work.poll = setInterval(() => {
            if (!work.polling && !closed) {
              work.polling = true;
              void detail(id)
                .catch(() => {})
                .finally(() => {
                  work.polling = false;
                });
            }
          }, 2500);
          work.poll.unref();
        }
        if (
          a.provider === 'opencode' &&
          broker.version === 1 &&
          work.login.mode === 'auto'
        )
          void broker
            .complete(work.login)
            .then(() => finish(id, work))
            .catch(() =>
              fail(id, work, 'Вход не завершён. Повторите авторизацию.'),
            );
      }
      return detail(id);
    } catch (error) {
      if (work)
        await fail(
          id,
          work,
          'Не удалось начать авторизацию. Проверьте установленный агент и повторите.',
        );
      else {
        a.status = 'error';
        a.error =
          'Не удалось запустить агент для авторизации на машине панели.';
        save(a);
      }
      throw error.status
        ? error
        : Object.assign(
            new Error(
              'Не удалось выполнить авторизацию. Проверьте установленный агент и повторите вход.',
            ),
            { status: 400 },
          );
    }
  }
  async function fail(id, work, message) {
    if (closed || pending.get(id) !== work) return;
    pending.delete(id);
    clearTimeout(work.timer);
    clearInterval(work.poll);
    const a = load(id);
    a.status = 'error';
    a.error = message;
    save(a);
    await work.broker.close().catch(() => {});
  }
  async function detail(id) {
    const work = pending.get(id);
    let a = load(id);
    if (
      work &&
      a.provider === 'opencode' &&
      work.broker.version === 2 &&
      work.login &&
      !work.finishing
    ) {
      const state = await work.broker.poll(work.login);
      if (state.status === 'complete') await finish(id, work);
      else if (['expired', 'failed'].includes(state.status))
        await fail(
          id,
          work,
          'Провайдер не завершил вход. Повторите авторизацию.',
        );
      a = load(id);
    }
    return {
      ...publicAccount(a),
      ...(pending.get(id)?.login ? { login: pending.get(id).login } : {}),
    };
  }
  async function getCodexAuth(id, force = false) {
    if (refreshing.has(id)) return refreshing.get(id);
    const work = serial(id, async () => {
      const a = connected(id, 'codex'),
        auth = a.secret.credentials;
      if (auth.OPENAI_API_KEY)
        return { type: 'apiKey', apiKey: auth.OPENAI_API_KEY };
      let claims = {};
      try {
        claims = JSON.parse(
          Buffer.from(
            auth.tokens?.access_token.split('.')[1] || '',
            'base64url',
          ).toString(),
        );
      } catch {}
      if (!force && claims.exp && claims.exp * 1000 > Date.now() + 120000)
        return { type: 'chatgptAuthTokens', ...codexTokenData(auth) };
      const brokerId = randomUUID();
      a.brokerId = brokerId;
      save(a);
      const broker = await codexLogin(brokerId, auth);
      try {
        const result = await broker.read(true);
        assert(result.account, 'Аккаунт требует повторного входа');
        a.secret.credentials = result.credentials;
        a.email = result.account.email || a.email;
        a.planType = result.account.planType || a.planType;
        save(a);
        return {
          type: 'chatgptAuthTokens',
          ...codexTokenData(result.credentials),
        };
      } catch {
        a.status = 'error';
        a.error =
          'Не удалось обновить доступ Codex. Войдите в аккаунт повторно.';
        save(a);
        throw Object.assign(new Error(a.error), { status: 403 });
      } finally {
        await broker.close().catch(() => {});
      }
    });
    if (force) refreshing.set(id, work);
    try {
      return await work;
    } finally {
      if (refreshing.get(id) === work) refreshing.delete(id);
    }
  }
  async function formatFor(machine) {
    if (versions.has(machine.id)) return versions.get(machine.id);
    const version = await agentVersion(
      machine,
      'opencode',
      openProcess,
      connectors,
    );
    assert(version.installed, 'Установите OpenCode на выбранной машине');
    const major = Number(
      (version.version || '').match(/(?:^|\s)v?(\d+)\./i)?.[1],
    );
    const format = major >= 2 ? 'opencode-v2' : 'opencode-v1';
    versions.set(machine.id, format);
    return format;
  }
  function targetRecord(machine, profile, a, format) {
    assert(store.get('servers', machine.id), 'Машина уже удалена', 404);
    const key = `account-target:${machine.id}:${a.provider}:${profile}`;
    const target = {
      id: key,
      recordType: 'account_target',
      machineId: machine.id,
      profileId: profile,
      accountId: a.id,
      provider: a.provider,
      vendor: a.vendor,
      format,
      authGeneration: a.authGeneration || 0,
      credentialPresent: a.provider === 'opencode' || a.authType === 'api',
    };
    store.save('settings', target, {});
    return target;
  }
  function clearTarget(target) {
    const current = store.get('settings', target.id);
    if (
      closed ||
      !current ||
      !store.get('servers', target.machineId) ||
      current.accountId !== target.accountId ||
      (current.authGeneration || 0) !== (target.authGeneration || 0)
    )
      return;
    if (current.retired)
      store.db.prepare('DELETE FROM settings WHERE id=?').run(current.id);
    else store.save('settings', { ...current, credentialPresent: false }, {});
  }
  async function cleanupMachine(machine) {
    if (closed) return;
    for (const target of store
      .list('settings')
      .filter(
        (t) =>
          t.recordType === 'account_target' &&
          t.machineId === machine.id &&
          t.credentialPresent,
      )) {
      const account = load(target.accountId);
      const needsCleanup = (a, t) =>
        t.retired ||
        a.status === 'disconnected' ||
        (a.authGeneration || 0) !== (t.authGeneration || 0);
      if (!needsCleanup(account, target)) continue;
      if (target.retired && leases.has(account.id)) continue;
      try {
        if (
          target.retired &&
          account.provider === 'opencode' &&
          account.authType === 'oauth' &&
          account.status === 'connected' &&
          (account.authGeneration || 0) === (target.authGeneration || 0)
        ) {
          await recover(account, target.id);
          continue;
        }
        await withProfile(target, async () => {
          const current = store.get('settings', target.id);
          if (
            current?.accountId !== target.accountId ||
            !current.credentialPresent ||
            !needsCleanup(load(target.accountId), current)
          )
            return;
          await profileTransfer(
            openProcess,
            machine,
            target.provider,
            target.profileId,
            'profile-clear',
            connectors,
            null,
            target.format,
            target.vendor,
          );
          clearTarget(target);
        });
      } catch {}
    }
  }
  async function recover(a, onlyTarget) {
    for (const target of store
      .list('settings')
      .filter(
        (t) =>
          t.recordType === 'account_target' &&
          t.accountId === a.id &&
          (!onlyTarget || t.id === onlyTarget) &&
          t.credentialPresent,
      )) {
      const machine = store.get('servers', target.machineId);
      assert(
        machine,
        'Машина с обновлённым токеном удалена. Войдите в аккаунт повторно.',
        403,
      );
      let bundle;
      await withProfile(target, async () => {
        const current = store.get('settings', target.id);
        if (current?.accountId !== a.id || !current.credentialPresent) return;
        try {
          bundle = await profileTransfer(
            openProcess,
            machine,
            'opencode',
            target.profileId,
            'profile-read',
            connectors,
            null,
            target.format,
            target.vendor,
          );
        } catch {
          throw Object.assign(
            new Error(
              `Подключите машину ${machine.name}, чтобы сохранить обновлённую авторизацию, или войдите в аккаунт повторно.`,
            ),
            { status: 409 },
          );
        }
        const contains = Array.isArray(bundle)
          ? bundle.some((e) => e.integrationID === a.vendor)
          : !!bundle?.[a.vendor];
        const latestAccount = load(a.id);
        if (
          contains &&
          latestAccount.status === 'connected' &&
          (target.authGeneration || 0) === (latestAccount.authGeneration || 0)
        ) {
          latestAccount.secret.credentials = credentialBundle(
            a.vendor,
            bundle,
            latestAccount.secret.credentials,
          );
          save(latestAccount);
          Object.assign(a, latestAccount);
        }
        if (contains)
          await profileTransfer(
            openProcess,
            machine,
            'opencode',
            target.profileId,
            'profile-clear',
            connectors,
            null,
            target.format,
            target.vendor,
          );
        clearTarget(target);
      });
    }
  }
  async function prepare(machine, provider, id, profile) {
    if (!id) return async () => {};
    const a = connected(id, provider);
    if (provider === 'codex') {
      await profileTransfer(
        openProcess,
        machine,
        provider,
        profile,
        'profile-clear',
        connectors,
      );
      targetRecord(machine, profile, a, 'codex');
      return async () => {};
    }
    if (a.authType === 'oauth')
      assert(
        !leases.has(id),
        'Этот OAuth-аккаунт уже используется в другом чате. Дождитесь завершения или выберите другой аккаунт.',
        409,
      );
    const lease = randomUUID();
    if (a.authType === 'oauth') leases.set(id, lease);
    let format, target;
    try {
      if (a.authType === 'oauth') await recover(a);
      const prior = store.get(
        'settings',
        `account-target:${machine.id}:${provider}:${profile}`,
      );
      if (prior?.credentialPresent && prior.accountId !== id) {
        const owner = load(prior.accountId);
        if (owner.status === 'connected' && owner.authType === 'oauth') {
          assert(
            !leases.has(owner.id),
            'Предыдущий аккаунт ещё завершает работу. Повторите переключение.',
            409,
          );
          await recover(owner);
        }
      }
      format = await formatFor(machine);
      assert(
        !(
          format === 'opencode-v2' &&
          a.authType === 'oauth' &&
          a.secret.credentials.native2?.[0]?.value?.methodID === 'legacy'
        ),
        'Для переноса этого OAuth-аккаунта в OpenCode 2 обновите OpenCode на машине панели и войдите повторно.',
        409,
      );
      assert(
        !(
          format === 'opencode-v1' &&
          a.secret.credentials.native2?.[0]?.value?.methodID ===
            'chatgpt-token-sharing'
        ),
        'Этот способ входа требует OpenCode 2. Для этого сервера выберите Codex device code (legacy) или API-ключ.',
        409,
      );
      await withProfile(
        { machineId: machine.id, provider, profileId: profile },
        async () => {
          if (format === 'opencode-v2') {
            const existing = await profileTransfer(
              openProcess,
              machine,
              provider,
              profile,
              'profile-read',
              connectors,
              null,
              format,
              a.vendor,
            );
            if (Array.isArray(existing) && existing.length)
              await profileTransfer(
                openProcess,
                machine,
                provider,
                profile,
                'profile-clear',
                connectors,
                null,
                format,
                a.vendor,
              );
          }
          const current = connected(id, provider);
          assert(
            (current.authGeneration || 0) === (a.authGeneration || 0),
            'Аккаунт изменился. Повторите подключение.',
            409,
          );
          target = targetRecord(machine, profile, a, format);
          await profileTransfer(
            openProcess,
            machine,
            provider,
            profile,
            'profile-write',
            connectors,
            format === 'opencode-v2'
              ? a.secret.credentials.native2
              : a.secret.credentials.legacy,
            format,
            a.vendor,
          );
          const installed = await profileTransfer(
            openProcess,
            machine,
            provider,
            profile,
            'profile-read',
            connectors,
            null,
            format,
            a.vendor,
          );
          const confirmed = credentialBundle(
            a.vendor,
            installed,
            a.secret.credentials,
          );
          assert(
            a.authType === 'oauth' ||
              confirmed.legacy[a.vendor].key ===
                a.secret.credentials.legacy[a.vendor].key,
            'Машина не подтвердила подключение выбранного аккаунта. Обновите агент или коннектор.',
            409,
          );
        },
      );
    } catch (error) {
      if (leases.get(id) === lease) leases.delete(id);
      throw error;
    }
    return async () => {
      let captured = a.authType !== 'oauth';
      try {
        if (a.authType === 'oauth') {
          const latest = await profileTransfer(
            openProcess,
            machine,
            provider,
            profile,
            'profile-read',
            connectors,
            null,
            format,
            a.vendor,
          );
          if (!closed) {
            const current = load(id);
            if (current.status === 'connected') {
              current.secret.credentials = credentialBundle(
                a.vendor,
                latest,
                current.secret.credentials,
              );
              save(current);
              captured = true;
            }
          }
        }
      } finally {
        if (captured)
          try {
            await profileTransfer(
              openProcess,
              machine,
              provider,
              profile,
              'profile-clear',
              connectors,
              null,
              format,
              a.vendor,
            );
            clearTarget(target);
          } catch {}
        if (leases.get(id) === lease) leases.delete(id);
      }
    };
  }
  async function handle(path, method, body, send) {
    if (path === '/api/hub/accounts' && method === 'GET') {
      send({ accounts: list().map(publicAccount) });
      return true;
    }
    const discovery = path.match(
      /^\/api\/hub\/accounts\/providers\/(codex|opencode)$/,
    );
    if (discovery && method === 'GET') {
      send({ providers: await providers(discovery[1]) });
      return true;
    }
    if (path === '/api/hub/accounts' && method === 'POST') {
      assert(['codex', 'opencode'].includes(body.provider), 'Выберите агента');
      assert(
        typeof body.name === 'string' &&
          body.name.trim() &&
          body.name.length <= 80,
        'Название аккаунта: от 1 до 80 символов',
      );
      assert(list().length < 64, 'Можно сохранить не более 64 аккаунтов', 429);
      const vendor = body.provider === 'codex' ? 'chatgpt' : body.vendor;
      assert(
        typeof vendor === 'string' &&
          /^[a-z0-9][a-z0-9._-]{0,100}$/.test(vendor),
        'Выберите провайдера',
      );
      const a = {
        id: randomUUID(),
        recordType: 'agent_account',
        provider: body.provider,
        vendor,
        name: body.name.trim(),
        status: 'disconnected',
        createdAt: now(),
        updatedAt: now(),
        secret: {},
      };
      save(a);
      send(await start(a.id, body), 201);
      return true;
    }
    const match = path.match(
      /^\/api\/hub\/accounts\/([a-f0-9-]+)(?:\/(login|cancel|complete))?$/,
    );
    if (!match) return false;
    const a = load(match[1]);
    if (!match[2] && method === 'GET') {
      send(await detail(a.id));
      return true;
    }
    if (!match[2] && method === 'PATCH') {
      assert(
        typeof body.name === 'string' &&
          body.name.trim() &&
          body.name.length <= 80,
        'Название: от 1 до 80 символов',
      );
      a.name = body.name.trim();
      save(a);
      send(publicAccount(a));
      return true;
    }
    if (match[2] === 'login' && method === 'POST') {
      send(await start(a.id, body));
      return true;
    }
    if (match[2] === 'cancel' && method === 'POST') {
      assert(!starting.has(a.id), 'Дождитесь запуска авторизации', 409);
      await cancel(a.id);
      send(publicAccount(load(a.id)));
      return true;
    }
    if (match[2] === 'complete' && method === 'POST') {
      const work = pending.get(a.id);
      assert(
        work?.login && a.provider === 'opencode',
        'Авторизация уже закрыта',
        409,
      );
      assert(
        typeof body.code === 'string' &&
          body.code.trim() &&
          body.code.length <= 8192,
        'Введите код авторизации',
      );
      await work.broker.complete(work.login, body.code.trim());
      if (work.broker.version === 1) await finish(a.id, work);
      send(await detail(a.id));
      return true;
    }
    if (!match[2] && method === 'DELETE') {
      assert(
        !inUse(a.id) &&
          !leases.has(a.id) &&
          !locks.has(a.id) &&
          !starting.has(a.id),
        'Сначала остановите чаты этого аккаунта',
        409,
      );
      await cancel(a.id);
      const record = load(a.id);
      record.secret = {};
      record.status = 'disconnected';
      record.email = null;
      record.planType = null;
      record.error = '';
      save(record);
      onChanged(a.id);
      for (const m of store.list('servers'))
        if (m.agentAccounts?.[a.provider] === a.id) {
          m.agentAccounts = { ...m.agentAccounts, [a.provider]: null };
          store.save('servers', m, store.get('servers', m.id).secret);
        }
      await Promise.allSettled(
        store
          .list('servers')
          .filter((m) => m.transport === 'local' || m.status === 'online')
          .map((m) => cleanupMachine(store.get('servers', m.id))),
      );
      send({ ok: true, account: publicAccount(record) });
      return true;
    }
    return false;
  }
  return {
    handle,
    connected,
    prepare,
    getCodexAuth,
    cleanupMachine,
    list: () => list().map(publicAccount),
    invalidateMachine(id) {
      versions.delete(id);
    },
    async authenticate(rpc, id) {
      if (id)
        try {
          await rpc.request('account/login/start', await getCodexAuth(id));
        } catch {
          throw Object.assign(
            new Error(
              'Не удалось подключить выбранный аккаунт Codex. Войдите повторно в настройках.',
            ),
            { status: 403 },
          );
        }
    },
    async refresh(rpc, id, message) {
      try {
        const auth = await getCodexAuth(id, true);
        assert(
          !message.params?.previousAccountId ||
            message.params.previousAccountId === auth.chatgptAccountId,
          'Аккаунт ChatGPT изменился. Повторите вход.',
        );
        rpc.respond(message.id, {
          accessToken: auth.accessToken,
          chatgptAccountId: auth.chatgptAccountId,
          chatgptPlanType: auth.chatgptPlanType,
        });
      } catch {
        rpc.send({
          id: message.id,
          error: {
            code: -32001,
            message:
              'Аккаунт требует повторной авторизации в настройках mayplane',
          },
        });
      }
    },
    close() {
      closed = true;
      for (const work of pending.values()) {
        clearTimeout(work.timer);
        clearInterval(work.poll);
        void work.broker.close().catch(() => {});
      }
      pending.clear();
    },
  };
}
