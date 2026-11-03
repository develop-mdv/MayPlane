import test from 'node:test';
import assert from 'node:assert/strict';
import {
  terminalClipboardKey,
  terminalInputChunks,
} from '../lib/terminal-input.mjs';

test('terminal Ctrl+C copies selection; without selection it remains an interrupt', () => {
  let copied = 0,
    pasted = 0,
    prevented = 0,
    stopped = 0,
    selection = true;
  let interrupted = 0;
  const actions = {
    hasSelection: () => selection,
    copy: () => copied++,
    paste: () => pasted++,
    interrupt: () => interrupted++,
  };
  const event = (type, key, extras = {}) => ({
    type,
    key,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
    ...extras,
  });
  assert.equal(terminalClipboardKey(event('keydown', 'c'), actions), false);
  assert.equal(terminalClipboardKey(event('keyup', 'c'), actions), false);
  assert.equal(copied, 1);
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
  selection = false;
  assert.equal(terminalClipboardKey(event('keydown', 'c'), actions), false);
  assert.equal(interrupted, 1);
  assert.equal(copied, 1);
  assert.equal(terminalClipboardKey(event('keydown', 'v'), actions), false);
  assert.equal(terminalClipboardKey(event('keyup', 'v'), actions), false);
  assert.equal(pasted, 1);
  assert.equal(
    terminalClipboardKey(
      event('keydown', 'V', { ctrlKey: false, metaKey: true, shiftKey: true }),
      actions,
    ),
    false,
  );
  assert.equal(pasted, 2);
  assert.equal(
    terminalClipboardKey(event('keydown', 'v', { altKey: true }), actions),
    true,
  );
});
test('large pasted Unicode text arrives once, preserving surrogate pairs and paste boundaries', () => {
  const text =
    '\x1b[200~' +
    'a'.repeat(2041) +
    '🛠️' +
    'кириллица\r\n'.repeat(2000) +
    '\x1b[201~';
  const chunks = terminalInputChunks(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2048);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
  }
});
