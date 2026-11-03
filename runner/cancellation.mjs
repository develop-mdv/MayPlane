import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage();
export const currentOperation = () => context.getStore();
export const operationSignal = () => currentOperation()?.controller.signal;
export function cancellationError(unconfirmed = false) {
  const error = new Error(
    unconfirmed
      ? 'Не удалось подтвердить остановку SSH-команды. Проверьте сервер.'
      : 'Операция прервана пользователем.',
  );
  error.code = unconfirmed ? 'JOB_CANCEL_UNCONFIRMED' : 'JOB_CANCELLED';
  return error;
}
export function checkCancellation() {
  if (operationSignal()?.aborted)
    throw cancellationError(currentOperation()?.unconfirmed);
}
export const withCancellation = (operation, fn) => context.run(operation, fn);
// Cleanup is bounded and must still remove temporary credentials after cancellation.
export const withoutCancellation = (fn) => context.run(undefined, fn);
export function requestSignal(timeout) {
  checkCancellation();
  const signal = operationSignal();
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
}
