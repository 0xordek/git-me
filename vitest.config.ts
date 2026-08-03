import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/cli-entrypoint.test.ts',
      'test/cli.test.ts',
      'test/credentials.test.ts',
      'test/deploy.test.ts',
      'test/lfs-client.test.ts',
      'test/migrate.test.ts',
      'test/pointers.test.ts',
      'test/profile.test.ts',
    ],
  },
});
