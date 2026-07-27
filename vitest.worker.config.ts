import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.example.toml' },
      miniflare: { bindings: { GITME_AUTH_TOKEN: 'tok' } },
    }),
  ],
  test: { include: ['test/worker.test.ts', 'test/runtime.test.ts'] },
});
