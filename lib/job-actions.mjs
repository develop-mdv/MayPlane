export const cancellableJobs = [
  'deploy',
  'build',
  'auto-deploy',
  'apply-plan',
  'restart',
  'chat',
  'analyze',
];

export function jobStatus(job) {
  if (['pending', 'deploying'].includes(job.status))
    return {
      label: job.cancelRequested
        ? 'Прерывается'
        : job.status === 'pending'
          ? 'В очереди'
          : 'Выполняется',
      active: true,
    };
  if (job.outcome === 'cancelled') return { label: 'Прервано', active: false };
  if (
    job.status === 'needs_setup' ||
    ['limit', 'needs_input'].includes(job.outcome)
  )
    return { label: 'Завершено · нужно продолжение', active: false };
  return {
    label: job.status === 'success' ? 'Завершено' : 'Завершено с ошибкой',
    active: false,
  };
}
