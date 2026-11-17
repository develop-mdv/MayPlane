export const serviceChatCommand = '/services';
export const serviceChatDefaultRequest =
  'Посмотри, какие приложения работают на этой машине. Предложи карточки для полезных сервисов и задай вопросы, если нужны уточнения.';

export function splitServiceChatCommand(text) {
  const match = /^\s*\/services(?:(\s)|$)/i.exec(text);
  return match
    ? { content: text.slice(match[0].length), separated: !!match[1] }
    : null;
}

export function suggestsServiceChatCommand(text) {
  const prefix = text.trimStart().toLowerCase();
  return prefix.startsWith('/') && serviceChatCommand.startsWith(prefix);
}

export function attachServiceChatCommand(draft) {
  if (splitServiceChatCommand(draft)?.separated) return draft;
  return serviceChatCommand + ' ' + (suggestsServiceChatCommand(draft) ? '' : draft);
}

export function serviceChatRequest(text) {
  const command = splitServiceChatCommand(text);
  return command ? command.content.trim() || serviceChatDefaultRequest : null;
}

const header = '[[MAYPLANE_SERVICE_CHAT]]\n';
const commandHeader = '[[/services]]\n';
const boundary = '\n[[/MAYPLANE_SERVICE_CHAT]]\n';

export function serviceChatInput(instructions, message, command) {
  return (
    header +
    (command === serviceChatCommand ? commandHeader : '') +
    instructions +
    boundary +
    message
  );
}

export function visibleServiceChatInput(message) {
  if (!message.startsWith(header)) return { content: message };
  const end = message.indexOf(boundary);
  if (end < 0) return { content: message };
  return {
    content: message.slice(end + boundary.length),
    ...(message.startsWith(header + commandHeader)
      ? { command: serviceChatCommand }
      : {}),
  };
}

function isServicePayload(text) {
  if (!text.startsWith('{') || text.length > 60000) return false;
  try {
    const value = JSON.parse(text);
    return Object.keys(value).length === 1 && Array.isArray(value.services);
  } catch {
    return false;
  }
}

export function serviceChatBlock(text) {
  const open = /(?:^|\r?\n)[ \t]*```mayplane-services[ \t]*(?:\r?\n|$)/i.exec(
    text,
  );
  if (!open) {
    const plain = text.trim();
    if (isServicePayload(plain)) return { text: '', json: plain };
    const fenced =
      /(?:^|\r?\n)[ \t]*```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/i.exec(
        text,
      );
    if (fenced && isServicePayload(fenced[1].trim()))
      return { text: text.slice(0, fenced.index).trimEnd(), json: fenced[1] };
    return null;
  }
  const after = text.slice(open.index + open[0].length);
  const close = /\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/.exec(after);
  const before = text.slice(0, open.index).trimEnd();
  if (!close) return { text: before, json: null };
  const rest = after.slice(close.index + close[0].length).trimStart();
  return {
    text: [before, rest].filter(Boolean).join('\n\n'),
    json: after.slice(0, close.index),
  };
}
