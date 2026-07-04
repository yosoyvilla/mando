import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5432/mando";

beforeAll(async () => { await runMigrations(getDb(url)); });

test("users table exists after migration", async () => {
  const sql = getDb(url);
  const rows = await sql`select to_regclass('public.users') as t`;
  expect(rows[0].t).toBe("users");
});

test("migrations are idempotent", async () => {
  await runMigrations(getDb(url));
  expect(true).toBe(true);
});
