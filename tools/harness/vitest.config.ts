import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 10_000,
    // Disposable test repositories must not depend on or alter an operator's Git identity.
    env: {
      GIT_AUTHOR_NAME: 'Harness Test',
      GIT_AUTHOR_EMAIL: 'harness-test@example.invalid',
      GIT_COMMITTER_NAME: 'Harness Test',
      GIT_COMMITTER_EMAIL: 'harness-test@example.invalid',
    },
  },
});
