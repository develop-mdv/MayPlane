import { parseEnvDocument, serializeEnvDocument } from './environment.mjs';

/** @typedef {{name:string, required:boolean|null, description:string, defaultValue?:string}} EnvDefinition */
const sensitiveName = /TOKEN|PASSWORD|PASSWD|SECRET|KEY|CREDENTIAL|AUTH|DSN/i;
/** Validate public descriptions, never publish default credentials. */
export function normalizeEnvDefinitions(input) {
  if (!Array.isArray(input) || input.length > 100)
    throw Object.assign(new Error('Нужно не более 100 описаний переменных'), {
      status: 400,
    });
  const names = new Set();
  return input.map((item) => {
    if (
      !item ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(item.name) ||
      names.has(item.name)
    )
      throw Object.assign(
        new Error('Некорректное или повторяющееся имя переменной'),
        { status: 400 },
      );
    names.add(item.name);
    if (![true, false, null, undefined].includes(item.required))
      throw Object.assign(
        new Error('Обязательность переменной должна быть true, false или null'),
        { status: 400 },
      );
    /** @type {EnvDefinition} */
    const result = {
      name: item.name,
      required:
        item.required === true ? true : item.required === false ? false : null,
      description: String(item.description || '').slice(0, 500),
    };
    if (
      result.required === false &&
      typeof item.defaultValue === 'string' &&
      item.defaultValue.length <= 500 &&
      !sensitiveName.test(item.name) &&
      !/\[REDACTED\]|PRIVATE KEY|:\/\/[^\s/@]+:[^\s/@]+@|\b(?:sk-|ghp_|github_pat_)/i.test(
        item.defaultValue,
      )
    )
      result.defaultValue = item.defaultValue;
    return result;
  });
}
/** Supports existing projects whose metadata lives in an older assistant plan. */
export function getEnvDefinitions(project) {
  const known = normalizeEnvDefinitions(
    project.envDefinitions ||
      project.assistant?.env ||
      project.secret?.workflow?.env ||
      [],
  );
  const names = new Set(known.map((e) => e.name));
  for (const name of project.requiredEnvKeys || [])
    if (!names.has(name)) {
      known.push({ name, required: true, description: '' });
      names.add(name);
    }
  return known;
}
/** Replace obsolete required flags, retain requirements not mentioned by the new plan. */
export function updateEnvDefinitions(project, input) {
  const next = normalizeEnvDefinitions(input);
  const merged = new Map(getEnvDefinitions(project).map((e) => [e.name, e]));
  for (const item of next) merged.set(item.name, item);
  project.envDefinitions = [...merged.values()];
  const document = parseEnvDocument(project.secret.env || '');
  const existing = new Set(document.rows.map((row) => row.key));
  for (const item of project.envDefinitions)
    if (!existing.has(item.name))
      document.rows.push({
        id: 'env-' + item.name,
        key: item.name,
        value: '',
        interpolate: false,
      });
  project.secret.env = serializeEnvDocument(document);
  project.requiredEnvKeys = project.envDefinitions
    .filter((e) => e.required === true)
    .map((e) => e.name);
  refreshEnvState(project);
}
export function refreshEnvState(project) {
  const rows = parseEnvDocument(project.secret.env || '').rows;
  project.envKeys = rows.map((r) => r.key);
  project.filledEnvKeys = rows.filter((r) => r.value.trim()).map((r) => r.key);
  project.requiredEnvKeys = getEnvDefinitions(project)
    .filter((e) => e.required === true)
    .map((e) => e.name);
  project.missingEnvKeys = project.requiredEnvKeys.filter(
    (name) => !project.filledEnvKeys.includes(name),
  );
}
/** Empty optional fields mean "unset", allowing the application's own defaults to apply. */
export function deploymentEnv(project) {
  const optional = new Set(
    getEnvDefinitions(project)
      .filter((e) => e.required === false)
      .map((e) => e.name),
  );
  const document = parseEnvDocument(project.secret.env || '');
  document.rows = document.rows.filter(
    (row) => !optional.has(row.key) || row.value.trim(),
  );
  return serializeEnvDocument(document);
}
/** Conservative extraction: examples alone do not prove a variable is required. */
export function inferEnvDefinitions(files, envNames = [], composeFile = '') {
  const uses = new Map(envNames.map((name) => [name, []]));
  for (const [path, text] of Object.entries(files)) {
    if (
      composeFile
        ? path !== composeFile
        : !/(^|\/)(?:docker-)?compose[^/]*\.ya?ml$/i.test(path)
    )
      continue;
    for (const line of String(text).split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      for (const match of line
        .replaceAll('$$', '')
        .matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+])?([^{}]*)\}/g)) {
        const [, name, operator, value] = match;
        const list = uses.get(name) || [];
        list.push({
          required: operator?.endsWith('?')
            ? true
            : operator?.endsWith('-') || operator?.endsWith('+')
              ? false
              : null,
          ...(operator?.endsWith('-') ? { defaultValue: value } : {}),
        });
        uses.set(name, list);
      }
    }
  }
  return normalizeEnvDefinitions(
    [...uses].map(([name, list]) => {
      const required = list.some((e) => e.required === true)
        ? true
        : list.length && list.every((e) => e.required === false)
          ? false
          : null;
      const defaults = new Set(list.map((e) => e.defaultValue));
      return {
        name,
        required,
        description:
          required === true
            ? 'Обязательна в конфигурации запуска'
            : required === false
              ? 'Можно не заполнять: конфигурация поддерживает запуск без этой переменной'
              : 'Нужно уточнить по документации или при анализе проекта',
        ...(defaults.size === 1 && list.length
          ? { defaultValue: list[0].defaultValue }
          : {}),
      };
    }),
  );
}
