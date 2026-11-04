import { randomBytes } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import { localProcess } from './machine-process.mjs';
import { AgentRpc } from './agent-rpc.mjs';
import { profilePaths, profileTransfer, profileId } from './agent-profile.mjs';
import { assert } from './security.mjs';

const local = {
  id: 'account-vault',
  transport: 'local',
  platform: process.platform,
};
const transfer = (provider, id, operation, value) =>
  profileTransfer(
    (_machine, options) => localProcess(options),
    local,
    provider,
    id,
    operation,
    null,
    value,
  );
export async function removeBrokerProfile(provider, id) {
  profileId(id);
  const base = resolve(os.homedir(), '.mayplane', 'agent-profiles', provider);
  const target = resolve(profilePaths(provider, id).root);
  assert(relative(base, target) === id, 'Некорректный каталог авторизации');
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 100,
  });
}
export function authLink(value) {
  const url = new URL(value);
  assert(
    url.protocol === 'https:' && !url.username && !url.password,
    'Провайдер вернул недопустимую ссылку авторизации',
  );
  return url.href;
}
export function codexTokenData(auth) {
  const tokens = auth?.tokens;
  assert(
    typeof tokens?.access_token === 'string' && tokens.access_token.length,
    'Авторизация Codex не содержит токен доступа. Войдите повторно.',
  );
  let claims = {};
  try {
    claims = JSON.parse(
      Buffer.from(
        (tokens.id_token || tokens.access_token).split('.')[1],
        'base64url',
      ).toString(),
    );
  } catch {}
  const id =
    tokens.account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id;
  assert(
    typeof id === 'string' && id,
    'Не удалось определить аккаунт ChatGPT. Войдите повторно.',
  );
  return {
    accessToken: tokens.access_token,
    chatgptAccountId: id,
    chatgptPlanType:
      claims['https://api.openai.com/auth']?.chatgpt_plan_type || null,
  };
}
export async function codexBroker(id, auth, onLogin) {
  if (auth) await transfer('codex', id, 'profile-write', auth);
  const rpc = new AgentRpc(
    localProcess({ provider: 'codex', operation: 'agent', profileId: id }),
  );
  rpc.on('message', (message) => {
    if (message.id !== undefined) rpc.reject(message.id);
    if (message.method === 'account/login/completed') onLogin?.(message.params);
  });
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'mayplane_accounts', version: '0.3.0' },
    });
    rpc.notify('initialized');
  } catch (error) {
    rpc.close();
    await removeBrokerProfile('codex', id);
    throw error;
  }
  return {
    rpc,
    async read(refresh = false) {
      const result = await rpc.request('account/read', {
        refreshToken: refresh,
      });
      const credentials = await transfer('codex', id, 'profile-read');
      return { account: result.account, credentials };
    },
    async login(apiKey) {
      const result = await rpc.request(
        'account/login/start',
        apiKey ? { type: 'apiKey', apiKey } : { type: 'chatgptDeviceCode' },
      );
      return apiKey
        ? null
        : {
            url: authLink(result.verificationUrl),
            userCode: String(result.userCode || ''),
            loginId: result.loginId,
            mode: 'device',
          };
    },
    async close() {
      rpc.close();
      await removeBrokerProfile('codex', id);
    },
  };
}

export function legacyCredential(entry) {
  const v = entry.value;
  if (v.type === 'key')
    return {
      type: 'api',
      key: v.key,
      ...(v.metadata ? { metadata: v.metadata } : {}),
    };
  assert(
    v.type === 'oauth',
    'Этот способ авторизации нельзя передать на другую машину',
  );
  return {
    type: 'oauth',
    access: v.access,
    refresh: v.refresh,
    expires: v.expires,
    ...(v.metadata?.accountId ? { accountId: v.metadata.accountId } : {}),
    ...(v.metadata?.enterpriseUrl
      ? { enterpriseUrl: v.metadata.enterpriseUrl }
      : {}),
  };
}
export function credentialBundle(vendor, data, previous) {
  if (Array.isArray(data)) {
    const entry =
      data.find((e) => e.integrationID === vendor && e.active !== false) ||
      data.find((e) => e.integrationID === vendor);
    assert(
      entry?.value && ['key', 'oauth'].includes(entry.value.type),
      'Не найден переносимый аккаунт провайдера',
    );
    return { native2: [entry], legacy: { [vendor]: legacyCredential(entry) } };
  }
  const v = data?.[vendor];
  assert(
    v && ['api', 'oauth'].includes(v.type),
    'Аккаунт провайдера не найден. Повторите авторизацию.',
  );
  const old = previous?.native2?.[0];
  const value =
    v.type === 'api'
      ? {
          type: 'key',
          key: v.key,
          ...(v.metadata ? { metadata: v.metadata } : {}),
        }
      : {
          type: 'oauth',
          methodID: old?.value?.methodID || 'legacy',
          access: v.access,
          refresh: v.refresh,
          expires: v.expires,
          metadata: {
            ...old?.value?.metadata,
            ...(v.accountId ? { accountId: v.accountId } : {}),
            ...(v.enterpriseUrl ? { enterpriseUrl: v.enterpriseUrl } : {}),
          },
        };
  return {
    legacy: { [vendor]: v },
    native2: [
      {
        ...old,
        integrationID: vendor,
        label: old?.label || vendor,
        active: true,
        value,
      },
    ],
  };
}

export async function openCodeBroker(id) {
  const password = randomBytes(32).toString('base64url');
  const p = localProcess({
    provider: 'opencode',
    operation: 'auth-server',
    profileId: id,
    serverPassword: password,
  });
  const headers = {
    Authorization:
      'Basic ' + Buffer.from('opencode:' + password).toString('base64'),
    'Content-Type': 'application/json',
  };
  let url;
  try {
    url = await new Promise((resolveReady, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        p.close();
        reject(
          new Error(
            'OpenCode не запустил сервер авторизации за 25 секунд. Проверьте установку на машине панели.',
          ),
        );
      }, 25000);
      const fail = () => {
        clearTimeout(timer);
        reject(
          new Error(
            'Не удалось запустить OpenCode на машине панели. Установите агент и повторите.',
          ),
        );
      };
      p.stdout.on('data', (bytes) => {
        output = (output + bytes.toString()).slice(-4096);
        const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolveReady(match[0]);
        }
      });
      p.stderr.on('data', () => {});
      p.events.once('error', fail);
      p.events.once('close', fail);
    });
    const anonymous = await fetch(url + '/api/info', {
      signal: AbortSignal.timeout(5000),
    });
    assert(
      anonymous.status === 401,
      'OpenCode не защищает сервер авторизации паролем. Обновите агент.',
    );
  } catch (error) {
    p.close();
    await removeBrokerProfile('opencode', id);
    throw error;
  }
  let version = 2;
  async function request(path, method = 'GET', body, timeout = 20000) {
    const response = await fetch(url + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status === 204) return null;
    const value = await response.json().catch(() => null);
    assert(
      response.ok && value !== null,
      `OpenCode не выполнил запрос авторизации (HTTP ${response.status}). Проверьте способ входа и повторите.`,
      400,
    );
    return value;
  }
  const info = await request('/api/info').catch(() => null);
  if (!info?.version) version = 1;
  return {
    version,
    async providers() {
      if (version === 2) {
        const list = (await request('/api/integration')).data || [];
        return list
          .map((v) => ({
            id: v.id,
            name: v.name,
            methods: v.methods
              .filter((m) => ['oauth', 'key'].includes(m.type))
              .map((m) => ({
                id: m.id || 'key',
                type: m.type === 'key' ? 'api' : 'oauth',
                name:
                  m.label || (m.type === 'key' ? 'API-ключ' : 'Авторизация'),
                fields: m.form || [],
              })),
          }))
          .filter((v) => v.methods.length);
      }
      const all = await request('/provider'),
        methods = await request('/provider/auth');
      return (all.all || []).map((v) => ({
        id: v.id,
        name: v.name,
        methods: (methods[v.id] || [{ type: 'api', label: 'API-ключ' }]).map(
          (m, i) => ({
            id: String(i),
            type: m.type,
            name: m.label,
            fields: (m.prompts || []).map((f) => ({
              key: f.key,
              title: f.message,
              type: 'string',
              options: f.options,
              placeholder: f.placeholder,
              when: f.when ? [f.when] : undefined,
            })),
          }),
        ),
      }));
    },
    async restore(bundle) {
      if (!bundle) return;
      if (version === 2)
        for (const entry of bundle.native2)
          await request('/api/credential', 'POST', {
            id: entry.id,
            integrationID: entry.integrationID,
            label: entry.label,
            value: entry.value,
            activate: true,
          });
      else
        for (const [vendor, value] of Object.entries(bundle.legacy))
          await request('/auth/' + encodeURIComponent(vendor), 'PUT', value);
    },
    async login(vendor, method, inputs, label, apiKey) {
      if (apiKey) {
        if (version === 2)
          await request(
            `/api/integration/${encodeURIComponent(vendor)}/connect/key`,
            'POST',
            { key: apiKey, answer: inputs || {}, label },
          );
        else
          await request('/auth/' + encodeURIComponent(vendor), 'PUT', {
            type: 'api',
            key: apiKey,
            ...(inputs && Object.keys(inputs).length
              ? { metadata: inputs }
              : {}),
          });
        return null;
      }
      const result =
        version === 2
          ? (
              await request(
                `/api/integration/${encodeURIComponent(vendor)}/connect/oauth`,
                'POST',
                { methodID: method, answer: inputs || {}, label },
              )
            ).data
          : await request(
              `/provider/${encodeURIComponent(vendor)}/oauth/authorize`,
              'POST',
              { method: Number(method), inputs: inputs || {} },
            );
      return {
        url: authLink(result.url),
        instructions: String(result.instructions || '').slice(0, 4000),
        mode: result.mode || result.method,
        attemptId: result.attemptID,
        method,
        vendor,
      };
    },
    async poll(login) {
      if (version === 1) return { status: 'pending' };
      return (
        await request(
          `/api/integration/${encodeURIComponent(login.vendor)}/connect/oauth/${encodeURIComponent(login.attemptId)}`,
        )
      ).data;
    },
    async complete(login, code) {
      if (version === 2)
        await request(
          `/api/integration/${encodeURIComponent(login.vendor)}/connect/oauth/${encodeURIComponent(login.attemptId)}/complete`,
          'POST',
          { code },
        );
      else
        await request(
          `/provider/${encodeURIComponent(login.vendor)}/oauth/callback`,
          'POST',
          { method: Number(login.method), ...(code ? { code } : {}) },
          10 * 60 * 1000,
        );
    },
    async credentials(vendor, previous) {
      const data =
        version === 2
          ? (await request('/api/credential')).data
          : await transfer('opencode', id, 'profile-read');
      return credentialBundle(vendor, data, previous);
    },
    async close() {
      p.close();
      await removeBrokerProfile('opencode', id);
    },
  };
}
