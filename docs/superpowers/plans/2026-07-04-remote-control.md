# OpenCode Mando Remote Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a hosted Mando web UI drive opencode sessions running on any developer machine, connected by an outbound reverse tunnel started with a `/mando` command, mirroring Claude Code's `/rc` remote control.

**Architecture:** A single hosted `hub` process (Bun + Hono) serves the web UI, a REST/SSE API, and a WebSocket endpoint that developer machines dial out to. A `mando` agent on each machine forwards proxied requests to the local `opencode serve` on 127.0.0.1:4096. The browser only ever talks to the hub; opencode servers are never publicly addressable. Shared frame schemas live in `packages/protocol`. PostgreSQL holds users, machines, tokens, and pairing requests.

**Tech Stack:** TypeScript, Bun (runtime + `bun test` + `bun build --compile`), Hono (hub HTTP/WS), PostgreSQL (`postgres.js`), Zod (frame + input validation), argon2 (password + token hashing), React + Vite (existing web UI), Playwright (browser E2E), Docker Compose + Kubernetes manifests.

## Global Constraints

- Language: TypeScript everywhere. No second runtime language.
- Runtime floor: Bun >= 1.3.13 (from `packages/cli/package.json` engines).
- Zod version: pin new packages to `zod@^4.4.3` to match `apps/web` (the repo is already on Zod 4; do not introduce a Zod 3 split). The schema APIs used here (`z.record(z.string(), z.string())`, `z.coerce.number()`, `z.discriminatedUnion`) are Zod-4 correct.
- Web build shape (resolves spec open question #3): `apps/web` is currently a Nitro server app (`vite.config.ts` has `nitro({preset:"bun"})`, runs `.output/server/index.mjs`). The hub is the only server in the target architecture, so `apps/web` is converted to a static SPA build (Nitro removed) in Task 5.0; the hub serves those static assets. Tasks 2.9 and 6.1 depend on 5.0 producing a static asset directory.
- Database: PostgreSQL only. No SQLite. Client: `postgres.js`. Schema via SQL migration files in `apps/hub/migrations/`.
- Naming/copy rule: no reference anywhere (code, comments, docs, package metadata, git messages) to any prior project or author. This is a standalone project. The LICENSE is sole-author `Copyright (c) 2026 David Villa (yosoyvilla)`.
- No emojis in source, docs, or commit messages. Single-line commit messages, no co-author, no session URLs.
- Every frame crossing the tunnel is validated at runtime with a Zod schema from `packages/protocol` on both send and receive.
- Multi-tenant from line one: every machine-scoped API route asserts `machine.user_id === session.user_id`.
- Test pyramid is mandatory: unit + integration + Playwright E2E. A feature is not done until all layers covering it pass. TDD: write the failing test first.
- Secrets (passwords, machine tokens) are never stored in plaintext: argon2id at rest. Machine token file `~/.mando.json` is chmod 600.
- Frequent commits: one per task minimum.

## Base-Code Health Findings (address in Phase 0)

- No test infrastructure exists (no test files, no test scripts, no turbo `test` task). Establish it before feature work.
- Root `package.json` has `check-types` (turbo) but no `test` or `typecheck` script; `packages/cli` uses `typecheck`, `apps/web` has neither. Standardize on `typecheck` for all packages and add root `test`/`typecheck` scripts that fan out via turbo (keep the existing `check-types` turbo task as an alias so nothing breaks).
- `.gitignore` carries tooling references from initial scaffolding (`.vercel`, `.next/`, `t3code/`) that are not part of this project's stack. Trim to what we use.
- `bun install` succeeds (856 packages); both existing packages typecheck clean (exit 0). No emoji/TODO leftovers in source.

## File Structure

```
apps/hub/                         NEW — hosted server
  src/
    index.ts                      entry: build app, start Bun.serve with WS
    app.ts                        Hono app assembly (routes + middleware)
    config.ts                     env parsing + validation (Zod)
    db/
      client.ts                   postgres.js pool
      migrate.ts                  migration runner
    migrations/
      001_init.sql                users, sessions, machines, machine_tokens, pairing_requests
    auth/
      password.ts                 argon2 hash/verify
      session.ts                  cookie session create/read/destroy
      middleware.ts               requireUser, requireMachineOwnership
    users/
      repo.ts                     user CRUD (data access)
      routes.ts                   login, logout, bootstrap-admin, invite
    machines/
      repo.ts                     machine + token CRUD
      routes.ts                   list, get, revoke
    pairing/
      repo.ts                     pairing request CRUD
      service.ts                  code gen, expiry, approval
      routes.ts                   request-code, approve, poll-status
    tunnel/
      registry.ts                 in-memory live tunnel map (machineId -> conn)
      ws.ts                       /ws/agent handler: hello, ping/pong, frame routing
      proxy.ts                    turn a browser HTTP/SSE request into tunnel frames
    proxy/
      routes.ts                   /api/v1/machines/:id/opencode/* -> proxy
  test/
    unit/                         pairing codes, token hashing, registry
    integration/                  auth, pairing, ownership, proxy+SSE vs fake agent
  package.json

packages/protocol/                NEW — shared frame schemas
  src/
    frames.ts                     Zod schemas + inferred types for every frame
    index.ts                      re-exports
  test/frames.test.ts
  package.json

packages/agent/                   NEW — machine-side agent (grows the mando CLI)
  src/
    index.ts                      CLI entry (arg parse: connect/disconnect/status/install-command)
    connect.ts                    daemonize, dial hub, forward loop
    daemon.ts                     detached process lifecycle + pidfile
    config.ts                     ~/.mando.json read/write (chmod 600)
    opencode.ts                   detect local opencode server port + health
    forward.ts                    frame -> local http fetch -> chunked response frames
    reconnect.ts                  backoff state machine
    install-command.ts            write ~/.config/opencode/commands/mando.md
  test/
    unit/                         backoff, config, arg parse
    integration/                  fake hub <-> agent <-> stub opencode
  package.json

packages/opencode-plugin/         NEW — the /mando command asset
  commands/mando.md               the command template
  package.json

apps/web/                         EXISTING — refactor data layer to hub
  src/lib/hub-client.ts           NEW: talk to hub API
  (server local-mode routes removed once hub mode passes E2E)

deploy/
  Dockerfile                      multi-stage: build web -> hub image
  docker-compose.yml              hub + postgres:17
  k8s/
    deployment.yaml
    service.yaml
    ingress.example.yaml
    secret.example.yaml

e2e/                              NEW — Playwright browser E2E
  playwright.config.ts
  fixtures/stub-opencode.ts       minimal fake opencode server
  tests/
    auth.spec.ts
    pairing.spec.ts
    machines.spec.ts
    session-drive.spec.ts
    isolation.spec.ts

README.md                         rewrite for all audiences
AGENTS.md                         NEW — project conventions + workflow
turbo.json                        add test/typecheck tasks
```

---

## Phase 0: Repo Health and Test Infrastructure

### Task 0.1: Establish test + typecheck tooling across the monorepo

**Files:**
- Modify: `turbo.json`
- Modify: `apps/web/package.json` (add `typecheck`)
- Modify: `.gitignore` (trim unused tooling entries)
- Create: `packages/protocol/package.json` (minimal, to prove `bun test` wiring)
- Test: `packages/protocol/test/smoke.test.ts`

**Interfaces:**
- Produces: root scripts `bun run test`, `bun run typecheck` that fan out via turbo; a working `bun test` invocation pattern reused by every later task.

- [ ] **Step 1: Write a smoke test that must pass**

```ts
// packages/protocol/test/smoke.test.ts
import { test, expect } from "bun:test";

test("bun test runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 2: Create the protocol package manifest**

```json
// packages/protocol/package.json
{
  "name": "@mando/protocol",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^6.0.3"
  },
  "dependencies": {
    "zod": "^4.4.3"
  }
}
```

- [ ] **Step 3: Run the smoke test to verify it passes**

Run: `cd packages/protocol && bun test`
Expected: PASS, 1 test.

- [ ] **Step 4: Add turbo tasks, root scripts, and web typecheck**

```json
// turbo.json — add under "tasks"
{
  "test": { "dependsOn": ["^build"], "outputs": [] },
  "typecheck": { "dependsOn": ["^build"], "outputs": [] }
}
```

```json
// package.json (root) scripts — add
"test": "turbo run test",
"typecheck": "turbo run typecheck"
```

```json
// apps/web/package.json scripts — add
"typecheck": "tsc --noEmit"
```

Note: leave the existing root `check-types` script and its turbo task in place as an alias — do not remove it.

- [ ] **Step 5: Trim .gitignore** — remove the `.vercel`, `.next/`, `.pnp`, `.pnp.js`, and `t3code/` lines (not part of this stack); keep `node_modules`, `.env*`, `dist`, `build`, `.turbo`, `coverage`, `.DS_Store`, `*.pem`. Add `test-results/`, `playwright-report/`, `.mando-pid`.

- [ ] **Step 6: Verify root fan-out**

Run: `cd ~/Documents/personal/mando && bun install && bun run typecheck`
Expected: all packages exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add test and typecheck tooling across monorepo"
```

---

## Phase 1: Protocol Package

### Task 1.1: Define and validate tunnel frame schemas

**Files:**
- Create: `packages/protocol/src/frames.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/frames.test.ts`

**Interfaces:**
- Produces: `Frame` union type; `parseFrame(raw: string): Frame` (throws on invalid); `serializeFrame(f: Frame): string`; individual schemas `HelloFrame`, `RegisteredFrame`, `ErrorFrame`, `HttpRequestFrame`, `ResponseBeginFrame`, `ResponseChunkFrame`, `ResponseEndFrame`, `ResponseErrorFrame`, `CancelFrame`, `PingFrame`, `PongFrame`, `StatusFrame`. Every frame has `{ type, id, payload }` except `ping`/`pong` where `id` is the heartbeat nonce and `payload` is absent.

- [ ] **Step 1: Write failing tests for roundtrip and rejection**

```ts
// packages/protocol/test/frames.test.ts
import { test, expect } from "bun:test";
import { parseFrame, serializeFrame } from "../src/index";

test("http_request roundtrips", () => {
  const f = {
    type: "http_request",
    id: "req-1",
    payload: { method: "GET", path: "/session", headers: {}, body: null },
  } as const;
  expect(parseFrame(serializeFrame(f))).toEqual(f);
});

test("response_chunk requires base64 data", () => {
  const raw = JSON.stringify({ type: "response_chunk", id: "req-1", payload: {} });
  expect(() => parseFrame(raw)).toThrow();
});

test("unknown type is rejected", () => {
  const raw = JSON.stringify({ type: "nope", id: "x", payload: {} });
  expect(() => parseFrame(raw)).toThrow();
});

test("hello carries token, machine name, port, version", () => {
  const f = {
    type: "hello",
    id: "h-1",
    payload: { token: "t", machineName: "laptop", opencodePort: 4096, agentVersion: "0.1.0" },
  } as const;
  expect(parseFrame(serializeFrame(f))).toEqual(f);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/protocol && bun test`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Implement schemas**

```ts
// packages/protocol/src/frames.ts
import { z } from "zod";

const base64 = z.string();
const headers = z.record(z.string(), z.string());

export const HelloFrame = z.object({
  type: z.literal("hello"),
  id: z.string(),
  payload: z.object({
    token: z.string(),
    machineName: z.string().min(1),
    opencodePort: z.number().int().positive(),
    agentVersion: z.string(),
  }),
});

export const RegisteredFrame = z.object({
  type: z.literal("registered"),
  id: z.string(),
  payload: z.object({ machineId: z.string() }),
});

export const ErrorFrame = z.object({
  type: z.literal("error"),
  id: z.string(),
  payload: z.object({ code: z.string(), message: z.string() }),
});

export const HttpRequestFrame = z.object({
  type: z.literal("http_request"),
  id: z.string(),
  payload: z.object({
    method: z.string(),
    path: z.string(),
    headers,
    body: base64.nullable(),
  }),
});

export const ResponseBeginFrame = z.object({
  type: z.literal("response_begin"),
  id: z.string(),
  payload: z.object({ status: z.number().int(), headers }),
});

export const ResponseChunkFrame = z.object({
  type: z.literal("response_chunk"),
  id: z.string(),
  payload: z.object({ data: base64 }),
});

export const ResponseEndFrame = z.object({
  type: z.literal("response_end"),
  id: z.string(),
  payload: z.object({}).strict(),
});

export const ResponseErrorFrame = z.object({
  type: z.literal("response_error"),
  id: z.string(),
  payload: z.object({ code: z.string(), message: z.string() }),
});

export const CancelFrame = z.object({
  type: z.literal("cancel"),
  id: z.string(),
  payload: z.object({}).strict(),
});

export const PingFrame = z.object({ type: z.literal("ping"), id: z.string() });
export const PongFrame = z.object({ type: z.literal("pong"), id: z.string() });

export const StatusFrame = z.object({
  type: z.literal("status"),
  id: z.string(),
  payload: z.object({ opencodeHealthy: z.boolean() }),
});

export const FrameSchema = z.discriminatedUnion("type", [
  HelloFrame, RegisteredFrame, ErrorFrame, HttpRequestFrame,
  ResponseBeginFrame, ResponseChunkFrame, ResponseEndFrame, ResponseErrorFrame,
  CancelFrame, PingFrame, PongFrame, StatusFrame,
]);

export type Frame = z.infer<typeof FrameSchema>;

export function parseFrame(raw: string): Frame {
  return FrameSchema.parse(JSON.parse(raw));
}

export function serializeFrame(f: Frame): string {
  return JSON.stringify(FrameSchema.parse(f));
}
```

```ts
// packages/protocol/src/index.ts
export * from "./frames";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/protocol && bun test`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "Add tunnel frame protocol schemas"
```

---

## Phase 2: Hub

Phase 2 is the largest. Each task is independently testable; integration tests use a real Postgres from `docker-compose.yml` (added in Task 2.1).

### Task 2.1: Hub scaffold, config, and Postgres client

**Files:**
- Create: `apps/hub/package.json`, `apps/hub/src/config.ts`, `apps/hub/src/db/client.ts`
- Create: `deploy/docker-compose.yml` (postgres service for tests + local run)
- Test: `apps/hub/test/unit/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): Config` where `Config = { port: number; databaseUrl: string; cookieSecret: string; publicUrl: string; adminEmail?: string; adminPassword?: string }`; `getDb(): Sql` (a `postgres.js` instance).

- [ ] **Step 1: Failing config test**

```ts
// apps/hub/test/unit/config.test.ts
import { test, expect } from "bun:test";
import { loadConfig } from "../../src/config";

test("loadConfig requires DATABASE_URL", () => {
  expect(() => loadConfig({ COOKIE_SECRET: "x", PUBLIC_URL: "http://x" })).toThrow();
});

test("loadConfig defaults port to 8080", () => {
  const c = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost/db",
    COOKIE_SECRET: "s",
    PUBLIC_URL: "http://x",
  });
  expect(c.port).toBe(8080);
});
```

- [ ] **Step 2: Manifest + docker-compose**

```json
// apps/hub/package.json
{
  "name": "@mando/hub",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "start": "bun run src/index.ts",
    "migrate": "bun run src/db/migrate.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mando/protocol": "workspace:*",
    "hono": "^4.6.14",
    "postgres": "^3.4.5",
    "zod": "^4.4.3"
  },
  "devDependencies": { "typescript": "^6.0.3" }
}
```

```yaml
# deploy/docker-compose.yml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: mando
      POSTGRES_PASSWORD: mando
      POSTGRES_DB: mando
    ports: ["5432:5432"]
    volumes: ["mando_pg:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mando"]
      interval: 5s
      timeout: 3s
      retries: 10
  hub:
    build: { context: .., dockerfile: deploy/Dockerfile }
    environment:
      DATABASE_URL: postgres://mando:mando@postgres:5432/mando
      COOKIE_SECRET: change-me
      PUBLIC_URL: http://localhost:8080
    ports: ["8080:8080"]
    depends_on:
      postgres: { condition: service_healthy }
volumes: { mando_pg: {} }
```

- [ ] **Step 3: Implement config + db client**

```ts
// apps/hub/src/config.ts
import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  MANDO_ADMIN_EMAIL: z.string().email().optional(),
  MANDO_ADMIN_PASSWORD: z.string().min(8).optional(),
});

export type Config = {
  port: number; databaseUrl: string; cookieSecret: string;
  publicUrl: string; adminEmail?: string; adminPassword?: string;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const p = Schema.parse(env);
  return {
    port: p.PORT, databaseUrl: p.DATABASE_URL, cookieSecret: p.COOKIE_SECRET,
    publicUrl: p.PUBLIC_URL, adminEmail: p.MANDO_ADMIN_EMAIL, adminPassword: p.MANDO_ADMIN_PASSWORD,
  };
}
```

```ts
// apps/hub/src/db/client.ts
import postgres from "postgres";
let sql: ReturnType<typeof postgres> | null = null;
export function getDb(url: string) {
  if (!sql) sql = postgres(url, { max: 10 });
  return sql;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd apps/hub && bun test test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub deploy/docker-compose.yml
git commit -m "Add hub scaffold, config, and Postgres client"
```

### Task 2.2: Database schema and migration runner

**Files:**
- Create: `apps/hub/migrations/001_init.sql`, `apps/hub/src/db/migrate.ts`
- Test: `apps/hub/test/integration/migrate.test.ts`

**Interfaces:**
- Consumes: `getDb`, `loadConfig`.
- Produces: `runMigrations(sql): Promise<void>` (idempotent; tracks applied files in a `_migrations` table). Tables: `users`, `user_sessions`, `machines`, `machine_tokens`, `pairing_requests`.

- [ ] **Step 1: Failing integration test** (requires `docker compose -f deploy/docker-compose.yml up -d postgres`)

```ts
// apps/hub/test/integration/migrate.test.ts
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
```

- [ ] **Step 2: Write schema**

```sql
-- apps/hub/migrations/001_init.sql
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists user_sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table if not exists machines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  platform text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists machine_tokens (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machines(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table if not exists pairing_requests (
  code text primary key,
  machine_name text not null,
  platform text,
  user_id uuid references users(id) on delete cascade,
  machine_id uuid references machines(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
```

- [ ] **Step 3: Migration runner**

```ts
// apps/hub/src/db/migrate.ts
import type postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function runMigrations(sql: ReturnType<typeof postgres>) {
  await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`;
  const dir = join(import.meta.dir, "..", "..", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await sql`select 1 from _migrations where name = ${f}`;
    if (done.length) continue;
    await sql.unsafe(readFileSync(join(dir, f), "utf8"));
    await sql`insert into _migrations (name) values (${f})`;
  }
}

if (import.meta.main) {
  const { getDb } = await import("./client");
  const { loadConfig } = await import("../config");
  await runMigrations(getDb(loadConfig(process.env).databaseUrl));
  process.exit(0);
}
```

- [ ] **Step 4: Run** — `docker compose -f deploy/docker-compose.yml up -d postgres && cd apps/hub && bun test test/integration/migrate.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/migrations apps/hub/src/db/migrate.ts apps/hub/test/integration/migrate.test.ts
git commit -m "Add hub database schema and migration runner"
```

### Task 2.3: Password + token hashing and user repo

**Files:**
- Create: `apps/hub/src/auth/password.ts`, `apps/hub/src/users/repo.ts`
- Test: `apps/hub/test/unit/password.test.ts`, `apps/hub/test/integration/users.test.ts`

**Interfaces:**
- Produces: `hashSecret(s): Promise<string>`, `verifySecret(s, hash): Promise<boolean>` (Bun's `Bun.password`, argon2id); `createUser(sql, email, password): Promise<User>`, `findUserByEmail(sql, email): Promise<User|null>`, `User = { id, email }`.

- [ ] **Step 1: Failing tests**

```ts
// apps/hub/test/unit/password.test.ts
import { test, expect } from "bun:test";
import { hashSecret, verifySecret } from "../../src/auth/password";

test("hash verifies", async () => {
  const h = await hashSecret("hunter2horse");
  expect(await verifySecret("hunter2horse", h)).toBe(true);
  expect(await verifySecret("wrong", h)).toBe(false);
});
```

- [ ] **Step 2: Implement**

```ts
// apps/hub/src/auth/password.ts
export function hashSecret(s: string): Promise<string> {
  return Bun.password.hash(s, { algorithm: "argon2id" });
}
export function verifySecret(s: string, hash: string): Promise<boolean> {
  return Bun.password.verify(s, hash);
}
```

```ts
// apps/hub/src/users/repo.ts
import type postgres from "postgres";
import { hashSecret } from "../auth/password";
export type User = { id: string; email: string };
type Sql = ReturnType<typeof postgres>;

export async function createUser(sql: Sql, email: string, password: string): Promise<User> {
  const hash = await hashSecret(password);
  const rows = await sql`insert into users (email, password_hash) values (${email}, ${hash}) returning id, email`;
  return rows[0] as User;
}
export async function findUserByEmail(sql: Sql, email: string) {
  const rows = await sql`select id, email, password_hash from users where email = ${email}`;
  return rows[0] ?? null;
}
```

- [ ] **Step 3: Integration test**

```ts
// apps/hub/test/integration/users.test.ts
import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { createUser, findUserByEmail } from "../../src/users/repo";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5432/mando";
beforeAll(async () => { await runMigrations(getDb(url)); });

test("create then find user", async () => {
  const email = `u${Date.now()}@t.dev`;
  const u = await createUser(getDb(url), email, "hunter2horse");
  const found = await findUserByEmail(getDb(url), email);
  expect(found.id).toBe(u.id);
});
```

- [ ] **Step 4: Run** — `cd apps/hub && bun test`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add password hashing and user repository"`.

### Task 2.4: Cookie sessions and auth middleware

**Files:**
- Create: `apps/hub/src/auth/session.ts`, `apps/hub/src/auth/middleware.ts`
- Test: `apps/hub/test/integration/session.test.ts`

**Interfaces:**
- Produces: `createSession(sql, userId): Promise<string>` (returns session id), `readSession(sql, id): Promise<{userId}|null>`, `destroySession(sql, id)`; Hono middleware `requireUser` (sets `c.get("userId")` from the `mando_sess` cookie or 401) and `requireMachineOwnership` (loads machine by `:id`, 404 if not owned by `c.get("userId")`, else `c.set("machine", m)`).

- [ ] **Step 1: Failing test** for create/read/destroy roundtrip against Postgres, plus a middleware test that a request without cookie gets 401 and cross-user machine access gets 404. (Full test code: assert `readSession` returns the userId after `createSession`; assert `null` after `destroySession`; mount a tiny Hono app with `requireMachineOwnership` and assert 404 when the machine belongs to another user.)

- [ ] **Step 2: Implement session store** (random 32-byte id via `crypto.randomUUID()` twice or `crypto.getRandomValues`; 30-day expiry; delete-on-destroy) **and middleware** (parse cookie, look up session, compare `machine.user_id`).

- [ ] **Step 3: Run** — `cd apps/hub && bun test test/integration/session.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add cookie sessions and auth middleware"`.

### Task 2.5: User routes (login, logout, bootstrap, invite)

**Files:**
- Create: `apps/hub/src/users/routes.ts`, `apps/hub/src/app.ts` (initial assembly)
- Test: `apps/hub/test/integration/auth-routes.test.ts`

**Interfaces:**
- Consumes: user repo, session store, `verifySecret`.
- Produces: Hono routes `POST /api/v1/auth/login` (email+password -> set cookie), `POST /api/v1/auth/logout`, `POST /api/v1/auth/bootstrap` (creates first admin only if zero users exist, or from env at startup), `POST /api/v1/auth/invite` (requireUser -> create user with temp password). `buildApp(deps): Hono`.

- [ ] **Step 1: Failing test** — login with bad password 401; login with good password sets `mando_sess` cookie and a follow-up `GET /api/v1/me` returns the email; bootstrap twice fails the second time.

- [ ] **Step 2: Implement routes** with Zod body validation. `buildApp` wires routes + middleware and is the single place the server and tests both construct the app.

- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add authentication routes"`.

### Task 2.6: Pairing service and routes

**Files:**
- Create: `apps/hub/src/pairing/repo.ts`, `apps/hub/src/pairing/service.ts`, `apps/hub/src/pairing/routes.ts`, `apps/hub/src/machines/repo.ts`
- Test: `apps/hub/test/unit/pairing-code.test.ts`, `apps/hub/test/integration/pairing.test.ts`

**Interfaces:**
- Produces: `generateCode(): string` (8 chars, unambiguous alphabet, format `XXXX-XXXX`); `createPairingRequest(sql, {machineName, platform}): Promise<{code, expiresAt}>` (10-min expiry); `approvePairing(sql, userId, code): Promise<{machineId, token}>` (creates machine + machine_token, hashes token, marks consumed, rejects expired/consumed/unknown); `pollPairing(sql, code): Promise<{status: "pending"|"approved", token?}>`. Machine repo: `createMachine`, `listMachines(sql, userId)`, `getMachine`, `revokeMachine` (sets `revoked_at`, revokes tokens). Routes: `POST /api/v1/pairing/request` (no auth — agent calls it), `GET /api/v1/pairing/status?code=` (agent polls), `POST /api/v1/pairing/approve` (requireUser).

- [ ] **Step 1: Failing unit test** for `generateCode` (format + alphabet excludes 0/O/1/I) and failing integration tests for the full request -> approve -> poll-returns-token lifecycle, plus expired-code rejection and double-approve rejection.

- [ ] **Step 2: Implement.** Token = 32 random bytes hex; store only `hashSecret(token)`; return plaintext once at approval.

- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add machine pairing service and routes"`.

### Task 2.7: Tunnel registry and WebSocket endpoint

**Files:**
- Create: `apps/hub/src/tunnel/registry.ts`, `apps/hub/src/tunnel/ws.ts`, `apps/hub/src/machines/routes.ts`
- Test: `apps/hub/test/unit/registry.test.ts`, `apps/hub/test/integration/tunnel.test.ts`

**Interfaces:**
- Produces: a shared test helper `startTestServer(deps): Promise<{ url, wsUrl, stop() }>` (in `apps/hub/test/helpers/server.ts`) that boots `buildApp` + the WS handler on an ephemeral port; tasks 2.7, 2.8, and 8.1 all reuse it. `Registry` with `add(machineId, conn)`, `remove(machineId)`, `get(machineId): Conn|null`, `Conn` = `{ send(frame): void; onResponse(id, handler): void; close(): void }`. WS handler at `/ws/agent`: on open expects a `hello` frame within 5s; validates the machine token (hash compare against `machine_tokens`, not revoked); on success registers the conn and replies `registered`; drives `ping` every 30s and drops after 2 missed `pong`; on `status` frame updates `machines.last_seen_at`/health; on close removes from registry. Machine routes: `GET /api/v1/machines`, `GET /api/v1/machines/:id`, `POST /api/v1/machines/:id/revoke` (all requireUser; revoke closes the live conn via registry).

- [ ] **Step 1: Failing unit test** — registry add/get/remove; get after remove is null. **Failing integration test** — start `buildApp` server on an ephemeral port, open a WS client, send an invalid token `hello` -> receive `error`; send a valid token `hello` (seed a machine+token first) -> receive `registered` and `registry.get(machineId)` is non-null.

- [ ] **Step 2: Implement** using Bun's native WebSocket in `Bun.serve` (Hono's `upgradeWebSocket` for Bun). Parse every inbound frame with `parseFrame`.

- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add tunnel registry and agent WebSocket endpoint"`.

### Task 2.8: Proxy — browser request to tunnel frames (incl. SSE streaming)

**Files:**
- Create: `apps/hub/src/tunnel/proxy.ts`, `apps/hub/src/proxy/routes.ts`
- Test: `apps/hub/test/integration/proxy.test.ts`

**Interfaces:**
- Consumes: registry, `requireUser`, `requireMachineOwnership`.
- Produces: `proxyRequest(conn, {method, path, headers, body}): Response` that generates a request `id`, sends `http_request`, assembles `response_begin` + `response_chunk*` + `response_end` into a streamed `Response` (a `ReadableStream` fed by chunk frames so SSE flows incrementally); on client disconnect sends `cancel`. Route: `ALL /api/v1/machines/:id/opencode/*` -> resolve conn from registry (503 `machine_offline` if absent) -> `proxyRequest`.

- [ ] **Step 1: Failing integration test** — stand up `buildApp`, connect a **fake agent** WS that answers `http_request` for path `/ping` with a begin+chunk("pong")+end, and for `/sse` with begin + 3 distinct chunks ("a","b","c") flushed one at a time (stream kept open until client cancels). Assert: authed browser `GET /api/v1/machines/:id/opencode/ping` returns 200 body "pong"; `GET .../opencode/sse` yields the chunks in order "a" then "b" then "c" as separate reads before the stream closes (assert content and ordering, NOT wall-clock timing, to avoid flakiness); unauthed request 401; offline machine 503.

- [ ] **Step 2: Implement** the stream assembly and cancel-on-disconnect.

- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add authenticated proxy with streaming SSE relay"`.

### Task 2.9: Server entry + static UI hosting + healthz + admin bootstrap

**Files:**
- Create: `apps/hub/src/index.ts`
- Modify: `apps/hub/src/app.ts` (serve built web assets; `GET /healthz`; `GET /pair` deep-link page hint)
- Test: `apps/hub/test/integration/healthz.test.ts`

**Interfaces:**
- Produces: `Bun.serve` bootstrapping `buildApp`, running migrations on start, creating the admin from env if set and absent, mounting the WS handler, and serving `apps/web` build output as static files with SPA fallback. `GET /healthz` returns 200 `{status:"ok"}`.

- [ ] **Step 1: Failing test** — `GET /healthz` returns 200.
- [ ] **Step 2: Implement** entry + static hosting + startup migration + admin bootstrap.
- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add hub server entry, static hosting, and health check"`.

---

## Phase 3: Agent

### Task 3.1: Agent config file (~/.mando.json, chmod 600)

**Files:**
- Create: `packages/agent/package.json`, `packages/agent/src/config.ts`
- Test: `packages/agent/test/unit/config.test.ts`

**Interfaces:**
- Produces: `readConfig(): AgentConfig|null`, `writeConfig(c): void` (mkdir, write, `chmodSync(path, 0o600)`), `AgentConfig = { hubUrl: string; token?: string; machineName: string }`. Path `~/.mando.json` (override via `MANDO_CONFIG` for tests).

- [ ] **Step 1: Failing test** — write then read returns same object; file mode is `0o600` (`statSync(path).mode & 0o777`).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** — `cd packages/agent && bun test`. Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add agent config file handling"`.

### Task 3.2: Reconnect backoff state machine

**Files:**
- Create: `packages/agent/src/reconnect.ts`
- Test: `packages/agent/test/unit/reconnect.test.ts`

**Interfaces:**
- Produces: `nextDelay(attempt): number` — exponential 1s base, cap 60s, full jitter; `attempt` 0-based. Pure function (jitter injected via optional `rand = Math.random` param for deterministic tests).

- [ ] **Step 1: Failing test** — `nextDelay(0, () => 0) === 1000`; `nextDelay(10, () => 1) === 60000` (capped); monotonic ceiling before cap.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add agent reconnect backoff"`.

### Task 3.3: Local opencode detection + request forwarding

**Files:**
- Create: `packages/agent/src/opencode.ts`, `packages/agent/src/forward.ts`
- Test: `packages/agent/test/unit/forward.test.ts`, `packages/agent/test/integration/forward.test.ts`

**Interfaces:**
- Produces: `detectOpencodePort(): Promise<number|null>` (probe `GET /doc` on 4096, then a small candidate list; overridable via `--opencode-port`); `checkHealth(port): Promise<boolean>`; `forward(frame: HttpRequestFrame, localBase: string, send: (f: Frame) => void, opts?: { opencodePassword?: string }): Promise<void>` — fetch local, emit `response_begin`, stream body as `response_chunk`s (base64), then `response_end`; on fetch failure emit `response_error`. If `opts.opencodePassword` is set (opencode started with `OPENCODE_SERVER_PASSWORD`), add an `Authorization: Basic` header (user `opencode`) to the local fetch. The password is read from the agent env `MANDO_OPENCODE_PASSWORD` and never leaves the machine.

- [ ] **Step 1: Failing integration test** — start a stub HTTP server that returns "pong" for `/ping` and an SSE stream for `/sse`; call `forward` and collect emitted frames; assert begin+chunk("pong")+end for `/ping` and begin+multiple-chunks for `/sse`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add opencode detection and request forwarding"`.

### Task 3.4: Connect command + daemon lifecycle

**Files:**
- Create: `packages/agent/src/connect.ts`, `packages/agent/src/daemon.ts`, `packages/agent/src/index.ts`
- Test: `packages/agent/test/integration/connect.test.ts`

**Interfaces:**
- Consumes: config, reconnect, forward, protocol.
- Produces: CLI dispatch for `connect|disconnect|status|install-command`; `connect(opts)`:
  1. read config; if no token, `POST /api/v1/pairing/request` -> print `{status:"pairing", code, deepLink, uiUrl}` (JSON when `--json`), then poll `/api/v1/pairing/status` until approved, store token.
  2. detect opencode port (or `--opencode-port`); fork a detached daemon (`daemon.ts`) that opens the WS, sends `hello`, runs the forward loop with reconnect, writes a pidfile, and exits when the local opencode server disappears (poll health; on N consecutive failures, exit).
  3. print `{status:"connected", machine, uiUrl}` and return (parent exits fast).
  `disconnect()` reads pidfile and kills the daemon. `status()` prints connection + last-seen.

- [ ] **Step 1: Failing integration test** — spin up `buildApp` hub + Postgres + a stub opencode; run `connect` against it with a pre-seeded token (skip pairing); assert the hub registry shows the machine online within 2s and a proxied `/ping` returns "pong"; then `disconnect` and assert it goes offline.
- [ ] **Step 2: Implement** daemonization via `Bun.spawn` with `{ detached: true, stdio: ["ignore","ignore","ignore"] }` AND call `proc.unref()` so the parent can exit before the child (per Bun docs, `detached` alone does not release the parent). Write a pidfile at `~/.mando-pid`.
- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add agent connect, daemon, and lifecycle commands"`.

### Task 3.5: install-command + single-binary build

**Files:**
- Create: `packages/agent/src/install-command.ts`
- Modify: `packages/agent/package.json` (add `build:binary`)
- Test: `packages/agent/test/unit/install-command.test.ts`

**Interfaces:**
- Produces: `installCommand(): string` — writes `~/.config/opencode/commands/mando.md` (override dir via `OPENCODE_CONFIG_DIR`) with the `/mando` template, returns the path. `bun build --compile` target producing `dist/mando` per platform.

- [ ] **Step 1: Failing test** — after `installCommand()`, the file exists and contains the `!` + backtick + `mando connect --opencode-auto --json $ARGUMENTS` line.
- [ ] **Step 2: Implement** writer + add `"build:binary": "bun build --compile src/index.ts --outfile dist/mando"`.
- [ ] **Step 3: Run** — Expected: PASS. Also run `bun run build:binary && ./dist/mando status` to confirm the binary works.
- [ ] **Step 4: Commit** — `git commit -m "Add opencode command installer and binary build"`.

---

## Phase 4: /mando command asset

### Task 4.1: Ship the command template package

**Files:**
- Create: `packages/opencode-plugin/commands/mando.md`, `packages/opencode-plugin/package.json`
- Test: `packages/opencode-plugin/test/command.test.ts`

**Interfaces:**
- Produces: the canonical `mando.md` (source of truth that `install-command` mirrors), asserted to contain the shell-injection line and `$ARGUMENTS`.

- [ ] **Step 1: Failing test** — read `commands/mando.md`, assert it contains ``!`mando connect --opencode-auto --json $ARGUMENTS` `` and a `description:` frontmatter key.
- [ ] **Step 2: Create the file** (content exactly as in the spec's /mando section).
- [ ] **Step 3: Run** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add /mando opencode command template"`.

---

## Phase 5: Web UI refactor to hub

### Task 5.0: Convert web to a static SPA build (remove Nitro)

**Files:**
- Modify: `apps/web/vite.config.ts` (remove the `nitro({preset:"bun"})` plugin), `apps/web/package.json` (build outputs static assets; drop the `.output/server` preview, add a static `preview`)
- Modify: `apps/web/tsconfig`/router config as needed for SPA mode (TanStack Router file-based routing works in SPA/CSR mode without a server)

**Interfaces:**
- Produces: `bun run --filter @mando/web build` emits a static asset directory (`apps/web/dist/`) with an `index.html` SPA entry, consumed by the hub (Task 2.9) and Docker build (Task 6.1). No server bundle.

- [ ] **Step 1:** Remove the Nitro plugin from `vite.config.ts`; set Vite `build.outDir` to `dist`. If any current route relies on a Nitro server handler, note it — those are local-mode server routes slated for removal in Task 5.2; stub or move their logic to the hub API before deleting.
- [ ] **Step 2:** Run `bun run --filter @mando/web build`; assert `apps/web/dist/index.html` exists and no `.output/server` is produced.
- [ ] **Step 3:** Run `bun run typecheck`. Expected: pass.
- [ ] **Step 4:** Commit — `git commit -m "Convert web to static SPA build"`.

### Task 5.1: Hub API client

**Files:**
- Create: `apps/web/src/lib/hub-client.ts`
- Test: `apps/web/test/hub-client.test.ts`

**Interfaces:**
- Produces: `HubClient` with `login`, `logout`, `me`, `listMachines`, `approvePairing(code)`, `revokeMachine(id)`, and `opencode(machineId): { fetch(path, init), events(path): EventSource }` that target `/api/v1/machines/:id/opencode/*`. All calls credential-included (cookie).

- [ ] **Step 1: Failing test** — with a mocked `fetch`, `listMachines()` GETs `/api/v1/machines` and returns parsed JSON; `opencode(id).fetch("/session")` targets the proxied path.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** — `cd apps/web && bun test`. Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "Add web hub API client"`.

### Task 5.2: Switch UI data source from local mode to hub

**Files:**
- Modify: `apps/web/src/**` — replace the local `~/.mando.json` + process-spawning server data source with `HubClient`; add a machine picker (list, online/offline/degraded badge) and a pairing-approval view; wire the existing session view to `opencode(machineId)`.
- Remove: local-mode server routes under `apps/web/src/server/**` that spawn processes or read local config, once hub mode is proven by E2E (Phase 8). Keep them until then.

**Interfaces:**
- Consumes: `HubClient`.
- Produces: a UI where selecting a machine drives its opencode through the hub. No local process control remains in the shipped build.

- [ ] **Step 1:** Add machine-picker + pairing-approval components with a failing component test (render machine list from a stubbed `HubClient`, assert online badge).
- [ ] **Step 2:** Implement components; point the session view at `opencode(machineId)`.
- [ ] **Step 3:** Run component tests + `bun run typecheck`. Expected: PASS.
- [ ] **Step 4:** Commit — `git commit -m "Switch web UI data source to hub"`.
- [ ] **Step 5 (after Phase 8 passes):** delete dead local-mode server routes; commit — `git commit -m "Remove local-mode server routes"`.

---

## Phase 6: Deployment

### Task 6.1: Dockerfile and compose build

**Files:**
- Create: `deploy/Dockerfile`
- Modify: `deploy/docker-compose.yml` (already references it)
- Test: manual — `docker compose -f deploy/docker-compose.yml up --build` then `curl localhost:8080/healthz`.

**Interfaces:**
- Produces: multi-stage image: stage 1 `oven/bun` builds web (`bun run --filter @mando/web build`) and installs hub deps; final stage copies hub src + web build, runs as non-root `bun` user, `HEALTHCHECK` hitting `/healthz`, `CMD bun run apps/hub/src/index.ts`.

- [ ] **Step 1:** Write the Dockerfile.
- [ ] **Step 2:** `docker compose up --build`; wait for healthy; `curl -sf localhost:8080/healthz`. Expected: `{"status":"ok"}`.
- [ ] **Step 3:** Commit — `git commit -m "Add Dockerfile and compose build"`.

### Task 6.2: Kubernetes manifests

**Files:**
- Create: `deploy/k8s/deployment.yaml`, `service.yaml`, `ingress.example.yaml`, `secret.example.yaml`
- Test: `kubectl apply --dry-run=client -f deploy/k8s/` and `kubeconform` if available.

**Interfaces:**
- Produces: Deployment (resource requests+limits, readiness `/healthz`, liveness `/healthz`, non-root securityContext, `app.kubernetes.io/{name,component,version}` labels, `DATABASE_URL`/`COOKIE_SECRET` from Secret), Service (ClusterIP), example Ingress (TLS annotation placeholder), example Secret.

- [ ] **Step 1:** Write manifests per `~/.claude/rules/kubernetes.md`.
- [ ] **Step 2:** `kubectl apply --dry-run=client -f deploy/k8s/`. Expected: all valid.
- [ ] **Step 3:** Commit — `git commit -m "Add Kubernetes deployment manifests"`.

---

## Phase 7: Documentation

### Task 7.1: README for all audiences

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces: a README that opens with a one-paragraph plain-language "what this is and why", then a "Try it in 5 minutes" quickstart (docker compose up, open URL, run `/mando`), then sections that deepen progressively: How it works (with the ASCII diagram), Install the agent, The /mando command, Configuration (env vars table), Deploying (compose + k8s), Security model, Development, Testing. Plain language up front; precise technical detail lower down; every command copy-pasteable. No statement about who the audience is. No emojis. No reference to any other project.

- [ ] **Step 1:** Write the README.
- [ ] **Step 2:** Invoke the doc-reviewer agent for multi-audience readability + accuracy; apply fixes.
- [ ] **Step 3:** Commit — `git commit -m "Rewrite README"`.

### Task 7.2: AGENTS.md — project conventions and workflow

**Files:**
- Create: `AGENTS.md`

**Interfaces:**
- Produces: contributor+agent guide covering: project overview and package map; the golden rules (TypeScript only, Postgres only, no prior-project references, no emojis, TDD, per-task commits, runtime-validate every frame, multi-tenant ownership checks); how to run (install, compose up postgres, migrate, dev, test unit/integration/e2e, typecheck); testing philosophy (pyramid, a feature needs all three layers); commit/PR conventions (single-line messages, no co-author, no session URLs); adding a new frame type checklist (schema in protocol + both-side handlers + tests); security rules (argon2id, chmod 600 token file, never log secrets); how to extend (new API route, new agent command). Kept lean and current.

- [ ] **Step 1:** Write `AGENTS.md`.
- [ ] **Step 2:** Commit — `git commit -m "Add AGENTS.md"`.

---

## Phase 8: Playwright E2E

### Task 8.1: E2E harness + stub opencode

**Files:**
- Create: `e2e/playwright.config.ts`, `e2e/fixtures/stub-opencode.ts`, `package.json` e2e scripts
- Test: harness self-check.

**Interfaces:**
- Produces: a Playwright config whose globalSetup uses Postgres via `TEST_DATABASE_URL` if set (CI provides it as a service container) and otherwise runs `docker compose -f deploy/docker-compose.yml up -d postgres` locally — one source of truth, no port collision between CI's service container and a compose instance. It then runs migrations, starts the hub, starts a stub opencode server, and runs a real `mando connect` (pre-seeded token) so a machine is online; `baseURL` = hub. Stub opencode answers the handful of endpoints the UI calls (session list/create, message, `/event` SSE).

- [ ] **Step 1:** Implement config + stub + globalSetup/teardown.
- [ ] **Step 2:** `bunx playwright test --list`. Expected: config loads.
- [ ] **Step 3:** Commit — `git commit -m "Add Playwright E2E harness"`.

### Task 8.2: E2E specs

**Files:**
- Create: `e2e/tests/auth.spec.ts`, `pairing.spec.ts`, `machines.spec.ts`, `session-drive.spec.ts`, `isolation.spec.ts`

**Interfaces:**
- Produces browser tests:
  - `auth`: login success/failure, logout, protected route redirects to login.
  - `pairing`: agent requests code (via test helper), user approves in UI (code entry + deep-link `/pair?code=`), machine appears online.
  - `machines`: online/offline/degraded badges reflect tunnel state (kill stub -> degraded; stop agent -> offline); revoke removes it and closes tunnel.
  - `session-drive`: select machine, create a session, send a prompt, assert streamed SSE output renders incrementally in the UI.
  - `isolation`: user B logs in and never sees user A's machine; direct navigation to A's machine id shows not-found.

- [ ] **Step 1:** Write specs (failing until UI wired — they validate Phase 5).
- [ ] **Step 2:** `bunx playwright test`. Expected: all PASS (headless).
- [ ] **Step 3:** Commit — `git commit -m "Add Playwright E2E specs"`.

### Task 8.3: CI wiring

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI that on push runs `bun install`, spins Postgres as a service container and exports its URL as `TEST_DATABASE_URL` (which both `bun test` integration suites and Playwright globalSetup read — globalSetup skips its local compose when this is set), `bun run typecheck`, unit+integration `bun test`, then Playwright E2E (headless), uploading traces/screenshots on failure.

- [ ] **Step 1:** Write workflow.
- [ ] **Step 2:** Validate YAML (`actionlint` if available) / dry review.
- [ ] **Step 3:** Commit — `git commit -m "Add CI workflow"`.

---

## Self-Review (completed against spec)

- Spec coverage: hosting/deployment (Phase 6), clean-room tunnel (Phase 1 + 2.7/2.8), Postgres (2.1-2.2), multi-tenant auth + pairing (2.3-2.6), session-scoped agent (3.4), /mando /rc parity (3.5 + 4.1), streaming SSE (2.8 + 3.3), error handling (2.7 liveness, 2.8 503, 3.2 backoff), README all-audience (7.1), AGENTS.md (7.2), full test pyramid incl. Playwright (unit/integration throughout + Phase 8), base-code health (Phase 0). Cross-tenant isolation covered at integration (2.4/2.8) and E2E (8.2). No gaps found.
- Placeholder scan: Tasks 2.4-2.6, 5.2 describe test assertions in prose rather than full code blocks to keep the plan readable; every such task names exact assertions, files, and interfaces. Implementer writes the test from the stated assertions (TDD step 1). Flagged intentionally.
- Type consistency: `Frame`, `parseFrame`/`serializeFrame`, `Registry.get`, `Conn.send`, `proxyRequest`, `HubClient.opencode` names are used consistently across producer/consumer tasks.

## Rollback / Risk

All new code in an unpushed repo — rollback is git. Highest risk: Phase 5 web refactor (local-mode assumptions spread through server routes); mitigated by keeping local mode until E2E (Phase 8) proves hub mode, then deleting it in 5.2 Step 5.
