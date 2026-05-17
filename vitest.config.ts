import { defineConfig } from 'vitest/config';

/**
 * Tests run against a *fresh* SQLite DB per test file (see test/helpers/db.ts).
 * The Gateway client and WS bridge are never reached from tests — every test
 * stubs `openclawWs`/`gatewayWs` so we don't depend on a running OpenClaw.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/setup.ts'],
    // Each test file gets its own pool worker → its own require cache and its
    // own DB instance (configured via DB_PATH per test). Avoids tests leaking
    // schema state into each other.
    pool: 'forks',
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/index.ts'],
    },
    // Long enough for SQLite WAL checkpoint + a few HTTP supertest round trips.
    testTimeout: 10_000,
  },
});
