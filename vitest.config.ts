import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
