import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { createUser, findUserByEmail } from "../../src/users/repo";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
beforeAll(async () => { await runMigrations(getDb(url)); });

test("create then find user", async () => {
  const email = `u${Date.now()}@t.dev`;
  const u = await createUser(getDb(url), email, "hunter2horse");
  const found = await findUserByEmail(getDb(url), email);
  expect(found.id).toBe(u.id);
});
