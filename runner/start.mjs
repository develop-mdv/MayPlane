import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeConfig, withoutPanelSecrets } from './config.mjs';
import { openStore } from './store.mjs';
import { createApp } from './server.mjs';

const config = runtimeConfig();
const entry = resolve('dist/standalone/server.js');
if (!existsSync(entry)) throw new Error('Сначала выполните npm run build');
const store = openStore(config.dataDir, config.key);
const app = createApp({
  store,
  ownerAuth: true,
  origins: config.origins,
  publicUrl: config.publicUrl,
  trustProxy: config.trustProxy,
  managedTls: process.env.MAYPLANE_TLS_MANAGED === 'true',
  legacyApi: config.legacyApi,
  frontendUrl: `http://127.0.0.1:${config.webPort}`,
});
if (!app.auth.configured()) {
  app.hub.close();
  store.close();
  throw new Error('Создайте логин: npm run runner:setup');
}
const frontend = spawn(process.execPath, [entry], {
  windowsHide: true,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...withoutPanelSecrets(),
    HOST: '127.0.0.1',
    PORT: String(config.webPort),
    NODE_ENV: 'production',
  },
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  app.hub.close();
  app.terminals.close();
  frontend.kill('SIGTERM');
  const force = setTimeout(() => {
    frontend.kill('SIGKILL');
    process.exit(1);
  }, 30000);
  force.unref();
  await Promise.all([
    new Promise((r) => app.server.close(r)),
    app.engine.drain(),
  ]);
  store.close();
  clearTimeout(force);
  process.exit(code);
}
frontend.on('error', () => void stop(1));
frontend.on('exit', () => {
  if (!stopping) void stop(1);
});
app.server.on('error', () => void stop(1));
app.server.listen(config.port, config.host, () =>
  console.log(
    `MayPlane: ${config.publicUrl || `http://127.0.0.1:${config.port}`}`,
  ),
);
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
