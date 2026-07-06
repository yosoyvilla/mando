import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { createUser, findUserByEmail, listUsers } from "../../src/users/repo";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
beforeAll(async () => { await runMigrations(getDb(url)); });

test("create then find user", async () => {
  const email = `u${Date.now()}@t.dev`;
  const u = await createUser(getDb(url), email, "hunter2horse");
  const found = await findUserByEmail(getDb(url), email);
  expect(found.id).toBe(u.id);
});

test("listUsers returns users including their admin flag", async () => {
  const adminEmail = `admin${Date.now()}@t.dev`;
  const admin = await createUser(getDb(url), adminEmail, "hunter2horse", { isAdmin: true });
  const rows = await listUsers(getDb(url));
  const found = rows.find((r) => r.id === admin.id);
  expect(found).toBeTruthy();
  expect(found!.email).toBe(adminEmail);
  expect(found!.is_admin).toBe(true);
  expect(typeof found!.created_at).toBe("string");
});
