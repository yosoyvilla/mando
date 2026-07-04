import { test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { createUser } from "../../src/users/repo";
import { createSession, readSession, destroySession } from "../../src/auth/session";
import { requireUser, requireMachineOwnership } from "../../src/auth/middleware";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);

beforeAll(async () => {
  await runMigrations(sql);
});

function uniqueEmail(tag: string) {
  return `u${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}@t.dev`;
}

test("createSession then readSession returns the userId", async () => {
  const user = await createUser(sql, uniqueEmail("roundtrip"), "hunter2horse");
  const sessionId = await createSession(sql, user.id);
  const session = await readSession(sql, sessionId);
  expect(session).toEqual({ userId: user.id });
});

test("destroySession then readSession returns null", async () => {
  const user = await createUser(sql, uniqueEmail("destroy"), "hunter2horse");
  const sessionId = await createSession(sql, user.id);
  await destroySession(sql, sessionId);
  const session = await readSession(sql, sessionId);
  expect(session).toBeNull();
});

test("readSession returns null for an unknown session id", async () => {
  const session = await readSession(sql, "not-a-real-session-id");
  expect(session).toBeNull();
});

test("readSession returns null for an expired session", async () => {
  const user = await createUser(sql, uniqueEmail("expired"), "hunter2horse");
  const sessionId = await createSession(sql, user.id);
  await sql`update user_sessions set expires_at = now() - interval '1 day' where id = ${sessionId}`;

  const session = await readSession(sql, sessionId);
  expect(session).toBeNull();
});

test("requireUser returns 401 when no cookie is present", async () => {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.get("/me", requireUser(sql), (c) => c.json({ userId: c.get("userId") }));

  const res = await app.request("/me");
  expect(res.status).toBe(401);
});

test("requireUser returns 401 for an invalid session cookie", async () => {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.get("/me", requireUser(sql), (c) => c.json({ userId: c.get("userId") }));

  const res = await app.request("/me", {
    headers: { Cookie: "mando_sess=bogus-session-id" },
  });
  expect(res.status).toBe(401);
});

test("requireUser sets userId and calls next() for a valid session cookie", async () => {
  const user = await createUser(sql, uniqueEmail("mw-valid"), "hunter2horse");
  const sessionId = await createSession(sql, user.id);

  const app = new Hono<{ Variables: { userId: string } }>();
  app.get("/me", requireUser(sql), (c) => c.json({ userId: c.get("userId") }));

  const res = await app.request("/me", {
    headers: { Cookie: `mando_sess=${sessionId}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.userId).toBe(user.id);
});

test("requireMachineOwnership returns 404 when the machine belongs to another user", async () => {
  const owner = await createUser(sql, uniqueEmail("owner"), "hunter2horse");
  const otherUser = await createUser(sql, uniqueEmail("other"), "hunter2horse");
  const [machine] = await sql`insert into machines (user_id, name) values (${owner.id}, 'owner-mac') returning id`;
  const otherSessionId = await createSession(sql, otherUser.id);

  const app = new Hono<{ Variables: { userId: string; machine: unknown } }>();
  app.get("/machines/:id", requireUser(sql), requireMachineOwnership(sql), (c) => c.json({ ok: true }));

  const res = await app.request(`/machines/${machine.id}`, {
    headers: { Cookie: `mando_sess=${otherSessionId}` },
  });
  expect(res.status).toBe(404);
});

test("requireMachineOwnership returns 404 when the machine does not exist", async () => {
  const user = await createUser(sql, uniqueEmail("nomachine"), "hunter2horse");
  const sessionId = await createSession(sql, user.id);

  const app = new Hono<{ Variables: { userId: string; machine: unknown } }>();
  app.get("/machines/:id", requireUser(sql), requireMachineOwnership(sql), (c) => c.json({ ok: true }));

  const res = await app.request("/machines/00000000-0000-0000-0000-000000000000", {
    headers: { Cookie: `mando_sess=${sessionId}` },
  });
  expect(res.status).toBe(404);
});

test("requireMachineOwnership returns 404 (not 500) for a malformed :id", async () => {
  const user = await createUser(sql, uniqueEmail("malformed"), "hunter2horse");
  const sessionId = await createSession(sql, user.id);

  const app = new Hono<{ Variables: { userId: string; machine: unknown } }>();
  app.get("/machines/:id", requireUser(sql), requireMachineOwnership(sql), (c) => c.json({ ok: true }));

  const res = await app.request("/machines/not-a-uuid", {
    headers: { Cookie: `mando_sess=${sessionId}` },
  });
  expect(res.status).toBe(404);
});

test("requireMachineOwnership sets machine and calls next() for the owner", async () => {
  const owner = await createUser(sql, uniqueEmail("owner2"), "hunter2horse");
  const [machine] = await sql`insert into machines (user_id, name) values (${owner.id}, 'owner-mac-2') returning id`;
  const ownerSessionId = await createSession(sql, owner.id);

  const app = new Hono<{ Variables: { userId: string; machine: { id: string } } }>();
  app.get("/machines/:id", requireUser(sql), requireMachineOwnership(sql), (c) =>
    c.json({ machineId: c.get("machine").id }),
  );

  const res = await app.request(`/machines/${machine.id}`, {
    headers: { Cookie: `mando_sess=${ownerSessionId}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.machineId).toBe(machine.id);
});
