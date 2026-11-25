import { defineConfig } from 'vitest/config';

/**
 * Opt-in suite against DynamoDB Local: `DYNAMODB_ENDPOINT=http://localhost:8000 npm run test:integration`.
 * Kept out of `npm test` so the default suite needs no Java or Docker.
 */
export default defineConfig({
  test: {
    include: ['test-integration/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
