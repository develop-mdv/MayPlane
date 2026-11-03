import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import { createEngine } from '../runner/engine.mjs';
import { createApp } from '../runner/server.mjs';
import { createOperator, readChat } from '../runner/operator.mjs';
import {
  createWorkflowRunner,
  saveWorkflow,
  workflowInput,
} from '../runner/workflows.mjs';

const recipe = {
  summary: 'Arbitrary runtime',
  deploy: 'custom-compiler build && systemctl start "app-$EZDEPLOY_PROJECT_ID"',
  stop: 'systemctl stop "app-$EZDEPLOY_PROJECT_ID"',
  remove: 'systemctl disable --now "app-$EZDEPLOY_PROJECT_ID"',
  check: 'systemctl is-active "app-$EZDEPLOY_PROJECT_ID"',
  logs: 'journalctl -u "app-$EZDEPLOY_PROJECT_ID" -n 50 --no-pager',
  files: { 'repo/custom.conf': 'mode=production' },
  env: [],
};
function fixture(t, env = 'API_TOKEN=app-secret-value') {
  const dir = mkdtempSync(join(tmpdir(), 'ez-operator-'));
  const store = openStore(dir, randomBytes(32));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const server = {
    id: randomUUID(),
    name: 'one',
    host: '203.0.113.10',
    status: 'online',
    secret: { password: 'ssh-secret-value' },
  };
  const project = {
    id: randomUUID(),
    serverId: server.id,
    name: 'generic',
    repo: 'https://github.com/owner/repo.git',
    branch: 'main',
    kind: 'service',
    status: 'stopped',
    domain: '',
    composeFile: 'compose.yaml',
    envKeys: ['API_TOKEN'],
    requiredEnvKeys: [],
    secret: { env },
  };
  store.save('servers', server);
  store.save('projects', project);
  store.save(
    'settings',
    {
      id: 'llm',
      enabled: true,
      model: 'test',
      baseUrl: 'https://example.com/v1',
    },
    { apiKey: 'provider-secret-value' },
  );
  const commands = [],
    writes = [],
    prompts = [];
  const replies = [];
  let calls = 0;
  const overrides = {
    connect: async () => ({ end() {} }),
    inspect: async () => ({
      commit: 'a'.repeat(40),
      paths: ['Makefile'],
      files: { Makefile: 'custom-compiler build' },
      envNames: [],
      omitted: 0,
    }),
    run: async (_c, script, options = {}) => {
      commands.push(script);
      options.log?.('command output');
      return 'command output';
    },
    put: async (_c, path, content) => {
      writes.push({ path, content });
    },
    chat: async (_settings, messages) => {
      calls++;
      prompts.push(JSON.stringify(messages));
      assert.ok(replies.length, 'Unexpected model call');
      return { data: replies.shift(), usage: { input: 4, output: 6 } };
    },
  };
  return {
    store,
    project,
    server,
    commands,
    writes,
    prompts,
    overrides,
    replies,
    calls: () => calls,
  };
}
const reply = (type, extra = {}) => ({
  message: type,
  action: { type, ...extra },
});

test('arbitrary project: tool errors feed back, workflow persists, deployment verifies and future actions use no model', async (t) => {
  const f = fixture(t);
  f.replies.push(
    reply('exec', { command: 'missing-compiler --version' }),
    reply('save_workflow', { workflow: recipe }),
    reply('run_workflow', { operation: 'deploy' }),
    reply('done'),
  );
  const run = f.overrides.run;
  f.overrides.run = async (c, s, o) => {
    if (s.includes('missing-compiler')) {
      o.log?.('missing-compiler: command not found app-secret-value');
      throw new Error('exit 127');
    }
    return run(c, s, o);
  };
  const engine = createEngine(f.store, f.overrides);
  const job = engine.enqueue('chat', {
    projectId: f.project.id,
    intent: 'Deploy this project and save commands',
  });
  await engine.drain();
  assert.equal(f.store.get('jobs', job.id).status, 'success');
  assert.equal(f.store.get('projects', f.project.id).status, 'running');
  assert.ok(f.store.get('projects', f.project.id).workflow.verifiedAt);
  assert.ok(f.prompts[1].includes('command not found'));
  assert.ok(!f.prompts.join('').includes('app-secret-value'));
  assert.ok(!f.prompts.join('').includes('ssh-secret-value'));
  assert.ok(!f.prompts.join('').includes('provider-secret-value'));
  assert.equal(f.store.get('jobs', job.id).usage.calls, 4);
  assert.ok(
    readChat(f.store, 'projects', f.project.id).messages.some(
      (m) => m.role === 'result' && m.success === false,
    ),
  );
  assert.ok(
    !JSON.stringify(f.store.snapshot().projects).includes(
      'custom-compiler build',
    ),
  );
  assert.ok(f.writes.some((w) => w.path.endsWith('/repo/custom.conf')));
  const calls = f.calls();
  for (const operation of ['stop', 'deploy', 'remove']) {
    const j = engine.enqueue(operation, { projectId: f.project.id });
    await engine.drain();
    assert.equal(f.store.get('jobs', j.id).status, 'success');
  }
  assert.equal(f.calls(), calls);
  assert.ok(f.store.get('projects', f.project.id).removedAt);
  assert.equal(f.store.get('projects', f.project.id).autoDeploy, false);
});

test('server chat executes SSH and persists history across turns without affecting project status', async (t) => {
  const f = fixture(t);
  f.replies.push(reply('exec', { command: 'uname -m' }), reply('done'));
  const engine = createEngine(f.store, f.overrides);
  engine.enqueue('chat', {
    serverId: f.server.id,
    intent: 'Проверь архитектуру',
  });
  await engine.drain();
  assert.ok(f.commands.some((s) => s.includes('uname -m')));
  const history = readChat(f.store, 'servers', f.server.id).messages;
  assert.ok(
    history.some(
      (m) => m.role === 'user' && m.content === 'Проверь архитектуру',
    ),
  );
  assert.equal(f.store.get('projects', f.project.id).status, 'stopped');
  f.replies.push(reply('ask', { question: 'Какую службу проверить?' }));
  const before = f.commands.length;
  engine.enqueue('chat', { serverId: f.server.id, intent: 'Продолжи' });
  await engine.drain();
  assert.equal(f.commands.length, before);
  assert.ok(f.prompts.at(-1).includes('Проверь архитектуру'));
  const raw = JSON.stringify(f.store.db.prepare('SELECT * FROM servers').all());
  assert.ok(!raw.includes('Проверь архитектуру'));
});

test('plan is a draft, adds environment fields, does not execute SSH and rejects changed parameters', async (t) => {
  const f = fixture(t);
  f.replies.push({
    summary: 'General plan',
    steps: ['Compile'],
    questions: [],
    workflow: { ...recipe, env: [{ name: 'NEEDED_KEY', required: true }] },
  });
  const operator = createOperator(f.store, f.overrides);
  const plan = await operator.plan(f.project, f.server, 'Plan');
  assert.equal(f.commands.length, 0);
  const p = f.store.get('projects', f.project.id);
  assert.equal(p.secret.workflow, undefined);
  assert.deepEqual(p.missingEnvKeys, ['NEEDED_KEY']);
  assert.equal(p.assistant.runtime, 'commands');
  p.branch = 'other';
  f.store.save('projects', p);
  assert.throws(() => operator.applyPlan(p, plan.id), /Параметры/);
  p.branch = 'main';
  f.store.save('projects', p);
  operator.applyPlan(p, plan.id);
  assert.equal(
    f.store.get('projects', p.id).secret.workflow.deploy,
    recipe.deploy,
  );
  const engine = createEngine(f.store, f.overrides);
  const job = engine.enqueue('deploy', { projectId: p.id });
  await engine.drain();
  assert.equal(f.store.get('jobs', job.id).status, 'failed');
  assert.equal(f.commands.length, 0);
});

test('cancellation after model response prevents command execution', async (t) => {
  const f = fixture(t);
  f.overrides.chat = async () => {
    const job = f.store.list('jobs')[0];
    engine.cancel(job.id);
    return { data: reply('exec', { command: 'must-not-run' }) };
  };
  const engine = createEngine(f.store, f.overrides);
  const job = engine.enqueue('chat', {
    serverId: f.server.id,
    intent: 'check',
  });
  await engine.drain();
  assert.equal(f.commands.length, 0);
  assert.equal(f.store.get('jobs', job.id).cancelRequested, true);
  assert.ok(
    readChat(f.store, 'servers', f.server.id)
      .messages.at(-1)
      .content.includes('отменены'),
  );
});

test('agent stops after 14 steps and records a continuation prompt', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 14; i++)
    f.replies.push(reply('exec', { command: 'true' }));
  const engine = createEngine(f.store, f.overrides);
  engine.enqueue('chat', { serverId: f.server.id, intent: 'check' });
  await engine.drain();
  assert.equal(f.calls(), 14);
  assert.ok(
    readChat(f.store, 'servers', f.server.id)
      .messages.at(-1)
      .content.includes('14'),
  );
});

test('failed health check never marks project running; failed remove keeps project card', async (t) => {
  const f = fixture(t);
  saveWorkflow(f.store, f.project.id, recipe);
  const run = f.overrides.run;
  f.overrides.run = async (c, s, o) => {
    if (s.includes(recipe.check) || s.includes(recipe.remove))
      throw new Error('failed check or removal');
    return run(c, s, o);
  };
  const engine = createEngine(f.store, f.overrides);
  for (const type of ['deploy', 'remove']) {
    const job = engine.enqueue(type, {
      projectId: f.project.id,
      deleteProject: true,
    });
    await engine.drain();
    assert.equal(f.store.get('jobs', job.id).status, 'failed');
    assert.equal(f.store.get('projects', f.project.id).status, 'failed');
  }
  assert.equal(
    f.store.get('projects', f.project.id).workflow.verifiedAt,
    undefined,
  );
});

test('successful removal may delete card, keeps audit job and never asks LLM', async (t) => {
  const f = fixture(t);
  saveWorkflow(f.store, f.project.id, recipe);
  const engine = createEngine(f.store, f.overrides);
  const job = engine.enqueue('remove', {
    projectId: f.project.id,
    deleteProject: true,
  });
  await engine.drain();
  assert.equal(f.store.get('projects', f.project.id), null);
  assert.equal(f.store.get('jobs', job.id).status, 'success');
  assert.equal(f.calls(), 0);
});

test('workflow validation blocks traversal and env writes; logs do not overwrite environment', async (t) => {
  const f = fixture(t);
  for (const path of [
    '../outside',
    'repo/../../etc/passwd',
    'repo/.git/config',
    'repo/.env',
  ])
    assert.throws(() =>
      workflowInput({ ...recipe, files: { [path]: 'bad' } }, f.project),
    );
  assert.throws(() => workflowInput({ ...recipe, check: '' }, f.project));
  saveWorkflow(f.store, f.project.id, recipe);
  const runner = createWorkflowRunner(f.store, f.overrides);
  await runner.execute(
    {},
    f.store.get('projects', f.project.id),
    f.server,
    'logs',
    () => {},
  );
  assert.equal(f.writes.length, 0);
  assert.equal(f.commands.length, 1);
});

test('private checkout removes temporary Git authentication before lifecycle command', async (t) => {
  const f = fixture(t);
  const id = randomUUID();
  f.store.save(
    'git_connections',
    { id, name: 'github' },
    { token: 'github-private-value' },
  );
  f.project.gitConnectionId = id;
  f.store.save('projects', f.project);
  saveWorkflow(f.store, f.project.id, recipe);
  const runner = createWorkflowRunner(f.store, f.overrides);
  await runner.execute(
    {},
    f.store.get('projects', f.project.id),
    f.server,
    'deploy',
    () => {},
  );
  assert.ok(f.writes.some((w) => w.path.startsWith('/opt/ezdeploy/.auth/')));
  assert.ok(
    f.commands.findIndex((s) => s.startsWith('rm -f --')) <
      f.commands.findIndex((s) => s.includes(recipe.deploy)),
  );
  assert.ok(!f.commands.join('').includes('github-private-value'));
});

test('owner API exposes chat and workflow routes, enforces removal confirmation and server job lock', async (t) => {
  const f = fixture(t);
  const enqueued = [];
  const app = createApp({ legacyApi: true,
    store: f.store,
    token: 'owner',
    engine: {
      enqueue: (...args) => {
        enqueued.push(args);
        return { id: 'job' };
      },
      cancel: (id) => ({ id }),
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => app.server.close(r)));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = (path, method = 'GET', body) =>
    fetch(base + path, {
      method,
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const path = `/projects/${f.project.id}`;
  assert.equal((await fetch(base + path + '/chat')).status, 401);
  assert.equal((await request(path + '/chat')).status, 200);
  assert.equal(
    (await request(path + '/chat', 'POST', { message: 'Deploy' })).status,
    202,
  );
  assert.equal(enqueued[0][0], 'chat');
  assert.equal(
    (
      await request(`/servers/${f.server.id}/chat`, 'POST', {
        message: 'check',
      })
    ).status,
    202,
  );
  assert.equal(
    (await request(path + '/workflow', 'PATCH', recipe)).status,
    200,
  );
  assert.equal(
    (await (await request(path + '/workflow')).json()).workflow.deploy,
    recipe.deploy,
  );
  assert.equal((await request(path + '/remove', 'POST', {})).status, 400);
  assert.equal(
    (
      await request(path + '/remove', 'POST', {
        confirmRemove: true,
        deleteProject: true,
      })
    ).status,
    202,
  );
  assert.equal(enqueued.at(-1)[1].deleteProject, true);
  f.store.save('jobs', {
    id: randomUUID(),
    serverId: f.server.id,
    type: 'chat',
    createdAt: new Date().toISOString(),
    status: 'deploying',
    logs: [],
  });
  assert.equal(
    (await request(path + '/workflow', 'PATCH', recipe)).status,
    409,
  );
});

for (const failedReload of [false, true])
  test(`remove managed domain preserves other routes, rollback=${failedReload}`, async (t) => {
    const f = fixture(t);
    f.project.managedDomain = 'removed.example.com';
    f.store.save('projects', f.project);
    f.store.save('projects', {
      ...f.project,
      id: randomUUID(),
      name: 'neighbor',
      managedDomain: 'neighbor.example.com',
      httpPort: 19233,
    });
    let reloads = 0;
    f.overrides.run = async (_c, script) => {
      f.commands.push(script);
      if (script.includes('docker inspect')) return 'true';
      if (script.startsWith('docker exec') && failedReload && reloads++ === 0)
        throw new Error('reload failed');
      return '';
    };
    const runner = createWorkflowRunner(f.store, f.overrides);
    if (failedReload)
      await assert.rejects(
        runner.removeCompose({}, f.project, () => {}),
        /reload failed/,
      );
    else await runner.removeCompose({}, f.project, () => {});
    const config = f.writes.find((w) =>
      w.path.endsWith('Caddyfile.next'),
    ).content;
    assert.ok(config.includes('neighbor.example.com'));
    assert.ok(!config.includes('removed.example.com'));
    assert.equal(
      f.store.get('projects', f.project.id).managedDomain,
      failedReload ? 'removed.example.com' : undefined,
    );
    if (failedReload)
      assert.ok(
        f.commands.some(
          (s) => s.startsWith('mv ') && s.includes('Caddyfile.previous'),
        ),
      );
  });
