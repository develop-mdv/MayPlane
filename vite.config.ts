import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { reserveRunnerUpgrades } from './lib/runner-proxy.mjs';

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8788', ws: true } },
    fs: {
      deny: [
        '.env',
        '.env.*',
        '**/.git/**',
        '**/.runner-data/**',
        '**/.artifacts/**',
        '**/.mayplane/**',
        '**/.mayplane-connector/**',
        '**/*.sqlite*',
        '**/*.key',
        '**/*.pem',
      ],
    },
    ...(process.env.CODEX_SANDBOX === 'seatbelt'
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
  },
  plugins: [
    vinext(),
    {
      name: 'mayplane:runner-websocket-route',
      configureServer(server) {
        reserveRunnerUpgrades(server.httpServer);
      },
    },
  ],
});
