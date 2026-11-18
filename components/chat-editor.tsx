'use client';

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type Ref,
} from 'react';
import type { ChatMention } from '@/lib/hub';
import { mentionTitle } from './chat-mentions';

export type DraftMention = ChatMention & { start: number; end: number };
type Selection = { start: number; end: number };
type Draft = { text: string; mentions: DraftMention[] };

export type ChatEditorHandle = {
  focus: () => void;
  getSelection: () => Selection | null;
  replace: (
    start: number,
    end: number,
    text: string,
    mention?: ChatMention,
  ) => void;
};

function mentionElement(doc: Document, mention: ChatMention) {
  const element = doc.createElement('span');
  const { kind, id, name, machineName, text } = mention;
  element.dataset.chatMention = JSON.stringify({
    kind,
    id,
    name,
    machineName,
    text,
  });
  element.contentEditable = 'false';
  element.className = 'chat-mention-tag';
  element.title = mentionTitle(mention);
  const label = doc.createElement('span');
  label.textContent = '@' + name;
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.tabIndex = -1;
  remove.dataset.removeMention = '';
  remove.setAttribute('aria-label', 'Убрать упоминание ' + name);
  element.append(label, remove);
  return element;
}

// The browser edits the DOM. Project its text and non-editable mentions to the
// same offsets used by the message API, including the browser's line breaks.
function readDraft(root: HTMLElement) {
  let text = '';
  const mentions: DraftMention[] = [];
  const positions = new Map<Node, number | number[]>();

  function readChildren(parent: Node) {
    const offsets = [];
    let previousBlock = false;
    for (const [index, node] of Array.from(parent.childNodes).entries()) {
      const block = node.nodeName === 'DIV' || node.nodeName === 'P';
      if (
        index &&
        (block || previousBlock) &&
        node.previousSibling?.nodeName !== 'BR'
      )
        text += '\n';
      previousBlock = block;
      offsets.push(text.length);
      if (node.nodeType === Node.TEXT_NODE) {
        positions.set(node, text.length);
        text += node.textContent ?? '';
      } else if (node instanceof HTMLElement && node.dataset.chatMention) {
        const mention = JSON.parse(node.dataset.chatMention) as ChatMention;
        const start = text.length;
        text += mention.text;
        mentions.push({ ...mention, start, end: text.length });
        positions.set(node, [start, text.length]);
      } else if (node.nodeName === 'BR') {
        // A final BR keeps an empty line editable. The preceding BR, if any, is text.
        if (node.nextSibling) text += '\n';
      } else readChildren(node);
    }
    positions.set(parent, [...offsets, text.length]);
  }

  readChildren(root);
  function offsetAt(node: Node, offset: number) {
    const value = positions.get(node);
    if (typeof value === 'number') return value + offset;
    if (value) return value[Math.min(value.length - 1, offset)];
    const mention = node.parentElement?.closest('[data-chat-mention]');
    const bounds = mention && positions.get(mention);
    return Array.isArray(bounds) ? bounds[offset ? 1 : 0] : undefined;
  }

  function pointAt(offset: number): [Node, number] {
    for (const [node, start] of positions) {
      if (
        typeof start === 'number' &&
        offset >= start &&
        offset <= start + (node.textContent?.length ?? 0)
      )
        return [node, offset - start];
    }
    for (const [node, offsets] of positions) {
      if (
        !Array.isArray(offsets) ||
        (node instanceof HTMLElement && node.dataset.chatMention)
      )
        continue;
      const index = offsets.indexOf(offset);
      if (index >= 0) return [node, index];
    }
    return [root, root.childNodes.length];
  }

  return { text, mentions, offsetAt, pointAt, positions };
}

function readSelection(
  root: HTMLElement,
  draft = readDraft(root),
): Selection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const start = draft.offsetAt(range.startContainer, range.startOffset);
  const end = draft.offsetAt(range.endContainer, range.endOffset);
  return start === undefined || end === undefined ? null : { start, end };
}

function select(
  root: HTMLElement,
  draft: ReturnType<typeof readDraft>,
  start: number,
  end = start,
) {
  const range = root.ownerDocument.createRange();
  range.setStart(...draft.pointAt(start));
  range.setEnd(...draft.pointAt(end));
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function displayDraft(root: HTMLElement, draft: Draft) {
  const doc = root.ownerDocument;
  const selection = doc.activeElement === root ? readSelection(root) : null;
  const nodes = doc.createDocumentFragment();
  let at = 0;
  for (const mention of draft.mentions) {
    nodes.append(
      draft.text.slice(at, mention.start),
      mentionElement(doc, mention),
    );
    at = mention.end;
  }
  nodes.append(draft.text.slice(at));
  root.replaceChildren(nodes);
  if (selection)
    select(
      root,
      readDraft(root),
      Math.min(draft.text.length, selection.start),
      Math.min(draft.text.length, selection.end),
    );
}

export function ChatEditor({
  ref,
  text,
  mentions,
  maxLength,
  disabled,
  placeholder,
  controls,
  activeDescendant,
  onChange,
  onCaret,
  onFocus,
  onBlur,
  onKeyDown,
}: Draft & {
  ref: Ref<ChatEditorHandle>;
  maxLength: number;
  disabled: boolean;
  placeholder: string;
  controls?: string;
  activeDescendant?: string;
  onChange: (draft: Draft) => void;
  onCaret: (offset: number | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const lastSelection = useRef<Selection | null>(null);
  const composing = useRef(false);

  useLayoutEffect(() => {
    const root = editor.current!;
    const live = readDraft(root);
    if (
      live.text !== text ||
      live.mentions.length !== mentions.length ||
      mentions.some((mention, index) => {
        const current = live.mentions[index];
        return (
          current.start !== mention.start ||
          current.end !== mention.end ||
          current.id !== mention.id ||
          current.kind !== mention.kind
        );
      })
    )
      displayDraft(root, { text, mentions });
  }, [text, mentions]);

  useEffect(() => {
    const root = editor.current!;
    const doc = root.ownerDocument;
    const report = () => {
      if (doc.activeElement !== root) return;
      const selection = readSelection(root);
      if (selection) lastSelection.current = selection;
      onCaret(
        selection && selection.start === selection.end ? selection.start : null,
      );
    };
    doc.addEventListener('selectionchange', report);
    return () => doc.removeEventListener('selectionchange', report);
  }, [onCaret]);

  function commit(root: HTMLElement) {
    const live = readDraft(root);
    if (live.text.length > maxLength) {
      displayDraft(root, { text, mentions });
      return;
    }
    const selection = readSelection(root, live);
    if (selection) lastSelection.current = selection;
    onCaret(
      selection && selection.start === selection.end ? selection.start : null,
    );
    onChange({ text: live.text, mentions: live.mentions });
  }

  function replace(
    from: number,
    to: number,
    value: string,
    mention?: ChatMention,
  ) {
    const root = editor.current;
    if (!root || disabled) return;
    const doc = root.ownerDocument;
    const live = readDraft(root);
    const start = Math.min(from, live.text.length);
    const end = Math.min(to, live.text.length);
    const room = Math.max(0, maxLength - live.text.length + end - start);
    if (mention && room < mention.text.length + value.length) return;
    const insert = value.slice(0, room);
    if (!insert && !mention && start === end) return;
    root.focus();
    const range = select(root, live, start, end);
    const chip = mention && mentionElement(doc, mention);
    const suffix = doc.createElement('span');
    suffix.textContent = insert;
    const command = chip ? 'insertHTML' : insert ? 'insertText' : 'delete';
    const payload = chip ? chip.outerHTML + suffix.innerHTML : insert;
    const before = root.innerHTML;
    // Native editing keeps undo history. Only DOM-built elements enter insertHTML.
    // oxlint-disable-next-line typescript/no-deprecated
    const applied = doc.execCommand?.(command, false, payload);
    if (!applied && root.innerHTML === before) {
      range.deleteContents();
      const nodes = doc.createDocumentFragment();
      if (chip) nodes.append(chip);
      nodes.append(insert);
      range.insertNode(nodes);
    }
    // Some browsers leave the caret before a non-editable node after insertion.
    select(root, readDraft(root), start + (mention?.text.length ?? 0) + insert.length);
    commit(root);
  }

  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    getSelection: () =>
      editor.current &&
      (readSelection(editor.current) || lastSelection.current),
    replace,
  }));

  // A textarea cannot contain selectable, atomic mention elements.
  /* oxlint-disable jsx-a11y/prefer-tag-over-role */
  return (
    <div
      ref={editor}
      className="chat-editor"
      role="textbox"
      aria-label="Сообщение агенту"
      aria-multiline="true"
      aria-placeholder={placeholder}
      aria-autocomplete="list"
      aria-controls={controls}
      aria-activedescendant={activeDescendant}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      contentEditable={!disabled}
      data-placeholder={placeholder}
      data-empty={!text || undefined}
      onFocus={onFocus}
      onBlur={onBlur}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        commit(event.currentTarget);
      }}
      onInput={(event) => {
        if (!composing.current) commit(event.currentTarget);
      }}
      onPaste={(event) => {
        event.preventDefault();
        const selection = readSelection(event.currentTarget);
        const text = event.clipboardData.getData('text/plain');
        if (selection && text)
          replace(
            selection.start,
            selection.end,
            text.replace(/\r\n?/g, '\n'),
          );
      }}
      onDrop={(event) => event.preventDefault()}
      onMouseDown={(event) => {
        if ((event.target as Element).closest('[data-remove-mention]'))
          event.preventDefault();
      }}
      onClick={(event) => {
        const button = (event.target as Element).closest(
          '[data-remove-mention]',
        );
        if (disabled || !button?.parentNode) return;
        const bounds = readDraft(event.currentTarget).positions.get(
          button.parentNode,
        );
        if (Array.isArray(bounds)) replace(bounds[0], bounds[1], '');
      }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing) return;
        onKeyDown(event);
        if (
          (event.ctrlKey || event.metaKey) &&
          ['b', 'i', 'u'].includes(event.key.toLowerCase())
        )
          event.preventDefault();
        if (
          event.defaultPrevented ||
          !['Backspace', 'Delete'].includes(event.key)
        )
          return;
        const live = readDraft(event.currentTarget);
        const selection = readSelection(event.currentTarget, live);
        if (!selection || selection.start !== selection.end) return;
        const adjacent = live.mentions.find(
          (mention) =>
            mention[event.key === 'Backspace' ? 'end' : 'start'] ===
            selection.start,
        );
        if (adjacent) {
          event.preventDefault();
          replace(adjacent.start, adjacent.end, '');
        }
      }}
    />
  );
  /* oxlint-enable jsx-a11y/prefer-tag-over-role */
}
