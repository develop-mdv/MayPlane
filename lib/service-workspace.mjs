function directoryKey(path, platform) {
  if (typeof path !== 'string' || !path) return '';
  if (platform === 'win32') {
    if (!/^[a-z]:[/\\]/i.test(path)) return '';
    return path
      .replaceAll('\\', '/')
      .toLowerCase()
      .split('/')
      .filter((part) => part && part !== '.')
      .join('/');
  }
  if (!path.startsWith('/')) return '';
  return (
    '/' +
    path
      .split('/')
      .filter((part) => part && part !== '.')
      .join('/')
  );
}

export function sameWorkspaceDirectory(left, right, platform) {
  const key = directoryKey(left, platform);
  return !!key && key === directoryKey(right, platform);
}

export function serviceProjects(service, projects, platform) {
  return projects.filter(
    (project) =>
      project.id === service.projectId ||
      (project.machineId === service.machineId &&
        sameWorkspaceDirectory(project.path, service.directory, platform)),
  );
}

export function serviceChatLocation(service, projects, platform) {
  const project = service.directory
    ? projects.find(
        (entry) =>
          entry.machineId === service.machineId &&
          sameWorkspaceDirectory(entry.path, service.directory, platform),
      )
    : projects.find((entry) => entry.id === service.projectId);
  return {
    projectId: project?.id || null,
    machineId: project?.machineId || service.machineId,
    cwd: project?.path || service.directory || '',
  };
}

export function serviceHasChat(service, session, projects, platform) {
  return (
    (session.machineId === service.machineId &&
      (session.serviceId === service.id ||
        sameWorkspaceDirectory(session.cwd, service.directory, platform))) ||
    serviceProjects(service, projects, platform).some(
      (project) => project.id === session.projectId,
    )
  );
}
