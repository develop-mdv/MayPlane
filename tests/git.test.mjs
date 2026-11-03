import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
import { createApp } from '../runner/server.mjs';
import { createEngine } from '../runner/engine.mjs';
import { createGithub, repositoryName } from '../runner/github.mjs';
import { compose, workspaceOf } from '../runner/ssh.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ez-git-'));
  const store = openStore(dir, randomBytes(32));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = randomUUID();
  store.save(
    'servers',
    { id, name: 'test', status: 'online' },
    { password: 'test-password' },
  );
  return { store, id };
}
test('GitHub API uses fixed origin, read permissions, pagination and safe errors', async () => {
  const calls = [];
  const github = createGithub(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () =>
        url.includes('/user/repos')
          ? [
              {
                full_name: 'owner/private',
                clone_url: 'https://github.com/owner/private.git',
                default_branch: 'dev',
                private: true,
              },
            ]
          : { login: 'owner' },
    };
  });
  const token = 'github_pat_test_only_123456789';
  assert.equal((await github.user(token)).login, 'owner');
  const result = await github.repos(token, 2);
  assert.equal(result.repos[0].private, true);
  assert.equal(result.repos[0].branch, 'dev');
  assert.equal(result.hasMore, false);
  assert.match(calls[1].url, /page=2/);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(
    repositoryName('https://github.com/owner/private.git'),
    'owner/private',
  );
  for (const url of [
    'https://evil.example/owner/repo',
    'https://github.com:8080/owner/repo',
    'https://user:secret@github.com/owner/repo',
  ])
    await assert.rejects(async () => github.repo(url, token));
  assert.equal(calls.length, 2);
  await assert.rejects(github.repos(token, 0));
  await assert.rejects(
    createGithub(async () => ({ ok: false, status: 401 })).user(token),
    /GitHub отклонил токен/,
  );
});
test('private account token is encrypted; env is readable only through owner API', async (t) => {
  const { store, id } = fixture(t);
  const token = 'github_pat_test_only_123456789';
  let checkedRepo;
  const { server } = createApp({ legacyApi: true,
    store,
    token: 'owner-api-key',
    github: {
      user: async () => ({ login: 'owner' }),
      repos: async () => ({ repos: [], hasMore: false }),
      repo: async (url) => {
        checkedRepo = url;
      },
    },
    engine: { enqueue: () => ({ id: 'job' }) },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, method = 'GET', body) =>
    fetch(url + path, {
      method,
      headers: {
        Authorization: 'Bearer owner-api-key',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const account = await (
    await request('/git/connections', 'POST', { token })
  ).json();
  assert.equal(store.get('git_connections', account.id).secret.token, token);
  assert.ok(!JSON.stringify(store.snapshot()).includes(token));
  assert.ok(
    !store.db
      .prepare('SELECT secret FROM git_connections')
      .get()
      .secret.includes(token),
  );
  const rotated = await (
    await request('/git/connections', 'POST', { token: token + 'new' })
  ).json();
  assert.equal(rotated.id, account.id);
  assert.equal(store.list('git_connections').length, 1);
  const repo = 'https://github.com/owner/private.git';
  const res = await request('/projects', 'POST', {
    name: 'private-app',
    serverId: id,
    repo,
    gitConnectionId: account.id,
    kind: 'bot',
    branch: 'main',
    composeFile: 'sub/docker-compose.yml',
    env: 'TOKEN=',
    requiredEnvKeys: ['TOKEN'],
  });
  assert.equal(res.status, 201);
  const p = await res.json();
  assert.equal(checkedRepo, repo);
  assert.deepEqual(p.missingEnvKeys, ['TOKEN']);
  await request(`/projects/${p.id}`, 'PATCH', {
    env: 'TOKEN=secret-env-value',
  });
  const env = await request(`/projects/${p.id}/env`);
  assert.equal(env.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await env.json(), { env: 'TOKEN=secret-env-value' });
  assert.equal((await fetch(url + `/projects/${p.id}/env`)).status, 401);
  assert.deepEqual(store.list('projects')[0].missingEnvKeys, []);
  assert.ok(!JSON.stringify(store.snapshot()).includes('secret-env-value'));
});
for (const failGit of [false, true])
  test(`private Git credentials cleaned before build, nested Compose env, failure=${failGit}`, async (t) => {
    const { store, id } = fixture(t);
    const gid = randomUUID();
    const token = 'github_pat_test_only_123456789';
    store.save('git_connections', { id: gid, login: 'owner' }, { token });
    const p = {
      id: randomUUID(),
      name: 'private-app',
      repo: 'https://github.com/owner/private.git',
      branch: 'main',
      composeFile: 'nested/docker-compose.yml',
      serverId: id,
      gitConnectionId: gid,
      status: 'stopped',
      envKeys: ['TOKEN'],
      requiredEnvKeys: ['TOKEN'],
      updatedAt: new Date().toISOString(),
    };
    store.save('projects', p, { env: 'TOKEN=build-only-secret' });
    const calls = [];
    const engine = createEngine(store, {
      connect: async () => ({ end() {} }),
      put: async (_c, path, value) => calls.push({ path, value }),
      run: async (_c, script, options = {}) => {
        calls.push({ script });
        if (script.includes('git fetch') || script.includes(' fetch origin')) {
          options.log?.(token);
          if (failGit) throw new Error('Fetch failed ' + token);
        }
        return script.includes('rev-parse') ? 'abcdef0\n' : '';
      },
    });
    const job = engine.enqueue('build', { projectId: p.id });
    await engine.drain();
    const finished = store.get('jobs', job.id);
    assert.equal(finished.status, failGit ? 'failed' : 'success');
    assert.equal(store.get('projects', p.id).status, 'stopped');
    assert.ok(!JSON.stringify(finished).includes(token));
    assert.ok(
      calls.filter((c) => c.script).every((c) => !c.script.includes(token)),
    );
    const cleanup = calls.findIndex((c) => c.script?.startsWith('rm -f --'));
    assert.ok(cleanup >= 0);
    if (!failGit) {
      const env = calls.findIndex((c) => c.path?.endsWith('/nested/.env'));
      assert.ok(env > cleanup);
      assert.equal(calls[env].value, 'TOKEN=build-only-secret');
      assert.match(compose(p), /nested'\ndocker compose/);
      assert.equal(workspaceOf(p), `/opt/ezdeploy/${p.id}/repo/nested`);
      assert.ok(calls.some((c) => c.script?.endsWith(' build')));
      assert.ok(!calls.some((c) => c.script?.includes('up -d')));
    } else assert.ok(!calls.some((c) => c.path?.endsWith('/.env')));
  });
