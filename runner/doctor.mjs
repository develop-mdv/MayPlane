import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeConfig } from './config.mjs';
import { certificateStatus } from './tls-status.mjs';

const config = runtimeConfig();
const url = config.publicUrl || `http://127.0.0.1:${config.port}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = {
  node: process.version,
  url,
  database: existsSync(join(config.dataDir, 'mayplane.sqlite')),
  build: existsSync(join(root, 'dist/standalone/server.js')),
};
try {
  checks.api = (
    await fetch(`http://127.0.0.1:${config.port}/healthz`, {
      signal: AbortSignal.timeout(5000),
    })
  ).ok;
} catch {
  checks.api = false;
}
checks.tls = await certificateStatus(config.publicUrl, {
  managed: process.env.MAYPLANE_TLS_MANAGED === 'true',
});
console.log(JSON.stringify(checks, null, 2));
if (
  !checks.api ||
  !checks.database ||
  !checks.build ||
  (checks.tls.enabled && checks.tls.state !== 'valid')
)
  process.exitCode = 1;
