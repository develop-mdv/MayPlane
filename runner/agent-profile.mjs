import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { assert, q } from './security.mjs';
import { agentPathSetup } from '../lib/agent-path.mjs';

export function profileId(value) {
  assert(
    typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(value),
    'Некорректный профиль аккаунта',
  );
  return value;
}
export function profilePaths(provider, id) {
  assert(['codex', 'opencode'].includes(provider), 'Неизвестный агент');
  const root = join(
    os.homedir(),
    '.ezdeploy',
    'agent-profiles',
    provider,
    profileId(id),
  );
  return {
    root,
    auth:
      provider === 'codex'
        ? join(root, 'codex', 'auth.json')
        : join(root, 'data', 'opencode', 'auth.json'),
  };
}
export function profileEnvironment(provider, id) {
  const { root } = profilePaths(provider, id);
  const env =
    provider === 'codex'
      ? { CODEX_HOME: join(root, 'codex') }
      : {
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_CACHE_HOME: join(root, 'cache'),
          XDG_STATE_HOME: join(root, 'state'),
        };
  for (const value of Object.values(env))
    mkdirSync(value, { recursive: true, mode: 0o700 });
  if (provider === 'opencode') {
    mkdirSync(join(root, 'data', 'opencode'), { recursive: true, mode: 0o700 });
    env.OPENCODE_DB = join(root, 'data', 'opencode', 'opencode.db');
  }
  return env;
}
export function posixProfileSetup(provider, id) {
  profileId(id);
  const root = `"$HOME/.ezdeploy/agent-profiles/${provider}/${id}"`;
  return (
    `umask 077\nfor __ez_name in $(env | cut -d= -f1); do\ncase "$__ez_name" in\n*_API_KEY|*_TOKEN|*_ACCESS_KEY|*_SECRET_ACCESS_KEY|*_CREDENTIALS|OPENAI_*|ANTHROPIC_*|CODEX_HOME|CODEX_SQLITE_HOME|OPENCODE_AUTH_CONTENT|OPENCODE_CONFIG|OPENCODE_CONFIG_CONTENT) unset "$__ez_name" ;;\nesac\ndone\n__ez_profile=${root}\nmkdir -p "$__ez_profile"\n` +
    (provider === 'codex'
      ? 'export CODEX_HOME="$__ez_profile/codex"\nunset CODEX_SQLITE_HOME OPENAI_API_KEY CODEX_ACCESS_TOKEN\nmkdir -p "$CODEX_HOME"\n'
      : 'export XDG_DATA_HOME="$__ez_profile/data" XDG_CONFIG_HOME="$__ez_profile/config" XDG_CACHE_HOME="$__ez_profile/cache" XDG_STATE_HOME="$__ez_profile/state"\nexport OPENCODE_DB="$XDG_DATA_HOME/opencode/opencode.db"\nunset OPENCODE_AUTH_CONTENT OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT\nmkdir -p "$XDG_DATA_HOME/opencode" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"\n')
  );
}
export function posixProfileOperation(
  provider,
  operation,
  id,
  format,
  vendor,
  credential,
) {
  const setup = posixProfileSetup(provider, id);
  if (format === 'opencode-v2') {
    assert(
      provider === 'opencode' &&
        typeof vendor === 'string' &&
        /^[a-z0-9][a-z0-9._-]{0,100}$/.test(vendor),
      'Некорректный провайдер аккаунта',
    );
    const prefix = `set -eu\n${agentPathSetup}\n${setup}`;
    if (operation === 'profile-read')
      return prefix + 'exec opencode auth export --standalone';
    if (operation === 'profile-clear') {
      assert(
        typeof credential === 'string' &&
          /^cred_[a-zA-Z0-9_-]+$/.test(credential),
        'Некорректные учётные данные',
      );
      return (
        prefix +
        `exec opencode auth logout ${q(vendor)} ${q(credential)} --standalone`
      );
    }
    assert(operation === 'profile-write', 'Неизвестная операция профиля');
    return (
      prefix +
      'IFS= read -r __ez_auth\nprintf \'%s\' "$__ez_auth" | opencode auth import --standalone'
    );
  }
  const file =
    provider === 'codex'
      ? '"$CODEX_HOME/auth.json"'
      : '"$XDG_DATA_HOME/opencode/auth.json"';
  if (operation === 'profile-read')
    return `set -eu\n${setup}if [ -f ${file} ]; then cat ${file}; else printf '{}'; fi`;
  if (operation === 'profile-clear') return `set -eu\n${setup}rm -f -- ${file}`;
  assert(operation === 'profile-write', 'Неизвестная операция профиля');
  return `set -eu\n${setup}IFS= read -r __ez_auth\n__ez_auth_file=${file}\nprintf '%s' "$__ez_auth" > "$__ez_auth_file.tmp"\nchmod 600 "$__ez_auth_file.tmp"\nmv -f -- "$__ez_auth_file.tmp" "$__ez_auth_file"\nunset __ez_auth`;
}
export function localProfileProcess({ provider, operation, profileId: id }) {
  const { auth } = profilePaths(provider, id);
  profileEnvironment(provider, id);
  const input = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough(),
    events = new EventEmitter();
  let done = false,
    data = '';
  const finish = (fn) => {
    if (done) return;
    done = true;
    try {
      fn();
      events.emit('close', 0);
    } catch {
      stderr.write('Не удалось обработать профиль аккаунта');
      events.emit('close', 1);
    }
  };
  if (operation === 'profile-write')
    input.on('data', (chunk) => {
      if (done) return;
      data += chunk.toString();
      if (data.length > 131072)
        return finish(() => {
          throw new Error('Too large');
        });
      if (!data.includes('\n')) return;
      finish(() => {
        const value = JSON.parse(data.slice(0, data.indexOf('\n')));
        writeFileSync(auth + '.tmp', JSON.stringify(value), { mode: 0o600 });
        renameSync(auth + '.tmp', auth);
        data = '';
      });
    });
  else
    setImmediate(() =>
      finish(() => {
        if (operation === 'profile-read') {
          try {
            stdout.write(readFileSync(auth));
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            stdout.write('{}');
          }
        } else if (operation === 'profile-clear') {
          try {
            unlinkSync(auth);
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
        } else throw new Error('Invalid operation');
      }),
    );
  return {
    input,
    stdout,
    stderr,
    events,
    close() {
      done = true;
      data = '';
    },
  };
}

export async function profileTransfer(
  openProcess,
  machine,
  provider,
  id,
  operation,
  connectors,
  credentials,
  profileFormat,
  profileVendor,
  profileCredential,
) {
  if (
    operation === 'profile-clear' &&
    profileFormat === 'opencode-v2' &&
    !profileCredential
  ) {
    const entries = await profileTransfer(
      openProcess,
      machine,
      provider,
      id,
      'profile-read',
      connectors,
      null,
      profileFormat,
      profileVendor,
    );
    assert(
      Array.isArray(entries),
      'Агент вернул неподдерживаемый формат авторизации',
    );
    for (const entry of entries)
      await profileTransfer(
        openProcess,
        machine,
        provider,
        id,
        operation,
        connectors,
        null,
        profileFormat,
        entry.integrationID,
        entry.id,
      );
    return null;
  }
  const p = await openProcess(
    machine,
    {
      provider,
      operation,
      profileId: profileId(id),
      ...(profileFormat ? { profileFormat, profileVendor } : {}),
      ...(profileCredential ? { profileCredential } : {}),
    },
    connectors,
  );
  return new Promise((resolve, reject) => {
    let output = '',
      done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p.close();
      if (error) reject(error);
      else {
        try {
          resolve(
            operation === 'profile-read' ? JSON.parse(output || '{}') : null,
          );
        } catch {
          reject(new Error('Агент вернул неподдерживаемый формат авторизации'));
        }
      }
    };
    const timer = setTimeout(
      () =>
        finish(new Error('Не удалось передать профиль аккаунта за 15 секунд')),
      15000,
    );
    p.stdout.on('data', (bytes) => {
      output += bytes.toString();
      if (output.length > 131072)
        finish(new Error('Превышен размер профиля аккаунта'));
    });
    p.stderr.on('data', () => {});
    p.input.on('error', () =>
      finish(
        new Error('Соединение закрыто во время передачи профиля аккаунта'),
      ),
    );
    p.events.on('error', () =>
      finish(
        new Error(
          'Машина не поддерживает профили аккаунтов. Обновите коннектор и повторите.',
        ),
      ),
    );
    p.events.on('close', (code) =>
      finish(
        code === 0
          ? null
          : new Error('Не удалось обработать профиль аккаунта на машине'),
      ),
    );
    if (operation === 'profile-write')
      p.input.write(JSON.stringify(credentials) + '\n');
  });
}
