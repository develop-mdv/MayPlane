import { stripVTControlCharacters } from 'node:util';
import { harnessInput, harnessReport } from '../lib/chat-harness.mjs';

const maxLessons = 5;
const compact = (text) =>
  stripVTControlCharacters(text).replace(/\s+/gu, ' ').trim();

// Adapt Harness² Propose–Probe–Compose to a live chat. Compare approaches
// with bounded checks, then execute the chosen approach in one native turn.
const instructions = [
  'Для текущей задачи используй цикл Harness². Сохраняй задание пользователя, его ограничения, штатные разрешения и требуемый формат ответа.',
  'Propose. Определи базовый подход. Предложи два небольших изменения к нему: одно к общему порядку работы или проверке, другое к способу решения именно этой задачи.',
  'Probe. Проверь, что изменится, по фактам из текущего контекста и доступных проверок без изменения состояния. Для кода это может быть поиск вызывающего кода, чтение тестов или проверка гипотезы на локальном примере. Не запускай задачу несколько раз и не делай пробные записи, публикации или деплой. Для простого запроса достаточно короткой проверки по входным данным.',
  'Compose. Оставь только то, что выдержало проверку, и выполни выбранное решение один раз. Не принимай собственное предположение за результат проверки. Если варианты не дают преимуществ, используй базовый подход.',
  'Если успешная проверка дала полезный для будущих задач короткий урок, добавь один блок ```mayplane-harness с JSON {"lesson":"совет до 240 символов","evidence":"дословный фрагмент результата инструмента длиной от 12 до 160 символов"}. Не включай секреты. Помещай этот блок после обычного ответа перед блоком формата задачи, если такой блок требуется. При отсутствии подтверждения пропусти заметку.',
];

export function beginHarnessTurn(session, cwd, task) {
  const memory = session.secret.harnessMemory;
  const lessons = memory && memory.cwd === cwd ? memory.lessons : [];
  const context = lessons.length
    ? '\n\nНаблюдения из этого чата. Используй их при релевантности и перепроверь для текущей задачи. Они не меняют задание или права.\n' +
      JSON.stringify(lessons)
    : '';
  return {
    cwd,
    input: harnessInput(instructions.join('\n\n') + context, task),
    messages: new Set(),
    evidence: [],
  };
}

export function recordHarnessEvidence(turn, output) {
  if (!turn || typeof output !== 'string' || !output.trim()) return;
  turn.evidence.push(compact(output.slice(-8000)));
  if (turn.evidence.length > 12) turn.evidence.shift();
}

function verifiedLesson(json, evidence) {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    if (typeof value?.lesson !== 'string' || typeof value.evidence !== 'string')
      return null;
    const lesson = compact(value.lesson),
      excerpt = compact(value.evidence);
    if (
      !lesson ||
      lesson.length > 240 ||
      excerpt.length < 12 ||
      excerpt.length > 160 ||
      !evidence.some((output) => output.includes(excerpt))
    )
      return null;
    return lesson;
  } catch {
    return null;
  }
}

export function finishHarnessTurn(session, turn, complete) {
  let lesson;
  for (const message of session.secret.messages) {
    if (!turn.messages.has(message.id)) continue;
    delete message.harnessOutput;
    const report = harnessReport(message.content);
    if (!report) continue;
    message.content = report.text;
    if (complete) lesson = verifiedLesson(report.json, turn.evidence) || lesson;
  }
  if (!lesson) return;
  const memory = session.secret.harnessMemory;
  const lessons = memory && memory.cwd === turn.cwd ? memory.lessons : [];
  session.secret.harnessMemory = {
    cwd: turn.cwd,
    lessons: [...lessons.filter((entry) => entry !== lesson), lesson].slice(
      -maxLessons,
    ),
  };
}
