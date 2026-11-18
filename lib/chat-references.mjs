export const maxChatMentions = 8;

export const sshActions = {
  start: 'Запустить',
  stop: 'Остановить',
  restart: 'Перезапустить',
};

export function isSshMachine(machine) {
  return (
    !!machine &&
    (!machine.transport || machine.transport === 'ssh') &&
    /^SHA256:[A-Za-z0-9+/]{43}$/.test(machine.fingerprint || '')
  );
}

/** @param {{ kind: string, id: string }} reference */
export const chatReferenceKey = ({ kind, id }) => `${kind}:${id}`;

/** @param {string} name */
export function mentionText(name) {
  return /^[\p{L}\p{N}_-]+$/u.test(name)
    ? '@' + name
    : '@' + JSON.stringify(name);
}

/**
 * @param {string} text
 * @param {number} cursor
 * @param {{ start: number, end: number }[]} mentions
 */
export function mentionQuery(text, cursor, mentions) {
  if (mentions.some(({ start, end }) => start < cursor && cursor <= end))
    return null;
  const fragment = /(?:^|[\s([{«])@([\p{L}\p{N}_.-]*)$/u.exec(
    text.slice(0, cursor),
  );
  if (!fragment) return null;
  const after = /^[\p{L}\p{N}_.-]*/u.exec(text.slice(cursor))[0];
  return {
    start: cursor - fragment[1].length - 1,
    end: cursor + after.length,
    query: fragment[1].toLowerCase(),
  };
}

const header = '[[MAYPLANE_CHAT_TARGETS]]\n';
const boundary = '\n[[/MAYPLANE_CHAT_TARGETS]]\n';

export function chatTargetsInput(context, task) {
  return header + JSON.stringify(context) + boundary + task;
}

export function visibleChatMentions(mentions) {
  if (!Array.isArray(mentions)) return [];
  return mentions.slice(0, maxChatMentions).flatMap((value) => {
    if (
      !['machine', 'service', 'project'].includes(value?.kind) ||
      typeof value.id !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.text !== 'string'
    )
      return [];
    const { kind, id, name, text, machineName, start, end } = value;
    return [
      {
        kind,
        id,
        name: name.slice(0, 120),
        text: text.slice(0, 512),
        ...(typeof machineName === 'string'
          ? { machineName: machineName.slice(0, 120) }
          : {}),
        ...(Number.isInteger(start) && start >= 0 && end === start + text.length
          ? { start, end }
          : {}),
      },
    ];
  });
}

/**
 * @template {{ text: string, start?: number, end?: number }} T
 * @param {string} text
 * @param {T[]} mentions
 * @returns {(T & { start: number, end: number })[]}
 */
export function inlineMentionRanges(text, mentions) {
  let offset = 0;
  const legacyPositions = new Map();
  return mentions.flatMap((mention) => {
    const token = mention.text;
    if (!token.startsWith('@')) return [];
    let { start, end } = mention;
    if (start === undefined && end === undefined) {
      // Old messages used an ordered list of mentions without their positions.
      if (!legacyPositions.has(token)) {
        const matches = [];
        for (
          let at = text.indexOf(token);
          at >= 0;
          at = text.indexOf(token, at + token.length)
        ) {
          if (at && !/[\s([{«]/u.test(text[at - 1])) continue;
          if (/[\p{L}\p{N}_-]/u.test(text[at + token.length] || '')) continue;
          matches.push(at);
        }
        legacyPositions.set(
          token,
          matches.length ===
            mentions.filter((entry) => entry.text === token).length
            ? matches
            : [],
        );
      }
      start = legacyPositions.get(token).shift();
      end = start === undefined ? undefined : start + token.length;
    }
    if (
      start === undefined ||
      end === undefined ||
      start < offset ||
      end !== start + token.length ||
      text.slice(start, end) !== token
    )
      return [];
    offset = end;
    return [{ ...mention, start, end }];
  });
}

export function unwrapChatTargetsInput(text) {
  if (!text.startsWith(header)) return null;
  const end = text.indexOf(boundary, header.length);
  if (end < 0) return null;
  try {
    const { mentions } = JSON.parse(text.slice(header.length, end));
    const visible = visibleChatMentions(mentions);
    return {
      content: text.slice(end + boundary.length),
      ...(visible.length ? { mentions: visible } : {}),
    };
  } catch {
    return null;
  }
}
