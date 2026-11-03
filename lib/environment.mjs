/** @typedef {{ id: string, key: string, value: string, interpolate: boolean, line?: number }} EnvRow */
/** @typedef {{ source: string, rows: EnvRow[] }} EnvDocument */

function check(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { status: 400 });
}

/** Parse the supported, single-line Compose .env syntax without resolving references. */
export function parseEnvDocument(text) {
  check(
    typeof text === 'string' && new TextEncoder().encode(text).length < 65536,
    'Файл .env должен быть меньше 64 КБ',
  );
  check(!text.includes('\0'), 'Переменные не должны содержать нулевой символ');
  /** @type {EnvRow[]} */
  const rows = [];
  const seen = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    check(
      match,
      'Некорректная строка .env: ' +
        (index + 1) +
        '. Используйте KEY=value, без многострочных значений.',
    );
    const key = match[1];
    check(!seen.has(key), 'Повторяющаяся переменная: ' + key);
    seen.add(key);
    const raw = match[2].trim();
    const quote = raw[0];
    let value = '',
      interpolate = false;
    if (quote === '"' || quote === "'") {
      let closed = false;
      for (let i = 1; i < raw.length; i++) {
        const char = raw[i];
        if (char === quote) {
          check(
            /^\s*(?:#.*)?$/.test(raw.slice(i + 1)),
            'Лишний текст после кавычек в строке ' + (index + 1),
          );
          closed = true;
          break;
        }
        if (char === '\\' && i + 1 < raw.length) {
          const next = raw[++i];
          if (next === quote) value += next;
          else if (quote === '"') {
            const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', $: '$$' };
            value += Object.hasOwn(escapes, next) ? escapes[next] : '\\' + next;
          } else value += '\\' + next;
        } else value += char;
      }
      check(closed, 'Незакрытые кавычки в строке ' + (index + 1));
    } else
      value = raw.startsWith('#') ? '' : raw.replace(/\s+#.*$/, '').trimEnd();
    if (quote !== "'") {
      const literal = value.replace(/\$\$|\$\{|\$[A-Za-z_]/g, (token) => {
        if (token === '$$') return '$';
        interpolate = true;
        return token;
      });
      // Mixed literal dollars and references need their escapes when the expression is edited.
      if (!interpolate) value = literal;
    }
    rows.push({ id: 'line-' + index, key, value, interpolate, line: index });
  }
  return { source: text, rows };
}

/** Quote field values literally by default, including dollar signs, hashes and whitespace. */
function encodeValue(row) {
  let value = row.value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  if (!row.interpolate) value = value.replace(/\$/g, () => '$$');
  return '"' + value + '"';
}

/** Preserve untouched lines, comments and interpolation when editing other fields. */
export function serializeEnvDocument(document) {
  const original = parseEnvDocument(document.source);
  const originals = new Map(original.rows.map((row) => [row.line, row]));
  const lines = document.source.split(/(?<=\n)/);
  const replacements = new Map();
  const added = [];
  const seen = new Set();
  for (const row of document.rows) {
    if (!row.key && !row.value && row.line === undefined) continue;
    check(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key),
      'Имя переменной: латинские буквы, цифры и _, первый символ — буква или _.',
    );
    check(!seen.has(row.key), 'Повторяющаяся переменная: ' + row.key);
    seen.add(row.key);
    const previous = originals.get(row.line);
    const ending =
      row.line === undefined
        ? '\n'
        : lines[row.line]?.match(/\r?\n$/)?.[0] || '';
    let line;
    if (
      previous &&
      previous.value === row.value &&
      previous.interpolate === row.interpolate
    ) {
      line = lines[row.line].replace(
        /^(\s*(?:export\s+)?)[A-Za-z_][A-Za-z0-9_]*/,
        (_, prefix) => prefix + row.key,
      );
    } else line = row.key + '=' + encodeValue(row) + ending;
    if (previous) replacements.set(row.line, line);
    else added.push(line);
  }
  let result = lines
    .map((line, index) =>
      originals.has(index) ? replacements.get(index) || '' : line,
    )
    .join('');
  if (added.length)
    result += (result && !result.endsWith('\n') ? '\n' : '') + added.join('');
  parseEnvDocument(result);
  return result;
}
