const textLimit = 32000;
const turnLimit = 160000;
const historyLimit = 680000;
const validPath = (path) =>
  typeof path === 'string' && path.length > 0 && path.length <= 1024;

const bounded = (text, limit) => ({
  text: text.slice(0, limit),
  truncated: text.length > limit,
});

export function codexFileEdits(item) {
  if (
    item?.type !== 'fileChange' ||
    item.status === 'failed' ||
    item.status === 'declined' ||
    !Array.isArray(item.changes)
  )
    return [];
  return item.changes.slice(0, 48).flatMap((change, index) => {
    if (!validPath(change?.path) || typeof change.diff !== 'string') return [];
    const type = change.kind?.type;
    const move = change.kind?.movePath ?? change.kind?.move_path;
    return [
      {
        id: `${item.id}:${index}`,
        path: change.path,
        ...(validPath(move) ? { move } : {}),
        kind: ['add', 'delete'].includes(type) ? type : 'update',
        patch: bounded(change.diff, textLimit),
      },
    ];
  });
}

export function acpFileEdits(turn, update) {
  const id = update.toolCallId;
  if (typeof id !== 'string' || id.length > 180) return [];
  if (update.status === 'failed') {
    turn.pending.delete(id);
    return [];
  }
  const edits = Array.isArray(update.content)
    ? update.content.slice(0, 48).flatMap((entry, index) => {
        if (
          entry?.type !== 'diff' ||
          !validPath(entry.path) ||
          (typeof entry.oldText !== 'string' &&
            typeof entry.newText !== 'string')
        )
          return [];
        const before =
          typeof entry.oldText === 'string'
            ? bounded(entry.oldText, textLimit)
            : null;
        const after =
          typeof entry.newText === 'string'
            ? bounded(entry.newText, textLimit)
            : null;
        return [
          {
            id: `${id}:${index}`,
            path: entry.path,
            before,
            after,
            kind: !before ? 'add' : !after ? 'delete' : 'update',
          },
        ];
      })
    : [];
  if (update.status === 'completed') {
    const completed = edits.length ? edits : turn.pending.get(id) || [];
    turn.pending.delete(id);
    return completed;
  }
  if (edits.length) {
    turn.pending.set(id, fitEdits(edits).edits);
    if (turn.pending.size > 8)
      turn.pending.delete(turn.pending.keys().next().value);
  }
  return [];
}

function fitEdits(entries) {
  let size = 0;
  const edits = [];
  // Keep the latest edits when a turn produces more data than can be retained.
  for (let i = entries.length - 1; i >= 0; i--) {
    const edit = entries[i];
    size += JSON.stringify(edit).length;
    if (size > turnLimit || edits.length === 48) break;
    edits.push(edit);
  }
  return { edits: edits.reverse(), limited: edits.length !== entries.length };
}

function snapshotIndex(snapshot, key) {
  return {
    files: new Map(snapshot.files.map((file) => [key(file.path), file])),
    directories: new Set(snapshot.directories.map(key)),
    complete: new Set(snapshot.completeDirs.map(key)),
  };
}

function knownAbsent(snapshot, path) {
  // An unscanned subtree may contain the file. Only report absence when we
  // listed the parent, or the listing proves the entire subtree did not exist.
  let parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  while (!snapshot.directories.has(parent) && parent) {
    parent = parent.slice(0, Math.max(0, parent.lastIndexOf('/')));
  }
  return snapshot.complete.has(parent);
}

export function compareWorkspaceSnapshots(before, after) {
  if (!before || !after || typeof before.root !== 'string') return null;
  const windows = /^[a-z]:[\\/]/i.test(before.root);
  const key = (path) => (windows ? path.toLowerCase() : path);
  if (typeof after.root !== 'string' || key(before.root) !== key(after.root))
    return null;
  const left = snapshotIndex(before, key);
  const right = snapshotIndex(after, key);
  const edits = [];
  for (const name of new Set([...left.files.keys(), ...right.files.keys()])) {
    const previous = left.files.get(name);
    const next = right.files.get(name);
    if (!previous && !knownAbsent(left, name)) continue;
    if (!next && !knownAbsent(right, name)) continue;
    const moved = previous && next && previous.path !== next.path;
    if (previous && next && !moved) {
      if (!Number.isFinite(previous.size) || !Number.isFinite(next.size))
        continue;
      const same =
        previous.hash && next.hash
          ? previous.hash === next.hash
          : previous.size === next.size && previous.mtime === next.mtime;
      if (same) continue;
    }
    const path = next?.path ?? previous.path;
    const edit = {
      id: `workspace:${path}`,
      path,
      ...(moved ? { move: previous.path } : {}),
      kind: !previous ? 'add' : !next ? 'delete' : 'update',
    };
    if (
      (!previous || typeof previous.text === 'string') &&
      (!next || typeof next.text === 'string')
    ) {
      const before = previous ? bounded(previous.text, textLimit) : null;
      const after = next ? bounded(next.text, textLimit) : null;
      const withText = { ...edit, before, after };
      if (JSON.stringify(withText).length < turnLimit) {
        edits.push(withText);
        continue;
      }
    }
    edits.push({ ...edit, previewUnavailable: true });
  }
  return { edits, limited: before.limited || after.limited };
}

export function addAgentFileChanges(
  secret,
  turn,
  { aggregate, edits = [], workspace },
) {
  if (
    !turn ||
    (typeof aggregate !== 'string' && !edits.length && !workspace?.edits.length)
  )
    return;
  const items = (secret.fileChanges ??= []);
  const last = items.find((item) => item.id === turn.id);
  const report = last || { id: turn.id, at: turn.at, cwd: turn.cwd, edits: [] };
  if (workspace?.edits.length) {
    const fitted = fitEdits(workspace.edits);
    report.workspaceEdits = fitted.edits;
    report.limited ||= workspace.limited || fitted.limited;
  } else if (typeof aggregate === 'string' && aggregate) {
    report.aggregate = bounded(aggregate, turnLimit);
    report.edits = [];
    report.limited = false;
  } else if (typeof aggregate === 'string') {
    delete report.aggregate;
  } else if (!report.aggregate) {
    const distinct = new Map(report.edits.map((edit) => [edit.id, edit]));
    for (const edit of edits) distinct.set(edit.id, edit);
    const fitted = fitEdits([...distinct.values()]);
    report.edits = fitted.edits;
    report.limited ||= fitted.limited;
  }
  if (!last) items.push(report);
  if (
    !report.aggregate &&
    !report.edits.length &&
    !report.workspaceEdits?.length
  )
    items.splice(items.indexOf(report), 1);
  let size = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    size += JSON.stringify(items[i]).length;
    if (size > historyLimit || items.length - i > 16) {
      items.splice(0, i + 1);
      break;
    }
  }
}

export function agentChangeSummaries(secret) {
  return (secret.fileChanges || [])
    .slice()
    .reverse()
    .map(({ id, at, cwd }) => ({
      id,
      at,
      cwd,
      title: secret.messages
        .find((message) => message.id === id)
        ?.content.slice(0, 100),
    }));
}
