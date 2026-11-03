import { randomUUID } from 'node:crypto';
import { assert } from './security.mjs';
import { migrationLocked } from './migration.mjs';

export function deleteProjectCard(store, id, confirm) {
  assert(confirm === true, 'Подтвердите удаление карточки из панели');
  const project = store.get('projects', id);
  assert(project, 'Проект не найден', 404);
  assert(
    !migrationLocked(project),
    'Сначала завершите восстановление переноса проекта',
    409,
  );
  assert(
    !store
      .list('projects')
      .some(
        (p) =>
          migrationLocked(p) &&
          [p.migration.sourceId, p.migration.targetId].includes(
            project.serverId,
          ),
      ),
    'На сервере есть незавершённый перенос',
    409,
  );
  // Query the full journal, including operations outside the latest-100 UI window.
  const active = store.db
    .prepare(
      `SELECT 1 FROM jobs WHERE json_extract(data,'$.status') IN ('pending','deploying') AND (json_extract(data,'$.projectId') = ? OR json_extract(data,'$.serverId') = ? OR json_extract(data,'$.target') = ?) LIMIT 1`,
    )
    .get(id, project.serverId, project.serverId);
  assert(!active, 'Дождитесь завершения операций проекта и сервера', 409);
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    type: 'project-forget',
    projectId: id,
    serverId: project.serverId,
    projectName: project.name,
    status: 'success',
    createdAt: now,
    finishedAt: now,
    source: 'owner',
    logs: [
      'Карточка проекта удалена из панели. Приложение, файлы и данные на сервере сохранены. Подключение SSH не выполнялось.',
    ],
  };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.save('jobs', job);
    store.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return { removedId: id, job };
}
