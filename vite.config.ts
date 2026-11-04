import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { sites } from '@openai/sites-vite-plugin';
import { reserveRunnerUpgrades } from './lib/runner-proxy.mjs';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, type ProxyOptions, type ViteDevServer } from 'vite';
import hostingConfig from './.openai/hosting.json' with { type: 'json' };

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  let localRunnerToken = process.env.MAYPLANE_TOKEN;
  try {
    localRunnerToken ||= parseEnv(
      readFileSync('.env.runner', 'utf8'),
    ).MAYPLANE_TOKEN;
  } catch {}
  const runnerProxy: Record<string, ProxyOptions> | undefined = localRunnerToken
    ? {
        '/api': {
          target: 'http://127.0.0.1:8788',
          ws: true,
          configure(proxy) {
            proxy.on('proxyReq', (req) =>
              req.setHeader('Authorization', 'Bearer ' + localRunnerToken),
            );
          },
        },
      }
    : undefined;
  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      host: '127.0.0.1',
      strictPort: true,
      proxy: runnerProxy,
      fs: {
        deny: [
          '.env',
          '.env.*',
          '**/.git/**',
          '**/.runner-data/**',
          '**/*.sqlite*',
          '**/*.pem',
        ],
      },
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
      {
        name: 'mayplane:runner-websocket-route',
        configureServer(server: ViteDevServer) {
          if (runnerProxy) reserveRunnerUpgrades(server.httpServer);
        },
      },
    ],
  };
});
