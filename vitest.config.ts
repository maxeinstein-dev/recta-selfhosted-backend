import { defineConfig } from 'vitest/config';

// Unit tests never touch the database. Importing any service pulls in
// shared/db/prisma.ts -> shared/config/env.ts, whose validateEnv() calls
// process.exit(1) when DATABASE_URL is missing, so give it a dummy URL
// unless the shell already provides one.
export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgresql://vitest:vitest@localhost:5432/vitest',
    },
  },
});
