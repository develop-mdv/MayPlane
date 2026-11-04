import { requestSignal, checkCancellation } from './cancellation.mjs';
import { assert, redact } from './security.mjs';
import { repositoryName } from './github.mjs';
const selected =
  /(^|\/)(README(?:\.[a-z]+)?|package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|composer\.json|Gemfile|pom\.xml|Dockerfile(?:\.[\w-]+)?|(?:docker-)?compose[^/]*\.ya?ml|\.env\.(?:example|sample|template))$/i;
export function scrub(text, secrets = []) {
  return redact(text, secrets)
    .replace(
      /-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g,
      '[PRIVATE KEY REMOVED]',
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{25,}|\d{8,12}:[A-Za-z0-9_-]{30,})\b/g,
      '[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(
      /((?:token|api[_-]?key|password|secret)\s*[=:]\s*["']?)[A-Za-z0-9_+/.-]{12,}/gi,
      '$1[REDACTED]',
    );
}
export async function inspectRepository(
  project,
  token,
  { fetcher = fetch, secrets = [] } = {},
) {
  const name = repositoryName(project.repo);
  async function api(path) {
    let res;
    try {
      res = await fetcher('https://api.github.com/repos/' + name + path, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'mayplane',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        redirect: 'error',
        signal: requestSignal(20000),
      });
    } catch {
      checkCancellation();
      assert(false, 'Не удалось прочитать репозиторий GitHub', 502);
    }
    assert(
      res.ok,
      res.status === 404
        ? 'Репозиторий или ветка не найдены. Проверьте GitHub-доступ.'
        : 'GitHub ограничил доступ. Подключите токен или повторите позже.',
      502,
    );
    return res.json();
  }
  const commit = await api('/commits/' + encodeURIComponent(project.branch));
  assert(
    /^[a-f0-9]{40}$/.test(commit.sha),
    'GitHub вернул некорректный commit',
    502,
  );
  const tree = await api('/git/trees/' + commit.sha + '?recursive=1');
  assert(
    !tree.truncated,
    'Репозиторий слишком большой для автоматического анализа. Укажите готовый Compose-файл.',
  );
  const entries = (tree.tree || []).filter(
    (f) =>
      f.type === 'blob' &&
      f.mode !== '120000' &&
      !f.path
        .split('/')
        .some((s) => ['node_modules', '.git', 'vendor', '.venv'].includes(s)),
  );
  const paths = entries.map((f) => f.path).slice(0, 5000);
  const candidates = entries
    .filter((f) => selected.test(f.path) && f.size <= 24000)
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)
    .slice(0, 24);
  const files = {};
  const envNames = new Set();
  let total = 0;
  for (let i = 0; i < candidates.length; i += 4) {
    const group = await Promise.all(
      candidates.slice(i, i + 4).map(async (f) => {
        const blob = await api('/git/blobs/' + f.sha);
        assert(blob.encoding === 'base64', 'Неизвестный формат GitHub blob');
        return [f.path, Buffer.from(blob.content, 'base64').toString('utf8')];
      }),
    );
    for (const [path, raw] of group) {
      let text = raw;
      if (/(^|\/)\.env\./.test(path)) {
        text = text
          .split(/\r?\n/)
          .map(
            (line) =>
              line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1],
          )
          .filter(Boolean)
          .map((key) => {
            envNames.add(key);
            return key + '=';
          })
          .join('\n');
      }
      text = scrub(text, secrets);
      total += text.length;
      if (total <= 160000) files[path] = text;
    }
  }
  return {
    commit: commit.sha,
    paths,
    files,
    envNames: [...envNames],
    omitted:
      entries.filter((f) => selected.test(f.path)).length -
      Object.keys(files).length,
  };
}
