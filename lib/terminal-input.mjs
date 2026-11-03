/** @param {string} data */
export function terminalInputChunks(data) {
  const chunks = [];
  for (let index = 0; index < data.length;) {
    let end = Math.min(index + 2048, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
    chunks.push(data.slice(index, end));
    index = end;
  }
  return chunks;
}

/**
 * Return false to suppress xterm's default handler AND the browser's native
 * paste. The text must travel through term.paste exactly once so xterm applies
 * the remote application's current bracketed-paste mode.
 * @param {KeyboardEvent} event
 * @param {{hasSelection:()=>boolean,copy:()=>void,paste:()=>void,interrupt:()=>void}} actions
 */
export function terminalClipboardKey(event, actions) {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return true;
  const key = event.key.toLowerCase();
  if (key !== 'c' && key !== 'v') return true;
  event.preventDefault();
  event.stopPropagation();
  if (event.type === 'keydown') {
    if (key === 'v') actions.paste();
    else if (actions.hasSelection() || event.shiftKey) actions.copy();
    else actions.interrupt();
  }
  return false;
}
