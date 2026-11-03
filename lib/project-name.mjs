// Shared by the HTML form (Unicode v) and server validation (Unicode u).
export const projectNamePattern = '[\\p{L}\\p{N}][\\p{L}\\p{N} ._\\-]{0,79}';
export const projectNameHint =
  '1–80 символов: буквы, цифры, пробел, точка, дефис и подчёркивание. Имя может повторяться.';
export const isProjectName = (value) =>
  typeof value === 'string' &&
  new RegExp('^(?:' + projectNamePattern + ')$', 'u').test(value.trim());
