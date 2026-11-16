import { redact } from './security.mjs';

async function claudeProbe(machine, operation, openProcess, connectors) {
  let process;
  try {
    process = await openProcess(
      machine,
      { provider: 'claude', operation },
      connectors,
    );
  } catch {
    return { ok: false, text: '' };
  }
  return new Promise((resolve) => {
    let text = '',
      done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.close();
      resolve({ ok: code === 0, text });
    };
    const timer = setTimeout(() => finish(1), 15000);
    process.stdout.on('data', (bytes) => {
      text = (text + bytes).slice(-32768);
    });
    process.stderr.on('data', () => {});
    process.events.on('close', finish);
    process.events.on('error', () => finish(1));
  });
}
export async function claudeStatus(
  machine,
  openProcess,
  connectors,
  account = null,
) {
  const version = await agentVersion(
    machine,
    'claude',
    openProcess,
    connectors,
  );
  if (!version.installed) return { ...version, account: null, models: [] };
  const [adapter, login] = await Promise.all([
    claudeProbe(machine, 'adapter-version', openProcess, connectors),
    account
      ? Promise.resolve({ ok: true, text: '{}' })
      : claudeProbe(machine, 'auth-status', openProcess, connectors),
  ]);
  let auth = {};
  try {
    auth = JSON.parse(login.text);
  } catch {}
  return {
    ...version,
    adapterVersion: adapter.ok ? adapter.text.trim().slice(0, 100) : null,
    ready: adapter.ok && (!!account || (login.ok && auth.loggedIn === true)),
    models: [],
    account: account
      ? { type: 'api_key', email: null, planType: null }
      : auth.loggedIn
        ? {
            type: String(auth.authMethod || 'native').slice(0, 80),
            email:
              typeof auth.email === 'string' ? auth.email.slice(0, 200) : null,
            planType:
              typeof auth.subscriptionType === 'string'
                ? auth.subscriptionType.slice(0, 100)
                : null,
          }
        : null,
    error: !adapter.ok
      ? 'Claude Code найден, но ACP-адаптер не установлен. Нажмите «Установить / обновить».'
      : !account && !auth.loggedIn
        ? 'Claude Code установлен. Добавьте API-ключ в настройках или войдите в штатный аккаунт на этой машине.'
        : undefined,
  };
}

export const agentError = (machine, message) =>
  redact(message, Object.values(machine.secret || {})).slice(-2000);

// Installation and account/protocol readiness are separate: a broken login or
// unsupported app-server must never turn an installed binary into "not found".
export async function agentVersion(
  machine,
  provider,
  openProcess,
  connectors,
  timeout = 10000,
) {
  let p;
  try {
    p = await openProcess(
      machine,
      { provider, operation: 'version' },
      connectors,
    );
  } catch (error) {
    return {
      installed: false,
      missing: error.code === 'ENOENT',
      error: agentError(machine, error.message),
    };
  }
  return new Promise((resolve) => {
    let output = '',
      errors = '',
      done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p.close();
      const installed = code === 0;
      resolve(
        installed
          ? {
              installed: true,
              version: agentError(machine, output).trim().slice(0, 100),
            }
          : {
              installed: false,
              missing:
                error?.code === 'ENOENT' ||
                (code === 127 &&
                  new RegExp(`\\b${provider}: (?:command )?not found\\b`).test(
                    errors,
                  )),
              error: agentError(
                machine,
                error?.message ||
                  errors.trim() ||
                  output.trim() ||
                  `Не удалось запустить ${provider} --version (код ${code ?? 'неизвестен'}).`,
              ),
            },
      );
    };
    const timer = setTimeout(
      () =>
        finish(
          null,
          new Error(
            `Агент не ответил на --version за ${timeout / 1000} секунд. Проверьте соединение и установку.`,
          ),
        ),
      timeout,
    );
    p.stdout.on('data', (bytes) => {
      output = (output + bytes.toString()).slice(-2000);
    });
    p.stderr.on('data', (bytes) => {
      errors = (errors + bytes.toString()).slice(-2000);
    });
    p.events.on('close', (code) => finish(code));
    p.events.on('error', (error) => finish(null, error));
  });
}
