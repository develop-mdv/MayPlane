import { spawn, execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { existsSync, statfsSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute, win32 } from 'node:path';
import os from 'node:os';
import { resourceMetrics } from '../lib/machine-metrics.mjs';
import { connect } from './ssh.mjs';
import { assert } from './security.mjs';
import { posixAgentCommand } from './agent-launch.mjs';
import {
  profileEnvironment,
  profileId as validateProfileId,
  localProfileProcess,
  posixProfileOperation,
} from './agent-profile.mjs';

export const providers = {
  codex: {
    name: 'Codex',
    executable: 'codex',
    package: '@openai/codex',
    args: ['app-server', '--listen', 'stdio://'],
  },
  opencode: {
    name: 'OpenCode',
    executable: 'opencode',
    package: '@opencode/cli',
    args: ['acp'],
  },
};
let desktopLookup;
function desktopCodex() {
  if (desktopLookup && desktopLookup.expires > Date.now())
    return desktopLookup.path;
  let path;
  if (process.platform === 'darwin')
    path = [
      join(os.homedir(), 'Applications/Codex.app/Contents/Resources/codex'),
      '/Applications/Codex.app/Contents/Resources/codex',
    ].find(existsSync);
  if (process.platform === 'win32')
    try {
      const base = execFileSync(
        join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation',
        ],
        {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      if (base && isAbsolute(base)) {
        const candidate = join(base, 'app/resources/codex.exe');
        if (existsSync(candidate)) path = candidate;
      }
    } catch {}
  desktopLookup = { path, expires: Date.now() + 60000 };
  return path;
}

export function projectPath(value, platform = 'linux') {
  assert(
    typeof value === 'string' &&
      value.length <= 1024 &&
      // Paths cannot contain terminal/shell control characters.
      // eslint-disable-next-line no-control-regex
      !/[\x00-\x1f]/.test(value),
    'Укажите абсолютный путь к проекту',
  );
  assert(
    platform === 'win32' ? /^[a-z]:[\\/]/i.test(value) : value.startsWith('/'),
    'Нужен абсолютный путь на выбранной машине',
  );
  assert(!value.split(/[\\/]/).includes('..'), 'Путь не должен содержать ..');
  return value;
}

export function processSpec(provider, operation, platform = process.platform) {
  const p = providers[provider];
  assert(p, 'Неизвестный агент');
  assert(
    [
      'agent',
      'version',
      'install',
      'login',
      'auth-server',
      'credential-export',
      'credential-import',
      'credential-clear',
      'profile-read',
      'profile-write',
      'profile-clear',
    ].includes(operation),
    'Неизвестная операция',
  );
  if (operation === 'auth-server') {
    assert(provider === 'opencode', 'Неизвестная операция');
    return {
      executable: p.executable,
      args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    };
  }
  if (operation.startsWith('credential-')) {
    assert(provider === 'opencode', 'Неизвестная операция');
    return {
      executable: p.executable,
      args: [
        'auth',
        operation === 'credential-import'
          ? 'import'
          : operation === 'credential-export'
            ? 'export'
            : 'logout',
        '--standalone',
      ],
    };
  }
  if (operation === 'install' && platform !== 'win32')
    return {
      executable: '/bin/bash',
      args: ['-c', posixAgentCommand(provider, operation, [])],
    };
  if (operation === 'install')
    return { executable: 'npm', args: ['install', '--global', p.package] };
  if (operation === 'login')
    return {
      executable: p.executable,
      args:
        provider === 'codex' ? ['login', '--device-auth'] : ['auth', 'login'],
    };
  return {
    executable: p.executable,
    args: operation === 'version' ? ['--version'] : p.args,
  };
}

export function localProcess({
  provider,
  operation,
  cwd,
  profileId,
  serverPassword,
  profileFormat,
  profileVendor,
  profileCredential,
  nativeDesktop,
}) {
  if (profileId) {
    validateProfileId(profileId);
    assert(
      operation !== 'install',
      'Установка агента не поддерживает профиль аккаунта',
    );
  }
  if (operation.startsWith('profile-') && profileFormat !== 'opencode-v2')
    return localProfileProcess({ provider, operation, profileId });
  if (operation.startsWith('profile-'))
    operation =
      operation === 'profile-read'
        ? 'credential-export'
        : operation === 'profile-write'
          ? 'credential-import'
          : 'credential-clear';
  let { executable, args } = processSpec(provider, operation);
  const desktop =
    provider === 'codex' &&
    nativeDesktop === true &&
    !profileId &&
    !process.env.MAYPLANE_CODEX_BIN
      ? desktopCodex()
      : null;
  if (operation === 'credential-clear') {
    assert(
      typeof profileVendor === 'string' &&
        /^[a-z0-9][a-z0-9._-]{0,100}$/.test(profileVendor),
      'Некорректный провайдер',
    );
    args.splice(2, 0, profileVendor);
    assert(
      typeof profileCredential === 'string' &&
        /^cred_[a-zA-Z0-9_-]+$/.test(profileCredential),
      'Некорректные учётные данные',
    );
    args.splice(3, 0, profileCredential);
  }
  if (process.platform !== 'win32' && operation !== 'install') {
    executable = '/bin/bash';
    args = [
      '-c',
      posixAgentCommand(
        provider,
        operation,
        args,
        undefined,
        desktop || process.env[`MAYPLANE_${provider.toUpperCase()}_BIN`],
        profileId,
      ),
    ];
  }
  if (cwd) {
    assert(isAbsolute(cwd) || win32.isAbsolute(cwd), 'Нужен абсолютный путь');
    assert(existsSync(cwd), 'Каталог проекта не найден', 400);
  }
  // npm's Windows shim is a batch file; invoke the JS entry point without a shell.
  if (executable === 'npm' && process.platform === 'win32') {
    executable = process.execPath;
    args = [
      join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      ...args,
    ];
  } else if (process.platform === 'win32') {
    // Resolve npm's .cmd shim to its package's actual executable where possible.
    const roots = [
      process.env.APPDATA && join(process.env.APPDATA, 'npm'),
      dirname(process.execPath),
    ];
    const entry =
      provider === 'opencode'
        ? 'opencode-ai/bin/opencode'
        : '@openai/codex/bin/codex.js';
    const script = roots
      .filter(Boolean)
      .map((root) => join(root, 'node_modules', entry))
      .find(existsSync);
    const native =
      provider === 'codex' && process.env.LOCALAPPDATA
        ? join(
            process.env.LOCALAPPDATA,
            'Programs',
            'OpenAI',
            'Codex',
            'bin',
            'codex.exe',
          )
        : provider === 'opencode'
          ? roots
              .filter(Boolean)
              .map((root) =>
                join(
                  root,
                  'node_modules',
                  '@opencode',
                  'cli',
                  'bin',
                  'opencode.exe',
                ),
              )
              .find(existsSync)
          : null;
    if (
      native &&
      existsSync(native) &&
      !process.env[`MAYPLANE_${provider.toUpperCase()}_BIN`]
    )
      executable = native;
    else if (script && !process.env[`MAYPLANE_${provider.toUpperCase()}_BIN`]) {
      executable = process.execPath;
      args = [script, ...args];
    }
  }
  if (
    process.platform === 'win32' &&
    operation !== 'install' &&
    process.env[`MAYPLANE_${provider.toUpperCase()}_BIN`]
  )
    executable = process.env[`MAYPLANE_${provider.toUpperCase()}_BIN`];
  else if (desktop && process.platform === 'win32') executable = desktop;
  const env = { ...process.env, NO_COLOR: '1' };
  if (profileId) {
    for (const name of Object.keys(env))
      if (
        /(?:_API_KEY|_TOKEN|_ACCESS_KEY|_SECRET_ACCESS_KEY|_CREDENTIALS)$/.test(
          name,
        ) ||
        /^(OPENAI_|ANTHROPIC_|CODEX_HOME$|CODEX_SQLITE_HOME$|OPENCODE_AUTH_CONTENT$|OPENCODE_CONFIG$|OPENCODE_CONFIG_CONTENT$)/.test(
          name,
        )
      )
        delete env[name];
    Object.assign(env, profileEnvironment(provider, profileId));
    if (provider === 'codex' && process.platform === 'win32')
      args = ['-c', 'cli_auth_credentials_store="file"', ...args];
  }
  if (operation === 'auth-server') {
    assert(
      typeof serverPassword === 'string' && serverPassword.length >= 24,
      'Нужен защищённый доступ к серверу авторизации',
    );
    env.OPENCODE_SERVER_PASSWORD = serverPassword;
    env.OPENCODE_SERVER_USERNAME = 'opencode';
  }
  if (process.platform !== 'win32')
    env.PATH =
      join(os.homedir(), '.local', 'bin') + ':' + (env.PATH || '/usr/bin:/bin');
  if (provider === 'opencode')
    env.OPENCODE_PERMISSION = JSON.stringify({ '*': 'ask' });
  // Infrastructure credentials never enter the agent environment.
  for (const name of Object.keys(env))
    if (/^(MAYPLANE_|ALLOWED_ORIGINS$)/.test(name)) delete env[name];
  const child = spawn(executable, args, {
    cwd: cwd || os.homedir(),
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exited = false,
    closing = false;
  child.on('exit', () => {
    exited = true;
  });
  let input = child.stdin;
  if (operation === 'credential-import') {
    input = new PassThrough();
    child.stdin.on('error', (error) => input.destroy(error));
    let pending = '';
    input.on('data', (bytes) => {
      pending += bytes.toString();
      if (pending.length > 131072) child.kill();
      else if (pending.includes('\n')) {
        child.stdin.end(pending.slice(0, pending.indexOf('\n')));
        pending = '';
      }
    });
  }
  return {
    input,
    stdout: child.stdout,
    stderr: child.stderr,
    events: child,
    close: () => {
      if (exited || closing || !child.pid) return;
      closing = true;
      if (process.platform === 'win32') {
        const killer = spawn(
          join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'taskkill.exe',
          ),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.on('error', () => child.kill());
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill();
        }
      }
    },
  };
}

export async function machineProcess(machine, options, connectors) {
  assert(
    !(options.profileId && options.operation === 'install'),
    'Установка агента не поддерживает профиль аккаунта',
  );
  if (machine.transport === 'connector')
    return connectors.open(machine.id, options);
  if (machine.transport === 'local') return localProcess(options);
  const spec = processSpec(options.provider, options.operation, 'linux');
  const ssh = await connect(machine);
  try {
    const command = options.operation.startsWith('profile-')
      ? posixProfileOperation(
          options.provider,
          options.operation,
          options.profileId,
          options.profileFormat,
          options.profileVendor,
          options.profileCredential,
        )
      : posixAgentCommand(
          options.provider,
          options.operation,
          spec.args,
          options.cwd ? projectPath(options.cwd) : undefined,
          undefined,
          options.profileId,
        );
    const channel = await new Promise((resolve, reject) =>
      ssh.exec(command, (error, stream) =>
        error ? reject(error) : resolve(stream),
      ),
    );
    return {
      input: channel,
      stdout: channel,
      stderr: channel.stderr,
      events: channel,
      close: () => {
        channel.close();
        ssh.end();
      },
    };
  } catch (error) {
    ssh.end();
    throw error;
  }
}

let previousCpu;
export function localMetrics() {
  const total = os.totalmem();
  let available = os.freemem();
  if (process.platform === 'linux') {
    try {
      const match = readFileSync('/proc/meminfo', 'utf8').match(
        /^MemAvailable:\s+(\d+) kB/m,
      );
      if (match) available = Number(match[1]) * 1024;
    } catch {}
  }
  const cpus = os.cpus();
  const current = cpus.reduce(
    (s, c) => ({
      idle: s.idle + c.times.idle,
      total: s.total + Object.values(c.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
  const elapsed = previousCpu && current.total - previousCpu.total;
  const cpu =
    elapsed > 0
      ? Math.round(100 * (1 - (current.idle - previousCpu.idle) / elapsed))
      : null;
  previousCpu = current;
  let diskTotalBytes = null,
    diskUsedBytes = null,
    diskAvailableBytes = null;
  try {
    const fs = statfsSync(os.homedir());
    diskTotalBytes = Number(fs.blocks) * Number(fs.bsize);
    diskUsedBytes = (Number(fs.blocks) - Number(fs.bfree)) * Number(fs.bsize);
    diskAvailableBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {}
  const interfaces = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal);
  let networkRx = null,
    networkTx = null;
  if (process.platform === 'linux') {
    try {
      const values = readFileSync('/proc/net/dev', 'utf8')
        .split('\n')
        .filter((l) => l.includes(':') && !/^\s*lo:/.test(l))
        .map((l) => l.split(':')[1].trim().split(/\s+/).map(Number));
      networkRx = values.reduce((a, v) => a + v[0], 0);
      networkTx = values.reduce((a, v) => a + v[8], 0);
    } catch {}
  }
  return {
    status: 'online',
    platform: os.platform(),
    homePath: os.homedir(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    ...resourceMetrics({
      cpu,
      cpuCores: cpus.length,
      memoryTotalBytes: total,
      memoryUsedBytes: total - available,
      memoryAvailableBytes: available,
      diskTotalBytes,
      diskUsedBytes,
      diskAvailableBytes,
    }),
    ipv4: interfaces.find((i) => i.family === 'IPv4')?.address || '',
    ipv6: interfaces.find((i) => i.family === 'IPv6')?.address || '',
    uptime: os.uptime(),
    networkRx,
    networkTx,
    specs: `${cpus.length} CPU · ${Math.round(total / 1073741824)} GB RAM · ${os.platform()}`,
    checkedAt: new Date().toISOString(),
  };
}
