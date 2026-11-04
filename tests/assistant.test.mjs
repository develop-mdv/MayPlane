import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { createEngine } from '../runner/engine.mjs';
import { createAssistant } from '../runner/assistant.mjs';
import { llmInput, chatJson } from '../runner/llm.mjs';
import { detectRecipe, compileRecipe } from '../runner/recipes.mjs';
import { inspectRepository } from '../runner/repository-context.mjs';
import {
  domainName,
  publishEndpoint,
  validateAutomaticCompose,
} from '../runner/managed-deploy.mjs';
const sha = 'a'.repeat(40);
const context = {
  commit: sha,
  paths: ['package.json', 'package-lock.json', 'server.js', '.env.example'],
  files: {
    'package.json': JSON.stringify({
      scripts: { start: 'node server.js', build: 'echo build' },
    }),
    '.env.example': 'BOT_TOKEN=',
  },
  envNames: ['BOT_TOKEN'],
  omitted: 0,
};
function fixture(t, env = '') {
  const dir = mkdtempSync(join(tmpdir(), 'mayplane-ai-'));
  const store = openStore(dir, randomBytes(32));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const serverId = randomUUID();
  store.save(
    'servers',
    { id: serverId, name: 'server', host: '203.0.113.10', status: 'online' },
    { password: 'ssh-private-value' },
  );
  const p = {
    id: randomUUID(),
    serverId,
    name: 'assistant-test',
    repo: 'https://github.com/owner/repo.git',
    branch: 'main',
    kind: 'web',
    domain: '',
    status: 'stopped',
    composeFile: 'compose.yaml',
    envKeys: [],
    requiredEnvKeys: [],
    secret: { env },
  };
  store.save('projects', p);
  return { store, p };
}
test('provider credentials encrypted, authenticated API and connection test', async (t) => {
  const { store, p } = fixture(t);
  const apiKey = 'provider-secret-key';
  const calls = [];
  let enqueued;
  const { server } = createApp({ legacyApi: true,
    store,
    token: 'owner',
    engine: {
      enqueue(type, input) {
        enqueued = { type, ...input };
        return { id: randomUUID(), type };
      },
    },
    llmChat: async (settings) => {
      calls.push(settings);
      return { data: { ok: true }, usage: { input: 3, output: 5 } };
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (path, body) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await fetch(base + '/llm/settings', { method: 'POST' })).status,
    401,
  );
  assert.equal(
    (
      await post('/llm/settings', {
        baseUrl: 'https://api.alltokens.ru/api/v1',
        model: 'google/gemini-3.8-flash',
        apiKey,
        enabled: true,
      })
    ).status,
    200,
  );
  const state = await fetch(base + '/state', {
    headers: { Authorization: 'Bearer owner' },
  }).then((r) => r.json());
  assert.equal(state.llm.configured, true);
  assert.ok(!JSON.stringify(state).includes(apiKey));
  assert.ok(
    !store.db
      .prepare("SELECT secret FROM settings WHERE id='llm'")
      .get()
      .secret.includes(apiKey),
  );
  assert.equal((await post('/llm/test', {})).status, 200);
  assert.equal(calls.at(-1).secret.apiKey, apiKey);
  const secondKey = 'second-provider-secret';
  const created = await post('/llm/models', {
    name: 'Second model',
    baseUrl: 'https://second.example/v1',
    model: 'second/model',
    apiKey: secondKey,
    enabled: true,
  }).then((response) => response.json());
  const second = created.models.find((model) => model.name === 'Second model');
  assert.ok(second);
  assert.ok(!JSON.stringify(created).includes(secondKey));
  assert.ok(
    !store.db
      .prepare("SELECT secret FROM settings WHERE id='llm'")
      .get()
      .secret.includes(secondKey),
  );
  assert.equal(
    (
      await post('/llm/test', {
        modelId: second.id,
      })
    ).status,
    200,
  );
  assert.equal(calls.at(-1).secret.apiKey, secondKey);
  assert.equal(
    (
      await post(`/projects/${p.id}/chat`, {
        message: 'Use selected model',
        modelId: second.id,
      })
    ).status,
    202,
  );
  assert.equal(enqueued.modelId, second.id);
  const updated = await fetch(base + '/llm/models/' + second.id, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer owner',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Renamed model' }),
  }).then((response) => response.json());
  assert.equal(
    updated.models.find((model) => model.id === second.id).name,
    'Renamed model',
  );
  assert.equal(
    (
      await fetch(base + '/llm/models/' + second.id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner' },
      })
    ).status,
    200,
  );
  const afterDelete = await fetch(base + '/state', {
    headers: { Authorization: 'Bearer owner' },
  }).then((response) => response.json());
  assert.ok(!afterDelete.llm.models.some((model) => model.id === second.id));
  assert.equal(
    (
      await post('/llm/settings', {
        baseUrl: 'https://another.example/v1',
        model: 'test',
      })
    ).status,
    400,
  );
});
test('OpenAI-compatible JSON response, malformed responses and upstream error privacy', async () => {
  const config = llmInput({
    baseUrl: 'https://api.alltokens.ru/api/v1',
    model: 'google/gemini-3.8-flash',
    apiKey: 'secret',
  });
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: '```json\n{"ok":true}\n```' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );
  };
  const result = await chatJson(config, [{ role: 'user', content: 'test' }], {
    fetcher,
  });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(
    calls[0].url,
    'https://api.alltokens.ru/api/v1/chat/completions',
  );
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(calls[0].options.body).model, config.model);
  await assert.rejects(
    chatJson(config, [], {
      fetcher: async () => new Response('raw secret', { status: 401 }),
    }),
    (e) => e.status === 502 && !e.message.includes('raw secret'),
  );
  await assert.rejects(
    chatJson(config, [], {
      fetcher: async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] }),
        ),
    }),
    /схеме/,
  );
  for (const url of [
    'http://remote.example/v1',
    'https://user:key@provider.example/v1',
    'https://provider.example/v1?key=secret',
  ])
    assert.throws(() => llmInput({ baseUrl: url, model: 'x', apiKey: 's' }));
});
test('repository scanner excludes env, symlinks and credentials; pins blobs to commit', async () => {
  const blobs = {
    manifest: JSON.stringify({ scripts: { start: 'node server.js' } }),
    env: 'TOKEN=actual-env-secret\nOPTIONAL=\n',
    readme: 'README github_pat_12345678901234567890',
  };
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    if (url.includes('/commits/')) return Response.json({ sha });
    if (url.includes('/git/trees/'))
      return Response.json({
        tree: [
          {
            type: 'blob',
            mode: '100644',
            path: 'package.json',
            sha: 'manifest',
            size: 60,
          },
          {
            type: 'blob',
            mode: '100644',
            path: '.env.example',
            sha: 'env',
            size: 50,
          },
          {
            type: 'blob',
            mode: '100644',
            path: '.env',
            sha: 'secret',
            size: 30,
          },
          {
            type: 'blob',
            mode: '120000',
            path: 'Dockerfile',
            sha: 'symlink',
            size: 20,
          },
          {
            type: 'blob',
            mode: '100644',
            path: 'README.md',
            sha: 'readme',
            size: 90,
          },
        ],
      });
    const key = url.split('/').at(-1);
    assert.ok(blobs[key]);
    return Response.json({
      encoding: 'base64',
      content: Buffer.from(blobs[key]).toString('base64'),
    });
  };
  const ctx = await inspectRepository(
    { repo: 'https://github.com/owner/repo.git', branch: 'main' },
    undefined,
    { fetcher },
  );
  assert.equal(ctx.commit, sha);
  assert.deepEqual(ctx.envNames, ['TOKEN', 'OPTIONAL']);
  assert.equal(ctx.files['.env.example'], 'TOKEN=\nOPTIONAL=');
  assert.ok(!JSON.stringify(ctx.files).includes('actual-env-secret'));
  assert.ok(!JSON.stringify(ctx.files).includes('github_pat_123'));
  assert.ok(!urls.some((u) => u.endsWith('/secret') || u.endsWith('/symlink')));
});
test('recipe selection creates scoped configuration and rejects invented commands or traversal', () => {
  const p = { kind: 'web', composeFile: 'compose.yaml' };
  const recipe = detectRecipe(context, p);
  assert.equal(recipe.runtime, 'node');
  const compiled = compileRecipe(
    { ...recipe, env: [{ name: 'VITE_API_URL', required: true }] },
    context,
    p,
  );
  const compose = JSON.parse(compiled.files['mayplane.compose.yaml']);
  assert.deepEqual(compose.services.app.ports, ['${MAYPLANE_HTTP_PORT}:3000']);
  assert.equal(compose.services.app.build.args.VITE_API_URL, '${VITE_API_URL}');
  assert.match(
    compiled.files['mayplane.Dockerfile'],
    /ENV VITE_API_URL=\$VITE_API_URL/,
  );
  for (const modified of [
    { workdir: '../outside' },
    { startScript: 'curl evil' },
    { startScript: 'invented' },
    { runtime: 'shell' },
  ])
    assert.throws(() => compileRecipe({ ...recipe, ...modified }, context, p));
  const py = {
    paths: ['backend/requirements.txt', 'backend/app/main.py'],
    files: {},
    envNames: [],
  };
  assert.match(
    compileRecipe(
      {
        runtime: 'python',
        workdir: 'backend',
        entry: 'app.main',
        pythonMode: 'module',
        env: [],
      },
      py,
      { kind: 'bot' },
    ).files['backend/mayplane.Dockerfile'],
    /"python","-m","app.main"/,
  );
});
test('analysis stops for missing env, does not connect SSH, and keeps sensitive values out of prompts', async (t) => {
  const { store, p } = fixture(t);
  store.save(
    'settings',
    {
      id: 'llm',
      baseUrl: 'https://provider.example/v1',
      model: 'test',
      enabled: true,
    },
    { apiKey: 'llm-private-value' },
  );
  let prompt,
    ssh = 0;
  const engine = createEngine(store, {
    connect: async () => {
      ssh++;
      throw new Error('Must not connect');
    },
    operatorOptions: {
      inspect: async () => context,
      chat: async (_settings, messages) => {
        prompt = JSON.stringify(messages);
        return {
          data: {
            summary: 'Generic commands',
            steps: [],
            notes: [],
            questions: [],
            workflow: {
              summary: 'Generic',
              deploy: 'node server.js',
              stop: 'echo stop',
              remove: 'echo remove',
              check: 'echo check',
              logs: 'echo logs',
              files: {},
              env: [{ name: 'BOT_TOKEN', required: true }],
            },
          },
          usage: { input: 10, output: 20 },
        };
      },
    },
  });
  const j = engine.enqueue('analyze', {
    projectId: p.id,
    intent: 'start the site',
  });
  await engine.drain();
  assert.equal(store.get('jobs', j.id).status, 'success');
  assert.equal(ssh, 0);
  const fresh = store.get('projects', p.id);
  assert.deepEqual(fresh.missingEnvKeys, ['BOT_TOKEN']);
  assert.equal(fresh.status, 'stopped');
  assert.ok(
    !prompt.includes('ssh-private-value') &&
      !prompt.includes('llm-private-value'),
  );
  assert.equal(fresh.assistant.source, 'test');
  assert.equal(fresh.composeFile, 'compose.yaml');
  assert.ok(!store.snapshot().projects[0].secret);
});
test('analysis and apply reject stale project parameters, preserve working configuration', async (t) => {
  const { store, p } = fixture(t, 'BOT_TOKEN=present');
  const assistant = createAssistant(store, { inspect: async () => context });
  await assistant.prepare(p, { useLlm: false });
  const id = p.assistant.id;
  p.domain = 'changed.example.com';
  assert.throws(() => assistant.apply(p, id), /Параметры проекта изменились/);
  assert.equal(p.composeFile, 'compose.yaml');
});
test('automatic deploy runs prepared recipe, chooses a free port and publishes HTTP result', async (t) => {
  const { store, p } = fixture(t, 'BOT_TOKEN=present');
  const calls = [],
    writes = [];
  const root = `/opt/mayplane/${p.id}/repo`;
  const config = {
    services: {
      app: {
        build: { context: root, dockerfile: 'mayplane.Dockerfile' },
        volumes: [{ type: 'volume', source: 'data' }],
        ports: [{ published: '18081' }],
      },
    },
    volumes: { data: {} },
  };
  const run = async (_client, script) => {
    calls.push(script);
    if (script.includes('ss -H')) return '0.0.0.0:18080\n';
    if (script.includes('config --format json')) return JSON.stringify(config);
    if (script.startsWith('realpath ')) return root;
    if (script.includes('timeout 12')) return 'HTTP/1.1 200 OK\r\n';
    if (script.includes('rev-parse --short')) return 'aaaaaaa\n';
    return '';
  };
  const engine = createEngine(store, {
    connect: async () => ({ end() {} }),
    run,
    put: async (_c, path, content) => writes.push({ path, content }),
    assistantOptions: { inspect: async () => context },
  });
  const job = engine.enqueue('auto-deploy', { projectId: p.id, useLlm: false });
  await engine.drain();
  const result = store.get('jobs', job.id);
  assert.equal(result.status, 'success', result.logs.join('\n'));
  const deployed = store.get('projects', p.id);
  assert.equal(deployed.status, 'running');
  assert.equal(deployed.httpPort, 18081);
  assert.equal(deployed.publicUrl, 'http://203.0.113.10:18081');
  assert.equal(deployed.deploymentChecks.httpStatus, 200);
  assert.ok(writes.some((f) => f.path.endsWith('/mayplane.Dockerfile')));
  assert.ok(calls.some((s) => s.includes('up -d --build')));
  assert.ok(calls.some((s) => s.includes(sha)));
});
test('automatic Compose blocks host access and domain setup preserves an existing proxy', async (t) => {
  const { store, p } = fixture(t);
  const bad = { services: { app: { privileged: true } } };
  await assert.rejects(
    validateAutomaticCompose({}, p, {
      compose: () => '',
      run: async () => JSON.stringify(bad),
    }),
    /расширенного доступа/,
  );
  assert.equal(domainName('https://app.example.com/'), 'app.example.com');
  assert.equal(domainName('app.example.com\n{ evil }'), '');
  const writes = [];
  p.httpPort = 18080;
  p.secret.generatedFiles = { 'mayplane.compose.yaml': '{}' };
  p.domain = 'app.example.com';
  await publishEndpoint({}, p, {
    store,
    compose: () => '',
    put: async (...args) => writes.push(args),
    dns: async () => [{ address: '203.0.113.10' }],
    log: () => {},
    run: async (_c, script) =>
      script.includes('timeout 12')
        ? 'HTTP/1.1 200 OK\n'
        : script.includes('ss -H')
          ? '0.0.0.0:443\n'
          : '',
  });
  assert.equal(writes.length, 0);
  assert.ok(
    p.deploymentChecks.steps.some((s) => s.includes('Порты 80/443 заняты')),
  );
  assert.equal(p.publicUrl, 'http://203.0.113.10:18080');
});
for (const failReload of [false, true])
  test(`managed HTTPS preserves other project routes, reload failure=${failReload}`, async (t) => {
    const { store, p } = fixture(t);
    p.domain = 'new.example.com';
    p.httpPort = 18081;
    p.secret.generatedFiles = { 'mayplane.compose.yaml': '{}' };
    store.save('projects', {
      ...p,
      id: randomUUID(),
      name: 'other-app',
      managedDomain: 'old.example.com',
      httpPort: 18080,
    });
    const writes = [];
    const commands = [];
    let reloads = 0;
    await publishEndpoint({}, p, {
      store,
      compose: () => '',
      log: () => {},
      dns: async () => [{ address: '203.0.113.10' }],
      put: async (_c, path, content) => writes.push({ path, content }),
      run: async (_c, script) => {
        commands.push(script);
        if (script.includes('timeout 12')) return 'HTTP/1.1 200 OK\n';
        if (script.includes('docker inspect')) return 'true\n';
        if (script.includes('caddy reload') && reloads++ === 0 && failReload)
          throw new Error('reload failed');
        return '';
      },
    });
    const next = writes.find((w) => w.path.endsWith('Caddyfile.next'));
    assert.ok(
      next.content.includes('old.example.com') &&
        next.content.includes('new.example.com'),
    );
    assert.ok(
      commands
        .find((c) => c.includes('caddy validate'))
        .includes('--adapter caddyfile'),
    );
    if (failReload) {
      assert.equal(p.managedDomain, undefined);
      assert.ok(
        commands.some(
          (c) => c.startsWith('mv ') && c.includes('Caddyfile.previous'),
        ),
      );
      assert.ok(
        p.deploymentChecks.steps.some((s) => s.includes('не завершена')),
      );
    } else {
      assert.equal(p.publicUrl, 'https://new.example.com');
      assert.equal(p.managedDomain, 'new.example.com');
    }
  });
