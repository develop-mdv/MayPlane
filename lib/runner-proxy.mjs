/** Keep already registered Worker/HMR handlers away from the runner's upgrade route.
 * Vite registers its server.proxy upgrade handler after configureServer hooks.
 */
export function reserveRunnerUpgrades(httpServer) {
  if (!httpServer) return;
  for (const listener of httpServer.listeners('upgrade')) {
    httpServer.off('upgrade', listener);
    httpServer.on('upgrade', function (request, socket, head) {
      const path = new URL(request.url || '/', 'http://localhost').pathname;
      if (path.startsWith('/api/')) return;
      return listener.call(this, request, socket, head);
    });
  }
}
