import type { AgentEdit, Patch } from './workspace-files';

export const codeLineLimit = 4000;
export function textLines(text: string) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type Row = {
  text: string;
  kind: 'add' | 'delete' | 'context' | 'meta';
  old?: number;
  new?: number;
};

export function unifiedRows(text: string): Row[] {
  let old = 0,
    next = 0,
    hunk = false;
  return textLines(text)
    .slice(0, codeLineLimit + 1)
    .map((line) => {
      const range = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (range) {
        old = Number(range[1]);
        next = Number(range[2]);
        hunk = true;
        return { kind: 'meta', text: line };
      }
      if (line.startsWith('diff --git ') || line.startsWith('@@@'))
        hunk = false;
      if (hunk && line.startsWith('+'))
        return { kind: 'add', text: line.slice(1), new: next++ };
      if (hunk && line.startsWith('-'))
        return { kind: 'delete', text: line.slice(1), old: old++ };
      if (hunk && line.startsWith(' '))
        return {
          kind: 'context',
          text: line.slice(1),
          old: old++,
          new: next++,
        };
      return { kind: 'meta', text: line };
    });
}

export function wholeFileRows(text: string, kind: 'add' | 'delete'): Row[] {
  return textLines(text)
    .slice(0, codeLineLimit + 1)
    .map((line, i) => ({
      kind,
      text: line,
      ...(kind === 'add' ? { new: i + 1 } : { old: i + 1 }),
    }));
}

export function beforeAfterRows(before: string, after: string): Row[] {
  const a = textLines(before),
    b = textLines(after);
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const rows: Row[] = [];
  if (a.length === prefix && b.length === prefix) return rows;
  for (let i = Math.max(0, prefix - 3); i < prefix; i++)
    rows.push({ kind: 'context', text: a[i], old: i + 1, new: i + 1 });
  const m = a.length - prefix - suffix,
    n = b.length - prefix - suffix;
  // Bound the comparison cost for large rewrites. The removed/added lines still appear.
  const cells =
    (m + 1) * (n + 1) <= 300000 ? new Uint32Array((m + 1) * (n + 1)) : null;
  const at = (i: number, j: number) => i * (n + 1) + j;
  if (cells)
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--) {
        cells[at(i, j)] =
          a[prefix + i] === b[prefix + j]
            ? 1 + cells[at(i + 1, j + 1)]
            : Math.max(cells[at(i + 1, j)], cells[at(i, j + 1)]);
      }
  let i = 0,
    j = 0;
  while ((i < m || j < n) && rows.length <= codeLineLimit) {
    if (i < m && j < n && a[prefix + i] === b[prefix + j]) {
      rows.push({
        kind: 'context',
        text: a[prefix + i],
        old: prefix + ++i,
        new: prefix + ++j,
      });
    } else if (
      i < m &&
      (j === n || !cells || cells[at(i + 1, j)] >= cells[at(i, j + 1)])
    ) {
      rows.push({ kind: 'delete', text: a[prefix + i], old: prefix + ++i });
    } else rows.push({ kind: 'add', text: b[prefix + j], new: prefix + ++j });
  }
  if (rows.length <= codeLineLimit)
    for (let k = 0; k < Math.min(suffix, 3); k++) {
      rows.push({
        kind: 'context',
        text: a[a.length - suffix + k],
        old: a.length - suffix + k + 1,
        new: b.length - suffix + k + 1,
      });
    }
  return rows;
}

function diffPath(field: string) {
  let path = field.split('\t')[0];
  if (path.startsWith('"') && path.endsWith('"')) {
    // Git quotes non-ASCII names as octal UTF-8 bytes.
    const bytes: number[] = [];
    const escapes: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      b: '\b',
      a: '\x07',
      f: '\f',
      v: '\v',
    };
    for (const piece of path.slice(1, -1).match(/\\[0-7]{3}|\\.|[^\\]+/g) ||
      []) {
      if (/^\\[0-7]{3}$/.test(piece)) bytes.push(parseInt(piece.slice(1), 8));
      else
        bytes.push(
          ...new TextEncoder().encode(
            piece.startsWith('\\') ? (escapes[piece[1]] ?? piece[1]) : piece,
          ),
        );
    }
    path = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return path;
}

export function patchFiles(patch: Patch): AgentEdit[] {
  const sections = patch.text.split(/(?<=\n)(?=diff --git )/).filter(Boolean);
  return sections.map((text, index) => {
    const lines = textLines(text);
    const headerEnd = lines.findIndex((line) => line.startsWith('@@'));
    const header = headerEnd < 0 ? lines : lines.slice(0, headerEnd);
    const read = (prefix: string) =>
      header.find((line) => line.startsWith(prefix))?.slice(prefix.length) ||
      '';
    const old = read('--- '),
      next = read('+++ ');
    const move = read('rename to '),
      source = read('rename from ');
    const fallback =
      read('diff --git ').match(/(?:^|\s)("b\/(?:[^"\\]|\\.)*"|b\/.*)$/)?.[1] ||
      '';
    const raw =
      next && next !== '/dev/null'
        ? next
        : old && old !== '/dev/null'
          ? old
          : fallback;
    const path = move
      ? diffPath(move)
      : raw
        ? diffPath(raw).replace(/^[ab]\//, '')
        : 'Патч';
    return {
      id: String(index),
      path,
      ...(source ? { move: diffPath(source) } : {}),
      kind:
        old === '/dev/null' || !!read('new file mode ')
          ? 'add'
          : next === '/dev/null' || !!read('deleted file mode ')
            ? 'delete'
            : 'update',
      patch: {
        text,
        truncated: patch.truncated && index === sections.length - 1,
      },
    };
  });
}
