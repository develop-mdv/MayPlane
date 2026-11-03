import os from 'node:os';
import { connect, run } from './ssh.mjs';
import { projectPath } from './machine-process.mjs';
import { assert } from './security.mjs';

export async function machineHome(machine) {
  if (machine.transport === 'local') return os.homedir();
  if (machine.transport === 'connector') {
    assert(
      machine.homePath,
      'Обновите коннектор на компьютере: он должен передать домашний каталог.',
      409,
    );
    return projectPath(machine.homePath, machine.platform);
  }
  const ssh = await connect(machine);
  try {
    return projectPath(
      (await run(ssh, 'printf "%s" "$HOME"', { timeout: 10000 })).trim(),
    );
  } finally {
    ssh.end();
  }
}

// An old deployment and an agent working folder are different entities.
// Preserve imported records as compatibility context, and preserve every native
// thread ID and working directory when removing the automatic project grouping.
export function separateServices(store) {
  const imported = store
    .list('settings')
    .filter((p) => p.recordType === 'workspace' && p.legacyProjectId);
  if (!imported.length) return;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const project of imported) {
      const full = store.get('settings', project.id);
      full.recordType = 'service_context';
      store.save('settings', full);
      for (const item of store
        .list('settings')
        .filter(
          (s) => s.recordType === 'session' && s.projectId === project.id,
        )) {
        const session = store.get('settings', item.id);
        session.projectId = null;
        session.cwd = project.path;
        session.serviceId = project.legacyProjectId;
        store.save('settings', session);
      }
    }
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
