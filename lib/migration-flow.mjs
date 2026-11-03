// Older saved plans asked this as prose. Keep unrelated questions unanswered.
export function isArchiveQuestion(question) {
  const text = String(question);
  return (
    /архивир/i.test(text) &&
    /(?:существ|конфликт|остановлен)/i.test(text) &&
    /(?:контейнер|каталог|ресурс|сеть|том|служб)/i.test(text) &&
    /(?:разрешить|разрешаете|подтверд|варианты)/i.test(text) &&
    !/(?:парол|токен|ключ|DNS|домен|внешн.{0,12}(?:баз|хранилищ))/i.test(text)
  );
}
export function unresolvedMigrationQuestions(questions, resolution, report) {
  return (questions || []).filter(
    (question) =>
      !(
        ((resolution?.selected && resolution.available) ||
          report?.blockers?.length === 0) &&
        isArchiveQuestion(question)
      ),
  );
}

export function pendingMigrations(projects, jobs) {
  const active = (j) => ['pending', 'deploying'].includes(j.status);
  return projects
    .flatMap((project) => {
      const migration = project.migration;
      const completedAt = ['complete', 'awaiting_dns'].includes(
        migration?.phase,
      )
        ? Date.parse(migration.finishedAt || '')
        : 0;
      const draft = [
        project.migrationDraft,
        project.migrationPlan,
        project.savedMigrationPlan,
      ].find(
        (p) =>
          p?.sourceId === project.serverId &&
          (!completedAt ||
            Date.parse(p.updatedAt || p.createdAt || '') > completedAt),
      );
      if (!draft && !migration?.locked) return [];
      const targetId = migration?.locked ? migration.targetId : draft.targetId;
      const job = jobs.find(
        (j) =>
          j.projectId === project.id &&
          j.type.startsWith('migration') &&
          active(j),
      );
      const plan =
        project.migrationPlan?.targetId === targetId &&
        project.migrationPlan.sourceId === project.serverId
          ? project.migrationPlan
          : null;
      const state = migration?.needsRecovery
        ? 'recovery'
        : job
          ? job.type === 'migration'
            ? 'running'
            : 'checking'
          : draft?.choice === 'manual'
            ? 'manual'
            : plan?.blockers?.length
              ? 'decision'
              : plan
                ? 'ready'
                : 'retry';
      const labels = {
        recovery: 'Требуется восстановление',
        manual: 'Ожидает ручной подготовки',
        running: 'Переносим проект',
        checking: 'Проверяем серверы',
        decision: 'Нужно ваше решение',
        ready: 'План готов',
        retry: 'Подготовка не завершена',
      };
      return [
        {
          projectId: project.id,
          sourceId: migration?.locked ? migration.sourceId : project.serverId,
          targetId,
          state,
          label: labels[state],
          jobId:
            job?.id || (migration?.locked ? migration.jobId : draft?.jobId),
          updatedAt: draft?.updatedAt || plan?.createdAt || '',
          mode: draft?.mode || plan?.mode || 'standard',
        },
      ];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
