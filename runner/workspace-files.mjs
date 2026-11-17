import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { posix, win32 } from 'node:path';
import { assert } from './security.mjs';

const pageSize = 150;
const scanLimit = 12000;
const fileLimit = 160 * 1024;
const patchLimit = 80 * 1024;
const statusLimit = 256 * 1024;
export const workspaceTimeout = 20000;
export const workspaceSnapshotTimeout = 6000;
export const workspaceOperations = [
  'browse',
  'roots',
  'tree',
  'file',
  'git',
  'patch',
  'snapshot',
];
export const workspaceTimeoutError = () =>
  Object.assign(new Error('Машина не ответила вовремя. Повторите запрос.'), {
    status: 504,
  });

// eslint-disable-next-line no-control-regex -- Control characters cannot be part of browse paths.
const control = /[\u0000-\u001f\u007f\ufffd]/;
const windowsName =
  /[\\:<>"|?*]|[ .]$|^(?:con|prn|nul|aux|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const leaf = (name, windows) =>
  typeof name === 'string' &&
  name &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('/') &&
  !control.test(name) &&
  Buffer.byteLength(name) <= 255 &&
  name.toLowerCase() !== '.git' &&
  (!windows || !windowsName.test(name));

function absolute(value, p) {
  const windows = p === win32;
  assert(
    typeof value === 'string' &&
      value.length <= 1024 &&
      !control.test(value) &&
      (windows ? /^[a-z]:[\\/]/i.test(value) : value.startsWith('/')),
    'Укажите полный путь на выбранной машине',
  );
  const segments = windows
    ? value.slice(3).split(/[\\/]/)
    : value.slice(1).split('/');
  assert(
    segments.every((s) => !s || s === '.' || leaf(s, windows)),
    'Недопустимый путь',
  );
  return p.resolve(value);
}

function relative(value, p, allowEmpty = false) {
  if (allowEmpty && value === '') return [];
  assert(
    typeof value === 'string' &&
      value.length <= 1024 &&
      value.split('/').every((s) => leaf(s, p === win32)),
    'Недопустимый путь в рабочей папке',
  );
  return value.split('/');
}

function fsError(error) {
  if (error.status) return error;
  if (['EACCES', 'EPERM', 3].includes(error.code))
    return Object.assign(new Error('Нет доступа к этому пути на машине.'), {
      status: 403,
    });
  if (['ENOENT', 'ENOTDIR', 2].includes(error.code))
    return Object.assign(new Error('Путь не найден на выбранной машине.'), {
      status: 404,
    });
  return Object.assign(
    new Error('Не удалось прочитать путь на выбранной машине.'),
    { status: 502 },
  );
}

const kind = (info) =>
  info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
const equal = (a, b, p) =>
  p === win32 ? a.toLowerCase() === b.toLowerCase() : a === b;
const order = new Intl.Collator('ru', { numeric: true });

async function listing(io, target, options, p, signal) {
  const { offset = 0, query = '', foldersOnly = false } = options;
  assert(
    Number.isInteger(offset) &&
      offset >= 0 &&
      offset < scanLimit &&
      typeof query === 'string' &&
      query.length <= 160 &&
      !control.test(query) &&
      typeof foldersOnly === 'boolean',
    'Некорректные параметры просмотра',
  );
  const needle = query.trim().toLowerCase();
  const entries = [];
  let seen = 0,
    limited = false;
  for await (const entry of io.entries(target)) {
    signal.throwIfAborted();
    if (++seen > scanLimit) {
      limited = true;
      break;
    }
    const { name } = entry;
    if (
      !leaf(name, p === win32) ||
      p.join(target, name).length > 1024 ||
      !name.toLowerCase().includes(needle)
    )
      continue;
    const type = kind(entry);
    if (type === 'other' || (foldersOnly && type !== 'directory')) continue;
    entries.push({ name, kind: type });
  }
  entries.sort((a, b) =>
    a.kind === b.kind
      ? order.compare(a.name, b.name)
      : a.kind === 'directory'
        ? -1
        : 1,
  );
  return {
    entries: entries.slice(offset, offset + pageSize),
    next: entries.length > offset + pageSize ? offset + pageSize : null,
    limited,
  };
}

async function scoped(io, root, parts, p) {
  const target = p.join(root, ...parts);
  assert(target.length <= 1024, 'Путь слишком длинный');
  if (parts.length) {
    // Do not follow symlinks/junctions inside the working directory.
    const actual = p.resolve(await io.realpath(target));
    assert(
      equal(target, actual, p),
      'Ссылки внутри рабочей папки не открываются.',
      403,
    );
  }
  return target;
}

function preview(buffer, size, limit) {
  const truncated = size > buffer.length || buffer.length > limit;
  const data = buffer.subarray(0, limit);
  let text;
  try {
    if (data.includes(0)) throw new Error('binary');
    // Streaming decode omits any partial UTF-8 character at the preview boundary.
    text = new TextDecoder('utf-8', { fatal: true }).decode(data, {
      stream: truncated,
    });
  } catch {
    return { kind: 'binary', size };
  }
  return { kind: 'text', text, size, truncated };
}

async function readPreview(io, target, limit) {
  assert(
    (await io.lstat(target)).isFile(),
    'Предпросмотр доступен для обычных файлов.',
    400,
  );
  const { buffer, size } = await io.read(target, limit + 1);
  return preview(buffer, size, limit);
}

const snapshotSkip = new Set([
  '.git',
  '.hg',
  '.svn',
  '.ssh',
  '.gnupg',
  '.aws',
  '.mayplane',
  '.mayplane-connector',
  '.runner-data',
  '.artifacts',
  'node_modules',
  '.venv',
  '.next',
  '.vinext',
  '__pycache__',
  '.cache',
]);
const snapshotPrivate =
  /^(?:\.env(?:\.|$)|\.netrc$|\.npmrc$|id_(?:rsa|ed25519)(?:\.|$)|(?:mayplane|ezdeploy)\.sqlite(?:$|-))|\.(?:key|pem|p12|pfx)$/i;

async function snapshot(io, root, signal) {
  const { p } = io;
  if (p.dirname(root) === root) return null;
  const home = p.resolve(await io.home());
  const maxDirectories = equal(root, home, p) ? 1 : 180;
  const walkUntil = performance.now() + 2700;
  const readUntil = walkUntil + 1700;
  const directories = [''];
  const completeDirs = [];
  const files = [];
  let entries = 0;
  let pathBudget = 230 * 1024;
  let limited = false;

  scan: for (let i = 0; i < directories.length; i++) {
    if (i >= maxDirectories || performance.now() > walkUntil) {
      limited = true;
      break;
    }
    const dir = directories[i];
    try {
      const target = await scoped(io, root, dir ? dir.split('/') : [], p);
      for await (const entry of io.entries(target)) {
        signal.throwIfAborted();
        const name = entry.name;
        if (++entries > 3000 || performance.now() > walkUntil) {
          limited = true;
          break scan;
        }
        if (
          !leaf(name, p === win32) ||
          snapshotSkip.has(name.toLowerCase()) ||
          snapshotPrivate.test(name) ||
          (!entry.isDirectory() && !entry.isFile())
        )
          continue;
        const path = dir ? `${dir}/${name}` : name;
        if (root.length + path.length + 1 > 1024) continue;
        // Reserve space for path, file metadata and directory coverage in the connector frame.
        pathBudget -= Buffer.byteLength(JSON.stringify(path)) + 160;
        if (pathBudget < 0) {
          limited = true;
          break scan;
        }
        if (entry.isDirectory()) directories.push(path);
        else files.push({ path, size: entry.size, mtime: entry.mtimeMs });
      }
      completeDirs.push(dir);
    } catch {
      signal.throwIfAborted();
      limited = true;
    }
  }

  // Walk the same files in the same order on each snapshot, with shallow files first.
  files.sort(
    (a, b) =>
      a.path.split('/').length - b.path.split('/').length ||
      order.compare(a.path, b.path),
  );
  let readBudget = 4 * 1024 * 1024;
  let textBudget = 420 * 1024;
  const maxSample = 32 * 1024;
  for (let i = 0; i < files.length; i += 12) {
    signal.throwIfAborted();
    if (performance.now() > readUntil) {
      limited = true;
      break;
    }
    await Promise.all(
      files.slice(i, i + 12).map(async (file) => {
        try {
          const parts = file.path.split('/');
          if (!Number.isFinite(file.size) || !Number.isFinite(file.mtime)) {
            const info = await io.lstat(p.join(root, ...parts));
            if (!info.isFile()) return;
            file.size = info.size;
            file.mtime = info.mtimeMs;
          }
          if (file.size > maxSample || file.size > readBudget || i >= 600)
            return;
          readBudget -= Math.max(file.size, 1);
          const target = await scoped(io, root, parts, p);
          const { buffer, size } = await io.read(target, maxSample + 1);
          if (size !== file.size || buffer.length !== size) return;
          file.hash = createHash('sha256').update(buffer).digest('hex');
          const sample = preview(buffer, size, maxSample);
          if (sample.kind === 'text') {
            const cost = Buffer.byteLength(JSON.stringify(sample.text)) + 16;
            if (cost <= textBudget) {
              textBudget -= cost;
              file.text = sample.text;
            }
          }
        } catch {
          // The name is still present even if its contents cannot be read.
          limited = true;
        }
      }),
    );
  }
  signal.throwIfAborted();
  return { root, directories, completeDirs, files, limited };
}

// Ignore inherited overrides that could point Git at another worktree or enable helpers.
export const gitEnvUnset = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];
export const gitEnvSet = {
  LC_ALL: 'C',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
  GIT_NO_REPLACE_OBJECTS: '1',
};

function localGit(args, limit, signal) {
  const env = { ...process.env, ...gitEnvSet };
  for (const name of gitEnvUnset) delete env[name];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        env,
        encoding: 'buffer',
        maxBuffer: limit,
        timeout: 9000,
        signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (signal.aborted) return reject(signal.reason);
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return resolve({
            buffer: stdout,
            clipped: true,
            code: 0,
            stderr: '',
          });
        if (!error || error.code === 'ENOENT' || Number.isInteger(error.code))
          return resolve({
            buffer: stdout,
            stderr: stderr.toString('utf8'),
            code: !error ? 0 : error.code === 'ENOENT' ? 127 : error.code,
          });
        reject(error);
      },
    );
  });
}

async function gitAt(io, root, signal) {
  const base = [
    '--no-pager',
    '--literal-pathspecs',
    '-c',
    'core.fsmonitor=false',
    '-C',
    root,
  ];
  const raw = (args, limit = 4096) => io.git([...base, ...args], limit, signal);
  const check = await raw(['rev-parse', '--show-prefix']);
  if (check.code === 127) return { reason: 'no-git' };
  if (
    check.code !== 0 &&
    /not a git repository|must be run in a work tree/.test(check.stderr)
  )
    return { reason: 'not-repo' };
  assert(
    check.code === 0 && !check.clipped,
    'Git не смог открыть рабочую папку.',
    422,
  );
  const prefix = check.buffer.toString('utf8').replace(/\r?\n$/, '');
  // A clean or process filter can execute even in git status and git diff.
  const filters = await raw(
    [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|process|required)$',
    ],
    16384,
  );
  assert(
    !filters.clipped && [0, 1].includes(filters.code),
    'Не удалось проверить настройки фильтров Git.',
    422,
  );
  const overrides = [
    ...new Set(filters.buffer.toString('utf8').split('\0').filter(Boolean)),
  ];
  assert(
    overrides.length <= 64 &&
      overrides.every(
        (key) => key.length <= 200 && !control.test(key) && !key.includes('='),
      ),
    'Слишком много настроек фильтров Git.',
    422,
  );
  for (const key of overrides)
    base.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  return {
    prefix,
    run: async (args, limit) => {
      const result = await raw(args, limit);
      assert(
        result.code === 0,
        'Git не смог прочитать изменения в рабочей папке.',
        422,
      );
      return result;
    },
  };
}

async function assertGitPath(io, root, parts, p) {
  const check = async (path) => {
    try {
      const actual = p.resolve(await io.realpath(path));
      assert(
        equal(path, actual, p),
        'Ссылки внутри рабочей папки не открываются.',
        403,
      );
    } catch (error) {
      const missing = (e) => ['ENOENT', 'ENOTDIR', 2].includes(e.code);
      if (!missing(error) || equal(path, root, p)) throw error;
      const info = await io.lstat(path).catch((e) => {
        if (!missing(e)) throw e;
      });
      assert(
        !info?.isSymbolicLink(),
        'Ссылки внутри рабочей папки не открываются.',
        403,
      );
      // A deleted entry has no path to resolve; check its nearest remaining parent.
      await check(p.dirname(path));
    }
  };
  const target = p.join(root, ...parts);
  assert(target.length <= 1024, 'Путь слишком длинный');
  await check(target);
}

async function gitStatus(git, io, root, p) {
  const result = await git.run(
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--renames',
      '--ignore-submodules=all',
      '--',
      '.',
    ],
    statusLimit,
  );
  const chunks = result.buffer.toString('utf8').split('\0');
  chunks.pop(); // A partial final record is not usable.
  const files = [];
  const within = (value) => {
    if (!value?.startsWith(git.prefix)) return;
    const path = value.slice(git.prefix.length);
    if (
      path.length <= 1024 &&
      path.split('/').every((part) => leaf(part, p === win32))
    )
      return path;
  };
  let limited = !!result.clipped;
  for (let i = 0; i < chunks.length; i++) {
    const record = chunks[i];
    const status = record.slice(0, 2);
    const path = within(record.slice(3));
    const renamed = /[RC]/.test(status);
    const oldPath = renamed ? within(chunks[++i]) : undefined;
    if (!path || (renamed && i >= chunks.length)) continue;
    if (files.length === 350) {
      limited = true;
      break;
    }
    files.push({ path, status, ...(oldPath ? { oldPath } : {}) });
  }
  const visible = await Promise.all(
    files.map(async (entry) => {
      try {
        await assertGitPath(io, root, entry.path.split('/'), p);
        if (entry.oldPath)
          await assertGitPath(io, root, entry.oldPath.split('/'), p);
        return entry;
      } catch (error) {
        if (!error.status && !['EACCES', 'EPERM', 3].includes(error.code))
          throw error;
        return null;
      }
    }),
  );
  return { files: visible.filter(Boolean), limited };
}

async function gitPatch(git, io, root, p, options) {
  const parts = relative(options.path, p);
  const oldParts = options.oldPath ? relative(options.oldPath, p) : parts;
  await assertGitPath(io, root, parts, p);
  if (oldParts !== parts) await assertGitPath(io, root, oldParts, p);
  const path = './' + parts.join('/');
  const oldPath = './' + oldParts.join('/');
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    '--ignore-submodules=all',
    '--relative',
  ];
  const result = {};
  const targets = oldPath === path ? [path] : [path, oldPath];
  for (const key of ['staged', 'working']) {
    const flags = key === 'staged' ? ['--cached'] : [];
    const { buffer, clipped } = await git.run(
      [...args, ...flags, '--', ...targets],
      patchLimit,
    );
    if (buffer.length || clipped)
      result[key] = { text: buffer.toString('utf8'), truncated: !!clipped };
  }
  if (!result.staged && !result.working) {
    const untracked = await git.run(
      ['ls-files', '--others', '--exclude-standard', '-z', '--', path],
      4096,
    );
    if (
      untracked.buffer.toString('utf8').split('\0').includes(parts.join('/'))
    ) {
      result.untracked = await readPreview(
        io,
        await scoped(io, root, parts, p),
        patchLimit,
      );
    }
  }
  return result;
}

export function localWorkspaceIO() {
  return {
    p: process.platform === 'win32' ? win32 : posix,
    home: os.homedir,
    realpath,
    lstat,
    stat,
    async *entries(path) {
      yield* await opendir(path);
    },
    async read(path, limit) {
      const file = await open(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW || 0) |
          (constants.O_NONBLOCK || 0),
      );
      try {
        const info = await file.stat();
        assert(info.isFile(), 'Предпросмотр доступен для обычных файлов.');
        const buffer = Buffer.alloc(Math.min(limit, info.size));
        let count = 0;
        while (count < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            count,
            buffer.length - count,
            count,
          );
          if (!bytesRead) break;
          count += bytesRead;
        }
        return { buffer: buffer.subarray(0, count), size: info.size };
      } finally {
        await file.close();
      }
    },
    git: localGit,
  };
}

export async function inspectWorkspace(
  operation,
  options,
  io = localWorkspaceIO(),
  timeout = AbortSignal.timeout(workspaceTimeout),
) {
  assert(
    workspaceOperations.includes(operation),
    'Неизвестная операция просмотра',
    404,
  );
  assert(
    options && typeof options === 'object' && !Array.isArray(options),
    'Некорректные параметры просмотра',
  );
  const { p } = io;
  const signal = timeout;
  try {
    if (operation === 'roots') {
      if (p === posix) return { roots: ['/'] };
      const drives = Array.from(
        { length: 26 },
        (_, i) => String.fromCharCode(65 + i) + ':\\',
      );
      const present = await Promise.all(
        drives.map(async (drive) =>
          (await io.stat(drive).catch(() => null))?.isDirectory()
            ? drive
            : null,
        ),
      );
      return { roots: present.filter(Boolean) };
    }
    if (operation === 'browse') {
      let path = absolute(options.path ?? (await io.home()), p);
      let selected;
      if (options.foldersOnly !== true && (await io.lstat(path)).isFile()) {
        selected = path;
        path = p.dirname(path);
      }
      assert((await io.stat(path)).isDirectory(), 'Выберите каталог.');
      // Resolve directory links for navigation; workspace previews still reject links below root.
      const actual = absolute(await io.realpath(path), p);
      const parent = p.dirname(actual);
      return {
        path: actual,
        parent: equal(parent, actual, p) ? null : parent,
        separator: p.sep,
        ...(selected ? { selected: p.join(actual, p.basename(selected)) } : {}),
        ...(await listing(io, actual, options, p, signal)),
      };
    }
    const parts = ['tree', 'file', 'patch'].includes(operation)
      ? relative(options.path ?? '', p, operation === 'tree')
      : [];
    const root = absolute(await io.realpath(absolute(options.root, p)), p);
    assert(
      (await io.stat(root)).isDirectory(),
      'Рабочая папка больше не является каталогом.',
      404,
    );
    if (operation === 'snapshot') return snapshot(io, root, signal);
    if (operation === 'tree' || operation === 'file') {
      const target = await scoped(io, root, parts, p);
      return operation === 'tree'
        ? await listing(io, target, options, p, signal)
        : await readPreview(io, target, fileLimit);
    }
    const git = await gitAt(io, root, signal);
    if (git.reason) return git;
    return operation === 'git'
      ? await gitStatus(git, io, root, p)
      : await gitPatch(git, io, root, p, options);
  } catch (error) {
    if (signal.aborted) throw workspaceTimeoutError();
    throw fsError(error);
  }
}
