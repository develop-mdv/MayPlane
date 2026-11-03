import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  normalizeEnvDefinitions,
  inferEnvDefinitions,
  updateEnvDefinitions,
  deploymentEnv,
  refreshEnvState,
} from '../lib/env-requirements.mjs';
import { parseEnvDocument } from '../lib/environment.mjs';
import { workflowEnvironment, saveWorkflow } from '../runner/workflows.mjs';
import { createEngine } from '../runner/engine.mjs';
import { createApp } from '../runner/server.mjs';
import { openStore } from '../runner/store.mjs';

const definitions = [
  { name: 'ACCESS_TOKEN', required: true, description: 'Токен приложения' },
  {
    name: 'PORT',
    required: false,
    defaultValue: '8080',
    description: 'Порт приложения',
  },
  {
    name: 'LOG_LEVEL',
    required: false,
    defaultValue: 'info',
    description: 'Уровень логов',
  },
];
const project = (env) => ({
  id: randomUUID(),
  name: 'env-test',
  repo: 'https://github.com/test/repo.git',
  branch: 'main',
  kind: 'service',
  requiredEnvKeys: [],
  secret: { env },
});

test('classification updates remove obsolete required flags and retain unrelated requirements', () => {
  const p = project('ACCESS_TOKEN=\nPORT=\nLOG_LEVEL=\nEXTRA=\n');
  p.requiredEnvKeys = ['PORT', 'EXTRA'];
  updateEnvDefinitions(p, definitions);
  assert.deepEqual(p.requiredEnvKeys, ['EXTRA', 'ACCESS_TOKEN']);
  assert.deepEqual(p.missingEnvKeys, ['EXTRA', 'ACCESS_TOKEN']);
  p.secret.env = 'ACCESS_TOKEN=token-value\nPORT=\nLOG_LEVEL=\nEXTRA=0\n';
  refreshEnvState(p);
  assert.deepEqual(p.missingEnvKeys, []);
  assert.deepEqual(p.filledEnvKeys, ['ACCESS_TOKEN', 'EXTRA']);
  assert.equal(
    p.envDefinitions.find((e) => e.name === 'PORT').defaultValue,
    '8080',
  );
});

test('empty optional fields are omitted from deployment while stored draft and explicit values survive', () => {
  const text =
    '# keep comment\r\nACCESS_TOKEN="token=value"\r\nPORT=\r\nLOG_LEVEL=""\r\nCUSTOM=\r\n';
  const p = project(text);
  updateEnvDefinitions(p, definitions);
  const stored = p.secret.env;
  const runtime = deploymentEnv(p);
  const values = Object.fromEntries(
    parseEnvDocument(runtime).rows.map((r) => [r.key, r.value]),
  );
  assert.equal(values.ACCESS_TOKEN, 'token=value');
  assert.equal(values.PORT, undefined);
  assert.equal(values.LOG_LEVEL, undefined);
  assert.equal(values.CUSTOM, '');
  assert.equal(p.secret.env, stored);
  assert.ok(runtime.includes('# keep comment\r\n'));
  const shell = workflowEnvironment(p, { host: '203.0.113.10' });
  assert.ok(!shell.includes('export PORT='));
  assert.ok(!shell.includes('export LOG_LEVEL='));
  p.secret.env = 'ACCESS_TOKEN=token-value\nPORT=0\nLOG_LEVEL=false\n';
  assert.equal(
    Object.fromEntries(
      parseEnvDocument(deploymentEnv(p)).rows.map((r) => [r.key, r.value]),
    ).PORT,
    '0',
  );
  assert.ok(deploymentEnv(p).includes('LOG_LEVEL=false'));
});

test('defaults are metadata only, required secrets and credential defaults never become public defaults', () => {
  const result = normalizeEnvDefinitions([
    {
      name: 'API_KEY',
      required: false,
      defaultValue: 'a-secret',
      description: 'Optional integration',
    },
    {
      name: 'ENDPOINT',
      required: false,
      defaultValue: 'https://user:password@example.com',
    },
    { name: 'PORT', required: true, defaultValue: '8080' },
    { name: 'UNKNOWN', description: 'Unclassified' },
  ]);
  assert.ok(result.every((e) => e.defaultValue === undefined));
  assert.equal(result[3].required, null);
  assert.throws(
    () => normalizeEnvDefinitions([{ name: 'X', required: 'false' }]),
    /Обязательность/,
  );
  assert.throws(
    () => normalizeEnvDefinitions([{ name: 'X' }, { name: 'X' }]),
    /повторяющееся/,
  );
});

test('Compose inference respects required/default syntax, escaped variables, conflicts and selected file', () => {
  const result = inferEnvDefinitions(
    {
      'compose.yaml':
        'services:\n  app:\n    image: busybox\n    environment:\n      A: ${ACCESS_TOKEN:?token required}\n      B: ${PORT-8080}\n      C: ${LOG_LEVEL:-info}\n      D: $${ESCAPED:-no}\n      E: ${MIXED:-a}\n      F: ${MIXED}\n      G: ${PASSWORD:-secret}\n# ${IGNORED:?ignored}\n',
      'other/compose.yaml': 'image: ${PORT:?port required}',
    },
    ['FROM_EXAMPLE'],
    'compose.yaml',
  );
  const byName = Object.fromEntries(result.map((e) => [e.name, e]));
  assert.equal(byName.ACCESS_TOKEN.required, true);
  assert.equal(byName.PORT.required, false);
  assert.equal(byName.PORT.defaultValue, '8080');
  assert.equal(byName.LOG_LEVEL.defaultValue, 'info');
  assert.equal(byName.MIXED.required, null);
  assert.equal(byName.FROM_EXAMPLE.required, null);
  assert.equal(byName.PASSWORD.defaultValue, undefined);
  assert.equal(byName.ESCAPED, undefined);
  assert.equal(byName.IGNORED, undefined);
});

test('real Docker Compose uses fallback values when optional fields are left blank', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ez-env-defaults-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = project('ACCESS_TOKEN=synthetic-token\nPORT=\nLOG_LEVEL=\n');
  updateEnvDefinitions(p, definitions);
  writeFileSync(join(dir, '.env'), deploymentEnv(p));
  writeFileSync(
    join(dir, 'compose.yaml'),
    'services:\n  app:\n    image: busybox\n    environment:\n      ACCESS_TOKEN: ${ACCESS_TOKEN:?required}\n      PORT: ${PORT-8080}\n      LOG_LEVEL: ${LOG_LEVEL:-info}\n',
  );
  const env = { ...process.env };
  for (const name of ['ACCESS_TOKEN', 'PORT', 'LOG_LEVEL']) delete env[name];
  const data = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        join(dir, '.env'),
        '-f',
        join(dir, 'compose.yaml'),
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', env },
    ),
  );
  assert.equal(data.services.app.environment.PORT, '8080');
  assert.equal(data.services.app.environment.LOG_LEVEL, 'info');
});

test('owner state exposes classification without secret values; deploy accepts empty optional and rejects missing required', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ez-env-api-'));
  const store = openStore(dir, randomBytes(32));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const serverId = randomUUID();
  store.save(
    'servers',
    { id: serverId, name: 'server', host: '203.0.113.10', status: 'online' },
    { password: 'fake-ssh-password' },
  );
  const p = {
    ...project('ACCESS_TOKEN=fake-app-token\nPORT=\nLOG_LEVEL=\n'),
    serverId,
    status: 'stopped',
    composeFile: 'compose.yaml',
  };
  store.save('projects', p);
  saveWorkflow(store, p.id, {
    summary: 'test',
    deploy: 'echo start',
    stop: 'echo stop',
    remove: 'echo remove',
    check: 'echo ok',
    logs: 'echo logs',
    files: {},
    env: definitions,
  });
  const uploads = [];
  const engine = createEngine(store, {
    connect: async () => ({ end() {} }),
    run: async () => '',
    put: async (_c, path, data) => uploads.push({ path, data }),
  });
  const app = createApp({ legacyApi: true, store, token: 'owner', engine });
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
  let state = await (await request('/state')).json();
  assert.deepEqual(state.projects[0].filledEnvKeys, ['ACCESS_TOKEN']);
  assert.deepEqual(state.projects[0].missingEnvKeys, []);
  assert.equal(
    state.projects[0].envDefinitions.find((e) => e.name === 'PORT').required,
    false,
  );
  assert.ok(!JSON.stringify(state).includes('fake-app-token'));
  assert.ok(!JSON.stringify(state).includes('fake-ssh-password'));
  const result = await request(`/projects/${p.id}/deploy`, 'POST', {});
  assert.equal(result.status, 202);
  const job = await result.json();
  await engine.drain();
  assert.equal(store.get('jobs', job.id).status, 'success');
  assert.ok(uploads.length);
  assert.ok(uploads.every((u) => !u.data.includes('PORT=')));
  await request(`/projects/${p.id}`, 'PATCH', {
    env: 'ACCESS_TOKEN=\nPORT=\nLOG_LEVEL=\n',
  });
  assert.equal(
    (await request(`/projects/${p.id}/deploy`, 'POST', {})).status,
    400,
  );
  state = await (await request('/state')).json();
  assert.deepEqual(state.projects[0].missingEnvKeys, ['ACCESS_TOKEN']);
});
