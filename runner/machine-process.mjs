import { spawn } from 'node:child_process';
import { existsSync, statfsSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute, win32 } from 'node:path';
import os from 'node:os';
import { connect } from './ssh.mjs';
import { assert } from './security.mjs';
import { posixAgentCommand } from './agent-launch.mjs';

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
    package: 'opencode-ai',
    args: ['acp'],
  },
};

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
    ['agent', 'version', 'install', 'login'].includes(operation),
    'Неизвестная операция',
  );
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

export function localProcess({ provider, operation, cwd }) {
  let { executable, args } = processSpec(provider, operation);
  if (process.platform !== 'win32' && operation !== 'install') {
    executable = '/bin/bash';
    args = [
      '-c',
      posixAgentCommand(
        provider,
        operation,
        args,
        undefined,
        process.env[`EZDEPLOY_${provider.toUpperCase()}_BIN`],
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
    if (script && !process.env[`EZDEPLOY_${provider.toUpperCase()}_BIN`]) {
      executable = process.execPath;
      args = [script, ...args];
    }
  }
  if (
    process.platform === 'win32' &&
    operation !== 'install' &&
    process.env[`EZDEPLOY_${provider.toUpperCase()}_BIN`]
  )
    executable = process.env[`EZDEPLOY_${provider.toUpperCase()}_BIN`];
  const env = { ...process.env, NO_COLOR: '1' };
  if (process.platform !== 'win32')
    env.PATH =
      join(os.homedir(), '.local', 'bin') + ':' + (env.PATH || '/usr/bin:/bin');
  if (provider === 'opencode')
    env.OPENCODE_PERMISSION = JSON.stringify({ '*': 'ask' });
  // Infrastructure credentials never enter the agent environment.
  for (const name of Object.keys(env))
    if (/^(EZDEPLOY_|ALLOWED_ORIGINS$)/.test(name)) delete env[name];
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
  return {
    input: child.stdin,
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
  if (machine.transport === 'connector')
    return connectors.open(machine.id, options);
  if (machine.transport === 'local') return localProcess(options);
  const spec = processSpec(options.provider, options.operation, 'linux');
  const ssh = await connect(machine);
  try {
    const command = posixAgentCommand(
      options.provider,
      options.operation,
      spec.args,
      options.cwd ? projectPath(options.cwd) : undefined,
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
  let disk = null;
  try {
    const fs = statfsSync(os.homedir());
    disk = Math.round(100 * (1 - Number(fs.bavail) / Number(fs.blocks)));
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
    cpu,
    memory: Math.round(100 * (1 - os.freemem() / total)),
    disk,
    ipv4: interfaces.find((i) => i.family === 'IPv4')?.address || '',
    ipv6: interfaces.find((i) => i.family === 'IPv6')?.address || '',
    uptime: os.uptime(),
    networkRx,
    networkTx,
    specs: `${cpus.length} CPU · ${Math.round(total / 1073741824)} GB RAM · ${os.platform()}`,
    checkedAt: new Date().toISOString(),
  };
}
