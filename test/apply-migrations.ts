import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

type Migration = {
  name: string;
  queries: string[];
};

beforeAll(async () => {
  const migrations = (env as Env & { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations);
});
