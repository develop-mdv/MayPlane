const header = '[[MAYPLANE_HARNESS2]]\n';
const boundary = '\n[[/MAYPLANE_HARNESS2]]\n';

export function harnessInput(instructions, task) {
  return header + instructions + boundary + task;
}

export function unwrapHarnessInput(text) {
  if (!text.startsWith(header)) return null;
  const end = text.indexOf(boundary, header.length);
  return end < 0 ? null : text.slice(end + boundary.length);
}

export function harnessReport(text) {
  const open = /(?:^|\r?\n)[ \t]*```mayplane-harness[ \t]*(?:\r?\n|$)/i.exec(
    text,
  );
  if (!open) return null;
  const after = text.slice(open.index + open[0].length);
  const close = /\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/.exec(after);
  return {
    text: [
      text.slice(0, open.index).trimEnd(),
      close ? after.slice(close.index + close[0].length).trimStart() : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    json: close && close.index <= 1200 ? after.slice(0, close.index) : null,
  };
}
