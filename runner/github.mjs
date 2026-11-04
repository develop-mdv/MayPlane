import { requestSignal, checkCancellation } from './cancellation.mjs';
import { assert } from './security.mjs';
export function repositoryName(url) {
  const parsed = new URL(url);
  assert(
    parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash,
    'Для GitHub-подключения используйте https://github.com/owner/repo',
  );
  const path = parsed.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '');
  assert(
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path),
    'Укажите ссылку на сам репозиторий: https://github.com/owner/repo. Ссылки на ветки, файлы и страницы профиля не подходят.',
  );
  return path.slice(1);
}
export function createGithub(fetcher = fetch) {
  async function api(path, token) {
    assert(
      token === undefined ||
        (typeof token === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(token)),
      'Укажите корректный GitHub Personal Access Token',
    );
    let response;
    try {
      response = await fetcher('https://api.github.com' + path, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'mayplane',
        },
        redirect: 'error',
        signal: requestSignal(15000),
      });
    } catch {
      checkCancellation();
      throw Object.assign(
        new Error('GitHub недоступен. Повторите подключение.'),
        { status: 502 },
      );
    }
    assert(
      response.ok,
      response.status === 401
        ? 'GitHub отклонил токен'
        : response.status === 404
          ? 'Репозиторий не найден или токен не имеет доступа'
          : 'GitHub отказал в доступе. Проверьте права токена и лимит API.',
      response.status === 401 || response.status === 404 ? 400 : 502,
    );
    return response.json();
  }
  return {
    user: (token) => api('/user', token),
    repo: (url, token) => api('/repos/' + repositoryName(url), token),
    async repos(token, page = 1) {
      assert(
        Number.isInteger(page) && page >= 1 && page <= 100,
        'Некорректная страница',
      );
      const result = await api(
        `/user/repos?per_page=100&page=${page}&sort=updated`,
        token,
      );
      return {
        repos: result.map((r) => ({
          fullName: r.full_name,
          repo: r.clone_url,
          branch: r.default_branch,
          private: r.private,
        })),
        hasMore: result.length === 100,
      };
    },
  };
}
