import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import ssh2 from 'ssh2';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { compareWorkspaceSnapshots } from '../runner/agent-file-changes.mjs';

const repoPath = 'src/пример с пробелом.txt';
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });

async function waitFor(read, check) {
  for (let i = 0; i < 120; i++) {
    const value = await read();
    if (check(value)) return value;
    await delay(40);
  }
  throw new Error('Timed out waiting for fixture');
}

function mockAgent({ provider, operation, cwd }, runCommand) {
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    events = new EventEmitter();
  const send = (message) => {
    const buffer = Buffer.from(JSON.stringify(message) + '\n');
    const split = buffer.indexOf(Buffer.from('А'));
    if (split >= 0) {
      stdout.write(buffer.subarray(0, split + 1));
      stdout.write(buffer.subarray(split + 1));
    } else stdout.write(buffer);
  };
  if (operation === 'version')
    setImmediate(() => {
      stdout.write(provider + ' 1.2.3\n');
      events.emit('close', 0);
    });
  const input = new Writable({
    write(chunk, _, done) {
      const { method, id } = JSON.parse(chunk);
      const reply = (result) => send({ id, result });
      const notify = (name, params) => send({ method: name, params });
      if (id !== undefined)
        setImmediate(() => {
          switch (method) {
            case 'thread/start':
              reply({ thread: { id: 'codex-thread' } });
              break;
            case 'session/new':
              reply({ sessionId: 'acp-session' });
              break;
            case 'turn/start': {
              const turn = { id: 'request', status: 'completed' };
              reply({ turn });
              notify('turn/started', { turn, threadId: 'codex-thread' });
              if (runCommand) {
                void Promise.resolve()
                  .then(() => runCommand(cwd))
                  .then(
                    () => {
                      notify('item/completed', {
                        threadId: 'codex-thread',
                        turnId: turn.id,
                        item: {
                          id: 'shell-write',
                          type: 'commandExecution',
                          command: 'create hello_world.py via shell',
                          exitCode: 0,
                          status: 'completed',
                        },
                      });
                      notify('turn/completed', {
                        turn,
                        threadId: 'codex-thread',
                      });
                    },
                    (error) =>
                      notify('turn/completed', {
                        threadId: 'codex-thread',
                        turn: {
                          ...turn,
                          status: 'failed',
                          error: { message: error.message },
                        },
                      }),
                  );
                break;
              }
              const change =
                'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-original\n+Агент изменил строку\n';
              notify('turn/diff/updated', {
                threadId: 'another-thread',
                turnId: turn.id,
                diff: 'not part of this turn',
              });
              notify('turn/diff/updated', {
                threadId: 'codex-thread',
                turnId: turn.id,
                diff: change,
              });
              notify('turn/completed', { turn, threadId: 'codex-thread' });
              break;
            }
            case 'session/prompt': {
              const update = (more) =>
                notify('session/update', {
                  sessionId: 'acp-session',
                  update: { toolCallId: 'write-one', ...more },
                });
              update({
                sessionUpdate: 'tool_call',
                status: 'in_progress',
                content: [
                  {
                    type: 'diff',
                    path: '/workspace/added.txt',
                    oldText: null,
                    newText: 'content from ACP',
                  },
                ],
              });
              update({
                sessionUpdate: 'tool_call_update',
                status: 'completed',
              });
              reply({ stopReason: 'end_turn' });
              break;
            }
            case 'account/read':
              reply({ account: null, requiresOpenaiAuth: false });
              break;
            default:
              reply({});
          }
        });
      done();
    },
  });
  return { stdout, stderr, input, events, close() {} };
}

async function fixture(t, { runCommand } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mayplane-files-')));
  const root = join(dir, 'working'),
    work = join(root, 'src');
  await mkdir(work, { recursive: true });
  const store = openStore(join(dir, 'db'), randomBytes(32));
  const token = randomBytes(32).toString('hex');
  const machineId = randomUUID();
  store.save(
    'servers',
    {
      id: machineId,
      name: 'Fixture',
      transport: 'local',
      platform: process.platform,
      status: 'online',
    },
    {},
  );
  const { server, hub } = createApp({
    store,
    token,
    engine: {},
    hubOptions: {
      resolveHome: async () => dir,
      openProcess: async (_, options) => mockAgent(options, runCommand),
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, auth = token) =>
    fetch(origin + '/api/hub' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${auth}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (path, body, status = 200) => {
    const response = await request(path, body);
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  t.after(async () => {
    hub.close();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, root, work, store, machineId, origin, request, json };
}

test('machine path picker and scoped Git previews are read only and preserve staged/unstaged edits', async (t) => {
  const { dir, root, work, machineId, request, json } = await fixture(t);
  const pick = `/machines/${machineId}/files`;
  await writeFile(join(dir, 'outside.txt'), 'Private text');
  await symlink(
    dir,
    join(work, 'outside-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(work, 'data.bin'), Buffer.from([0, 0xff, 0x20]));
  await writeFile(join(work, 'long.txt'), 'текст\n'.repeat(90000));
  assert.equal(
    (await request(`${pick}/browse`, { path: work }, 'wrong')).status,
    401,
  );
  const { roots } = await json(`${pick}/roots`, {});
  assert.ok(roots.some((path) => root.startsWith(path)));
  const listing = await json(`${pick}/browse`, {
    path: root,
    foldersOnly: true,
    query: 'SR',
  });
  assert.deepEqual(listing.entries, [{ name: 'src', kind: 'directory' }]);
  assert.equal(listing.parent, dirname(root));
  const selected = await json(`${pick}/browse`, {
    path: join(work, 'data.bin'),
  });
  assert.equal(selected.selected, join(work, 'data.bin'));

  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Workspace test');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, repoPath), 'old line\n');
  await writeFile(join(work, 'old-name.txt'), 'rename me\n');
  await writeFile(join(root, 'unrelated.txt'), 'old text\n');
  git(root, 'add', '--', repoPath, 'src/old-name.txt', 'unrelated.txt');
  git(root, 'commit', '-qm', 'Initial');
  await writeFile(join(root, repoPath), 'staged line\n');
  git(root, 'add', '--', repoPath);
  git(root, 'mv', 'src/old-name.txt', 'src/new-name.txt');
  await writeFile(join(root, repoPath), 'working line\n');
  await writeFile(join(root, 'unrelated.txt'), 'outside workspace edit\n');
  await writeFile(join(work, '.gitattributes'), '*.txt filter=sample\n');
  git(root, 'config', 'filter.sample.clean', 'false');
  git(root, 'config', 'filter.sample.required', 'true');
  const indexBefore = await readFile(join(root, '.git', 'index'));

  const project = await json(
    '/projects',
    { name: 'Working folder', machineId, path: work },
    201,
  );
  const endpoint = `/projects/${project.id}/files`;
  const tree = await json(`${endpoint}/tree`, { root: dir });
  assert.ok(
    tree.entries.some((entry) => entry.name === 'пример с пробелом.txt'),
  );
  assert.ok(
    tree.entries.every(
      (entry) => entry.name !== 'outside-link' && entry.name !== 'outside.txt',
    ),
  );
  await json(`${endpoint}/file`, { path: '../unrelated.txt' }, 400);
  await json(`${endpoint}/file`, { path: '.git/config' }, 400);
  await json(`${endpoint}/file`, { path: 'outside-link/outside.txt' }, 403);
  const binary = await json(`${endpoint}/file`, { path: 'data.bin' });
  assert.deepEqual(binary, { kind: 'binary', size: 3 });
  const preview = await json(`${endpoint}/file`, { path: 'long.txt' });
  assert.equal(preview.truncated, true);
  assert.ok(
    preview.text.startsWith('текст\n') && !preview.text.includes('\ufffd'),
  );

  const status = await json(`${endpoint}/git`, {});
  assert.deepEqual(
    status.files.find((entry) => entry.path === 'пример с пробелом.txt'),
    { path: 'пример с пробелом.txt', status: 'MM' },
  );
  assert.ok(
    !status.files.some(
      (entry) =>
        entry.path.includes('unrelated') ||
        entry.path.startsWith('outside-link'),
    ),
    JSON.stringify(status.files),
  );
  const moved = status.files.find((entry) => entry.path === 'new-name.txt');
  assert.equal(moved.oldPath, 'old-name.txt');
  assert.match(
    (await json(`${endpoint}/patch`, moved)).staged.text,
    /rename from old-name\.txt/,
  );
  const diff = await json(`${endpoint}/patch`, {
    path: 'пример с пробелом.txt',
  });
  assert.match(diff.staged.text, /-old line\n\+staged line/);
  assert.match(diff.working.text, /-staged line\n\+working line/);
  assert.match(
    (await json(`${endpoint}/patch`, { path: 'long.txt' })).untracked.text,
    /^текст/,
  );
  assert.deepEqual(await readFile(join(root, '.git', 'index')), indexBefore);
  assert.equal(await readFile(join(root, repoPath), 'utf8'), 'working line\n');
});

test('changes from Codex and ACP survive the turn and stay separate from workspace Git status', async (t) => {
  const { work, machineId, json } = await fixture(t);
  for (const provider of ['codex', 'opencode']) {
    const session = await json(
      '/sessions',
      { provider, machineId, cwd: work },
      201,
    );
    assert.equal(session.cwd, work);
    if (provider === 'codex') assert.equal(session.mode, 'read-only');
    const endpoint = `/sessions/${session.id}`;
    assert.deepEqual(await json(`${endpoint}/files/git`, {}), {
      reason: 'not-repo',
    });
    await json(`${endpoint}/message`, { message: 'Make a test edit' }, 202);
    const detail = await waitFor(
      () => json(endpoint),
      (value) => value.status === 'idle' && value.messages.length,
    );
    const prompt = detail.messages.find((entry) => entry.role === 'user');
    assert.deepEqual(detail.changedTurns, [prompt.id]);
    const history = await json(`${endpoint}/changes`);
    assert.equal(history.turns[0].id, prompt.id);
    assert.equal(history.turns[0].title, 'Make a test edit');
    const report = await json(`${endpoint}/changes/${prompt.id}`);
    if (provider === 'codex') {
      assert.match(report.aggregate.text, /\+Агент изменил строку/);
      assert.ok(!report.aggregate.text.includes('not part of this turn'));
    } else {
      assert.equal(report.edits[0].before, null);
      assert.equal(report.edits[0].after.text, 'content from ACP');
    }
  }
});

test('a shell-only Codex turn records added, changed and deleted files without Git', async (t) => {
  const { work, machineId, json } = await fixture(t, {
    runCommand: async (cwd) => {
      await mkdir(join(cwd, 'scripts'));
      await writeFile(
        join(cwd, 'scripts', 'hello_world.py'),
        'print("Hello, World!")\n',
      );
      await writeFile(join(cwd, 'existing.txt'), 'after!\n');
      await rm(join(cwd, 'deleted.txt'));
      await writeFile(join(cwd, '.env'), 'TEST=after\n');
    },
  });
  await writeFile(join(work, 'existing.txt'), 'before\n');
  await writeFile(join(work, 'deleted.txt'), 'remove this\n');
  await writeFile(join(work, 'pre-existing.txt'), 'leave me alone\n');
  await writeFile(join(work, '.env'), 'TEST=before\n');
  const project = await json(
    '/projects',
    { machineId, name: 'Without Git', path: work },
    201,
  );
  const session = await json(
    '/sessions',
    { provider: 'codex', projectId: project.id },
    201,
  );
  const endpoint = `/sessions/${session.id}`;
  assert.deepEqual(await json(`${endpoint}/files/git`, {}), {
    reason: 'not-repo',
  });
  await json(
    `${endpoint}/message`,
    { message: 'Create and run hello world' },
    202,
  );
  const detail = await waitFor(
    () => json(endpoint),
    (value) => value.status === 'idle' && value.messages.length,
  );
  const prompt = detail.messages.find((entry) => entry.role === 'user');
  assert.deepEqual(detail.changedTurns, [prompt.id]);
  const report = await json(`${endpoint}/changes/${prompt.id}`);
  assert.equal(report.aggregate, undefined);
  assert.deepEqual(report.edits, []);
  const files = new Map(
    report.workspaceEdits.map((entry) => [entry.path, entry]),
  );
  assert.deepEqual(
    [...files.keys()].sort((a, b) => a.localeCompare(b)),
    ['deleted.txt', 'existing.txt', 'scripts/hello_world.py'],
  );
  assert.equal(files.get('scripts/hello_world.py').kind, 'add');
  assert.equal(files.get('scripts/hello_world.py').before, null);
  assert.match(files.get('scripts/hello_world.py').after.text, /Hello, World!/);
  assert.equal(files.get('existing.txt').before.text, 'before\n');
  assert.equal(files.get('existing.txt').after.text, 'after!\n');
  assert.equal(files.get('deleted.txt').kind, 'delete');
  assert.equal(files.get('deleted.txt').after, null);
});

test('an unscanned subtree cannot make an existing file look newly created', () => {
  const before = {
    root: '/project',
    directories: ['', 'src'],
    completeDirs: [''],
    files: [],
    limited: true,
  };
  const after = {
    root: '/project',
    directories: ['', 'src'],
    completeDirs: ['', 'src'],
    files: [
      { path: 'src/existing.txt', text: 'already there' },
      { path: 'new.txt', text: 'new file' },
    ],
  };
  const report = compareWorkspaceSnapshots(before, after);
  assert.equal(report.limited, true);
  assert.deepEqual(
    report.edits.map(({ path }) => path),
    ['new.txt'],
  );
});

test('paired connector serves the same directory and preview requests on its own machine', async (t) => {
  const { dir, work, store, origin, json } = await fixture(t, {
    runCommand: async (cwd) =>
      writeFile(join(cwd, 'hello_world.py'), 'print("Connector")\n'),
  });
  const machineId = randomUUID(),
    token = randomBytes(32).toString('hex');
  const profile = join(dir, 'connector-profile');
  const url = origin.replace(/^http:/, 'ws:') + '/api/connector';
  store.save(
    'servers',
    {
      id: machineId,
      name: 'Connector fixture',
      transport: 'connector',
      status: 'offline',
      platform: process.platform,
    },
    { connectorToken: token },
  );
  await mkdir(profile);
  await writeFile(
    join(profile, 'connection.json'),
    JSON.stringify({ url, token }),
  );
  await writeFile(join(work, 'readme.txt'), 'on the connector\n');
  const processHandle = spawn(
    process.execPath,
    ['runner/connector.mjs', '--data-dir', profile],
    { stdio: 'ignore', windowsHide: true },
  );
  try {
    await waitFor(
      () => store.get('servers', machineId),
      (machine) => machine.status === 'online',
    );
    const list = await json(`/machines/${machineId}/files/browse`, {
      path: work,
    });
    assert.deepEqual(list.entries, [{ name: 'readme.txt', kind: 'file' }]);
    const project = await json(
      '/projects',
      { name: 'Connected folder', path: work, machineId },
      201,
    );
    assert.equal(
      (await json(`/projects/${project.id}/files/file`, { path: 'readme.txt' }))
        .text,
      'on the connector\n',
    );
    const session = await json(
      '/sessions',
      { provider: 'codex', projectId: project.id },
      201,
    );
    const endpoint = `/sessions/${session.id}`;
    await json(
      `${endpoint}/message`,
      { message: 'Create a file on the connected computer' },
      202,
    );
    const detail = await waitFor(
      () => json(endpoint),
      (value) => value.status === 'idle' && value.messages.length,
    );
    const report = await json(`${endpoint}/changes/${detail.changedTurns[0]}`);
    assert.equal(report.workspaceEdits[0].path, 'hello_world.py');
    assert.equal(report.workspaceEdits[0].after.text, 'print("Connector")\n');
  } finally {
    const exited = once(processHandle, 'exit');
    processHandle.kill();
    await exited;
  }
});

test('an SSH workspace reads directory and file data via SFTP and keeps Git paths scoped', async (t) => {
  const original = 'в рабочей копии\n';
  const updated = 'в рабочей ветке\n';
  let content = Buffer.from(original);
  const { store, json } = await fixture(t, {
    runCommand: () => {
      content = Buffer.from(updated);
    },
  });
  const hostKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const fingerprint =
    'SHA256:' +
    createHash('sha256')
      .update(ssh2.utils.parseKey(hostKey).getPublicSSH())
      .digest('base64')
      .replace(/=+$/, '');
  const id = randomUUID(),
    root = '/home/review';
  const filename = "правка's.txt",
    path = root + '/' + filename;
  const file = { mode: 0o100644, size: content.length, atime: 100, mtime: 100 };
  const dir = { mode: 0o40755, size: 0 };
  const commands = [];
  const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;
  const connection = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) =>
      ctx.method === 'password' ? ctx.accept() : ctx.reject(),
    );
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (start) => {
          const sftp = start();
          const meta = (name) =>
            name === root ? dir : name === path ? file : null;
          const missing = (request) =>
            sftp.status(request, STATUS_CODE.NO_SUCH_FILE);
          let listed = false;
          sftp.on('REALPATH', (request, name) => {
            const target = name === '.' ? root : name;
            if (!meta(target)) return missing(request);
            return sftp.name(request, [
              { filename: target, attrs: meta(target) },
            ]);
          });
          for (const name of ['STAT', 'LSTAT'])
            sftp.on(name, (request, target) =>
              meta(target)
                ? sftp.attrs(request, meta(target))
                : missing(request),
            );
          sftp.on('OPENDIR', (request, target) =>
            target === root
              ? sftp.handle(request, Buffer.from('dir'))
              : missing(request),
          );
          sftp.on('READDIR', (request) => {
            if (listed) return sftp.status(request, STATUS_CODE.EOF);
            listed = true;
            return sftp.name(request, [{ filename, attrs: file }]);
          });
          sftp.on('OPEN', (request, name, flags) => {
            assert.equal(flags, OPEN_MODE.READ);
            return name === path
              ? sftp.handle(request, Buffer.from('file'))
              : missing(request);
          });
          sftp.on('FSTAT', (request) => sftp.attrs(request, file));
          sftp.on('READ', (request, _, offset, length) =>
            sftp.data(
              request,
              content.subarray(offset, offset + Math.min(length, 3)),
            ),
          );
          sftp.on('CLOSE', (request) => sftp.status(request, STATUS_CODE.OK));
        });
        session.on('exec', (accept, _reject, { command }) => {
          commands.push(command);
          const stream = accept();
          let code = 0;
          if (command.includes("'rev-parse'")) stream.write('\n');
          else if (command.includes("'config'")) code = 1;
          else if (command.includes("'status'"))
            stream.write(Buffer.from(` M ${filename}\0`));
          else if (
            command.includes("'diff'") &&
            !command.includes("'--cached'")
          )
            stream.write('@@ -1 +1 @@\n-было\n+стало\n');
          stream.exit(code);
          stream.end();
        });
      }),
    );
  });
  connection.listen(0, '127.0.0.1');
  await once(connection, 'listening');
  t.after(() => new Promise((resolve) => connection.close(resolve)));
  store.save(
    'servers',
    {
      id,
      name: 'SSH fixture',
      transport: 'ssh',
      platform: 'linux',
      host: '127.0.0.1',
      port: connection.address().port,
      username: 'review',
      fingerprint,
    },
    { password: 'isolated test password' },
  );
  const folders = await json(`/machines/${id}/files/browse`, {});
  assert.equal(folders.path, root);
  assert.deepEqual(folders.entries, [{ name: filename, kind: 'file' }]);
  const project = await json(
    '/projects',
    { name: 'SSH folder', path: root, machineId: id },
    201,
  );
  const endpoint = `/projects/${project.id}/files`;
  assert.equal(
    (await json(`${endpoint}/file`, { path: filename })).text,
    content.toString(),
  );
  assert.deepEqual((await json(`${endpoint}/git`, {})).files, [
    { path: filename, status: ' M' },
  ]);
  const diff = await json(`${endpoint}/patch`, { path: filename });
  assert.match(diff.working.text, /-было\n\+стало/);
  assert.ok(
    commands
      .filter((command) => command.includes("'diff'"))
      .every((command) => command.includes("'./правка'\\''s.txt'")),
  );
  const session = await json(
    '/sessions',
    { provider: 'codex', projectId: project.id },
    201,
  );
  const chat = `/sessions/${session.id}`;
  await json(
    `${chat}/message`,
    { message: 'Modify a file during the same second' },
    202,
  );
  const detail = await waitFor(
    () => json(chat),
    (value) => value.status === 'idle' && value.messages.length,
  );
  const report = await json(`${chat}/changes/${detail.changedTurns[0]}`);
  assert.equal(report.workspaceEdits[0].path, filename);
  assert.equal(report.workspaceEdits[0].before.text, original);
  assert.equal(report.workspaceEdits[0].after.text, updated);
});
