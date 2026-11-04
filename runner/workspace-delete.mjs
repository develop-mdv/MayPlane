import { createHash } from 'node:crypto';
import { assert } from './security.mjs';
import { migrationLocked } from './migration.mjs';

export function removalPlan(store, kind, id, { deleteChats = false } = {}) {
  assert(
    ['chat', 'project', 'service', 'machine'].includes(kind),
    'Неизвестный тип объекта',
  );
  const settings = store.list('settings'),
    allChats = settings.filter((s) => s.recordType === 'session');
  const item = store.get(
    kind === 'machine'
      ? 'servers'
      : kind === 'service'
        ? 'projects'
        : 'settings',
    id,
  );
  assert(
    item &&
      (kind !== 'chat' || item.recordType === 'session') &&
      (kind !== 'project' || item.recordType === 'workspace'),
    'Объект уже удалён или не найден',
    404,
  );
  const projects =
    kind === 'project'
      ? [item]
      : kind === 'machine'
        ? settings.filter(
            (p) => p.recordType === 'workspace' && p.machineId === id,
          )
        : [];
  const chats =
    kind === 'chat'
      ? [item]
      : kind === 'machine'
        ? allChats.filter((s) => s.machineId === id)
        : kind === 'project'
          ? allChats.filter((s) => s.projectId === id)
          : [];
  const services =
    kind === 'service'
      ? [item]
      : kind === 'machine'
        ? store.list('projects').filter((s) => s.serverId === id)
        : [];
  const context = settings.filter(
    (s) =>
      s.recordType === 'service_context' &&
      ((kind === 'machine' && s.machineId === id) ||
        services.some((p) => p.id === s.legacyProjectId)),
  );
  const targets = settings.filter(
    (s) =>
      s.recordType === 'account_target' &&
      (kind === 'machine'
        ? s.machineId === id
        : chats.some(
            (c) => c.profileId === s.profileId && c.machineId === s.machineId,
          )),
  );
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        kind,
        id,
        name: item.name || item.secret?.title,
        projects: projects.map((p) => [p.id, p.path]),
        chats: chats.map((s) => [s.id, s.projectId, s.updatedAt]),
        services: services.map((s) => s.id),
        targets: targets.map((s) => s.id),
      }),
    )
    .digest('hex');
  return {
    kind,
    id,
    name: item.name || item.secret?.title || item.title || 'Чат',
    revision,
    projects,
    chats,
    services,
    context,
    targets,
    deleteChats,
  };
}
export function removalPreview(plan) {
  return {
    kind: plan.kind,
    id: plan.id,
    name: plan.name,
    revision: plan.revision,
    projects: plan.projects.length,
    chats: plan.chats.length,
    services: plan.services.length,
    pendingCredentials: plan.targets.filter((t) => t.credentialPresent).length,
  };
}
export function assertRemovalJobs(store, plan) {
  if (!['machine', 'service'].includes(plan.kind)) return;
  const machineIds =
    plan.kind === 'machine' ? [plan.id] : plan.services.map((s) => s.serverId);
  const serviceIds = plan.services.map((s) => s.id);
  const related = (p) =>
    serviceIds.includes(p.id) ||
    machineIds.includes(p.serverId) ||
    machineIds.some((id) =>
      [p.migration?.sourceId, p.migration?.targetId].includes(id),
    );
  assert(
    !store.list('projects').some((p) => related(p) && migrationLocked(p)),
    'Сначала завершите перенос или восстановление сервиса',
    409,
  );
  const jobs = store.db
    .prepare(
      "SELECT data FROM jobs WHERE json_extract(data,'$.status') IN ('pending','deploying','running')",
    )
    .all()
    .map((r) => JSON.parse(r.data));
  assert(
    !jobs.some(
      (j) =>
        serviceIds.includes(j.projectId) ||
        machineIds.some((id) => [j.serverId, j.target].includes(id)),
    ),
    'Дождитесь завершения операций сервиса и сервера',
    409,
  );
}
// Only panel records are removed. Remote files, native agent history and deployments are untouched.
export function commitRemoval(store, plan) {
  const removedChats =
    plan.kind === 'chat' || plan.kind === 'machine' || plan.deleteChats
      ? plan.chats
      : [];
  const removeSetting = store.db.prepare('DELETE FROM settings WHERE id=?');
  if (plan.kind !== 'machine')
    for (const target of plan.targets.filter((t) =>
      removedChats.some(
        (c) => c.profileId === t.profileId && c.machineId === t.machineId,
      ),
    )) {
      if (target.credentialPresent)
        store.save('settings', { ...target, retired: true }, {});
      else removeSetting.run(target.id);
    }
  for (const chat of removedChats) removeSetting.run(chat.id);
  for (const project of plan.projects) removeSetting.run(project.id);
  if (plan.kind === 'project' && !plan.deleteChats)
    for (const chat of plan.chats) {
      const full = store.get('settings', chat.id);
      full.projectId = null;
      full.cwd = full.cwd || plan.projects[0].path;
      store.save('settings', full);
    }
  for (const context of plan.context) removeSetting.run(context.id);
  for (const service of plan.services) {
    for (const meta of store
      .list('settings')
      .filter(
        (s) => s.recordType === 'session' && s.serviceId === service.id,
      )) {
      const full = store.get('settings', meta.id);
      delete full.serviceId;
      store.save('settings', full);
    }
    store.db.prepare('DELETE FROM projects WHERE id=?').run(service.id);
  }
  if (plan.kind === 'machine') {
    for (const target of plan.targets) removeSetting.run(target.id);
    store.db.prepare('DELETE FROM servers WHERE id=?').run(plan.id);
  }
  return {
    ok: true,
    removedId: plan.id,
    deletedChats: removedChats.map((s) => s.id),
    deletedProjects: plan.projects.map((p) => p.id),
    deletedServices: plan.services.map((s) => s.id),
    deletedMachines: plan.kind === 'machine' ? [plan.id] : [],
  };
}
