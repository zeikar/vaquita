import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { DEV_PORT, vaquitaDevEndpoint } from './vite-dev-endpoint'

export default defineConfig({
  plugins: [vaquitaDevEndpoint(), svelte()],
  clearScreen: false,
  // src-tauri/target churns during cargo builds; Vite need not watch it.
  server: { port: DEV_PORT, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  // Svelte's browser build, so that tests can mount components.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
