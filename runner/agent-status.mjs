import { redact } from './security.mjs';

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
