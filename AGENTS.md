# AGENTS.md

Guide for contributors (human or AI agent) working in this repository. Keep it
accurate and lean — update it in the same commit as any change that makes a
section below stale.

## Project overview

OpenCode Mando lets you drive an opencode coding session from somewhere other
than the machine it's running on. A small server (the "hub") hosts a web
interface and a database; a small agent process runs on the machine that has
opencode and dials out to the hub over a persistent WebSocket ("tunnel").
The browser talks to the hub, the hub relays requests over the tunnel to the
agent, and the agent forwards them to the local opencode server — so the
browser can watch and steer a session without opencode itself ever being
exposed to the network.

### Package map

| Path | Contents |
|---|---|
| `apps/hub` | `@mando/hub`. Bun + Hono server: REST/SSE API, the `/ws/agent` WebSocket tunnel endpoint, session auth, pairing, the tunnel registry (in-memory table of live agent connections) and proxy, PostgreSQL data layer (`postgres.js`), migrations (`apps/hub/migrations/`). Serves the built web SPA as static files plus an SPA fallback. `buildApp(deps)` in `src/app.ts` is the single place the Hono app is constructed — both `src/index.ts` and every integration test use it. |
| `apps/web` | `@mando/web`. Static SPA (React 19 + Vite + TanStack Router), served by the hub in production. Talks to the hub via `HubClient` in `src/lib/hub-client.ts`. |
| `packages/agent` | `@mando/agent`. The `mando` CLI: `connect` / `disconnect` / `status` / `install-command`, a session-scoped background daemon that holds the tunnel open, and local opencode health/forwarding. Config lives in `~/.mando.json`. Compiles to a standalone binary via `bun build --compile`. |
| `packages/protocol` | `@mando/protocol`. Shared Zod schemas for every tunnel frame (`src/frames.ts`) plus `parseFrame` / `serializeFrame`. The hub and the agent both depend on this — it is the only source of truth for the wire format. |
| `packages/opencode-plugin` | `@mando/opencode-plugin`. The `/mando` opencode slash-command template (`commands/mando.md`), installed into a user's opencode config by `mando install-command`. |
| `deploy` | `Dockerfile`, `docker-compose.yml` (hub + `postgres:17`, host port `5433`), and `k8s/` manifests (Deployment pinned to 1 replica, Service, NetworkPolicy, ServiceAccount, example Secret/Ingress). |

## Golden rules

- **TypeScript only.** No plain JavaScript source files.
- **PostgreSQL only.** No SQLite, no other datastore. Migrations live in
  `apps/hub/migrations/` as plain numbered `.sql` files, applied via
  `apps/hub/src/db/migrate.ts`.
- **Every tunnel frame is Zod-validated on both sides**, using the schemas in
  `@mando/protocol` (`packages/protocol/src/frames.ts`). Never hand-construct
  or hand-parse a frame; always go through `parseFrame` / `serializeFrame`.
- **The web talks to opencode's UNPREFIXED API family only.** opencode
  (1.17.13) exposes two parallel endpoint families on the same server, backed
  by different stores. The `/api/*` family only serves sessions created
  through the server API; sessions from a plain `opencode` TUI, `opencode
  run`, or `opencode attach` are served EXCLUSIVELY by the unprefixed family
  (`GET /session?directory=`, `GET/POST /session/:id/message`, `POST
  /session/:id/abort`, `GET /session/status`, `GET /event` — SSE payloads
  under `properties`, not `data`). Regressing any web call to `/api/*`
  reintroduces the v1.0.0 bug where a user's terminal session listed but
  showed no messages; the e2e stub answers `/api/*` session/event paths with
  404 on purpose so such a regression fails tests loudly. Two verified
  contract quirks: `directory` on `POST /session` must be a QUERY param (a
  body field is silently ignored), and `POST /session/:id/message` without
  `noReply: true` synchronously attempts an assistant reply (harness code
  must always pass `noReply: true`).
- **Multi-tenant ownership checks on every machine-scoped route.** Any route
  under `/api/v1/machines/:id/...` must run `requireUser` then
  `requireMachineOwnership` (see `apps/hub/src/auth/middleware.ts`), which
  enforces `machine.user_id === session.userId` and folds "not yours" and
  "doesn't exist" into the same 404 so ownership can't be probed.
- **Secrets are hashed at rest, never stored or logged in plaintext.**
  - User passwords and machine tokens both use argon2id via `Bun.password`
    (`apps/hub/src/auth/password.ts`).
  - A machine token is `<tokenId>.<secret>`; only `hash(secret)` is stored
    (`machine_tokens.token_hash`), looked up in O(1) by the indexed `tokenId`
    instead of scanning and re-hashing every live token.
  - Login uses a precomputed dummy argon2id hash (`DUMMY_HASH`) when an email
    doesn't match a user, so a missing account and a wrong password take the
    same amount of time.
- **No emojis** anywhere — code, comments, docs, commit messages, CLI output.
- **Commits:** single-line message, no co-author trailer, no session/URL
  trailers, one commit per logical change.
- **TDD:** write the failing test first, then the implementation.
- **No references to any prior project or author** in code, comments, or docs.

## How to run

```bash
bun install                                              # once, from repo root

# Start Postgres (host port 5433; matches TEST_DATABASE_URL below)
docker compose -f deploy/docker-compose.yml up -d postgres

cd apps/hub
bun run migrate                                          # apply apps/hub/migrations/
bun run dev                                               # hub, --hot, from apps/hub

cd ../web
bun run dev                                               # web SPA (Vite dev server)
```

From the repo root, everything runs through Turborepo:

```bash
bun run typecheck    # tsc --noEmit in every package
bun run build         # build every package (e.g. web's `vite build`)
bun run test          # bun test in every package
```

Testing needs a real Postgres instance for the hub's (and agent's) integration
tests:

```bash
docker compose -f deploy/docker-compose.yml up -d postgres
bun run test --filter @mando/hub
```

Integration tests default to `TEST_DATABASE_URL=postgres://mando:mando@localhost:5433/mando`,
which matches the port Docker Compose publishes — set `TEST_DATABASE_URL` to
override.

Browser end-to-end tests live in `e2e/` (its own package, not a workspace
member). Always run them from inside `e2e/`:

```bash
cd e2e
bunx playwright test                                    # default suite (stub opencode)
bunx playwright test --config playwright.real.config.ts # gated suite (real opencode binary required)
```

The default suite boots the full stack (real hub, real agent daemon, built
web SPA) against a faithful stub opencode server. The gated suite swaps ONLY
the stub for a real `opencode serve` and proves the terminal-session handoff
end to end; CI runs both on every push (`.github/workflows/ci.yml`, jobs
`test` and `e2e-real-opencode`).

## Testing philosophy

Every non-trivial feature needs coverage at all the layers it touches before
it's considered done:

1. **Unit** — individual functions/modules in isolation (e.g. the agent's
   port detection and reconnect backoff, the hub's password hashing and
   pairing-code generation, protocol frame validation). No I/O.
2. **Integration** — real components together, against a real PostgreSQL
   database and real HTTP/WebSocket requests. The hub's suite
   (`apps/hub/test/integration/`) includes tests that boot a real server,
   connect a simulated agent over a real WebSocket, and confirm a request
   through the proxy API is relayed to that agent and back — exercising the
   full pairing-to-proxy path without mocking any layer of it.
3. **End-to-end (browser)** — Playwright driving the actual web SPA against a
   running hub. Implemented — see `e2e/` and the two suites described above.

A feature isn't done until every layer that covers it passes — a green unit
suite with a stubbed integration point is not sufficient for anything that
touches the hub's HTTP/WS surface or the tunnel protocol.

## Architecture in brief

```
   browser              hub (Postgres)              machine's mando agent
+------------+  REST/SSE   +---------+   outbound WSS   +------------------+
|    web     | <---------> |   hub   | <--------------> |  mando agent     |
| (this SPA) |  /ws/agent  | (Hono)  |   (tunnel)        |   -> opencode    |
+------------+             +---------+                   |      (localhost)|
                                                            +------------------+
```

- The hub is the only server that accepts inbound connections. It hosts the
  web SPA, the REST/SSE API, and the `/ws/agent` tunnel endpoint.
- The agent's connection to the hub is always outbound (dial-out); the agent
  never listens for inbound connections and opencode is never publicly
  addressable — it only talks to the agent over `localhost`.
- The hub tracks live tunnel connections in an in-memory `Registry`
  (`apps/hub/src/tunnel/registry.ts`), so the current deployment is pinned to
  a **single hub replica** — the Kubernetes manifests in `deploy/k8s` reflect
  this. Scaling to multiple replicas requires a shared pub/sub (or
  equivalent) for connection state; don't add a second replica without that.
- **The daemon is started by re-executing the mando binary itself** with a
  hidden `_daemon` argv (`packages/agent/src/index.ts` dispatch,
  `connect.ts`'s `defaultSpawnDaemon`). Never spawn `bun daemon.ts` from
  `connect`: in a `bun build --compile` binary `import.meta.dir` is a
  virtual `/$bunfs/...` path with no file on disk, so that spawn dies
  silently (the original v1.0.0 bug — `connect` printed "Connected" while
  no daemon ran). `packages/agent/test/compiled-binary.test.ts` builds and
  runs the real compiled artifact to keep this honest.
- **`connectDirectory` is the session-list scoping spine** (parity with
  Claude Code's `/rc`: show what the user is working on right now, not an
  archive). `mando connect` captures
  its cwd, passes it to the daemon (`--connect-dir`), the daemon includes it
  in the hello frame (optional field — old hubs strip it, no protocol
  bump), the hub persists it (`machines.connect_directory`, migration 004)
  and exposes it on `GET /api/v1/machines`; the web scopes the session list
  to it (`GET /session?directory=`) and pins the newest session as LIVE.
  The web-side `Machine` type in `apps/web/src/lib/hub-client.ts` mirrors
  `serializeMachine()` by hand — keep them in sync.

## Adding a new tunnel frame type

1. Add the Zod schema for the new frame to `packages/protocol/src/frames.ts`
   and add it to the `FrameSchema` discriminated union.
2. Handle it on the hub side — typically in `apps/hub/src/tunnel/ws.ts`
   (dispatch) and, if it carries a proxied request/response, in
   `apps/hub/src/tunnel/proxy.ts`.
3. Handle it on the agent side — `packages/agent/src/daemon.ts`.
4. Add unit tests in `packages/protocol/test/` for the schema, and
   integration/unit tests on whichever side(s) now handle the new frame.

Both sides always go through `parseFrame`/`serializeFrame`; a frame that
doesn't validate against `FrameSchema` must never reach handler logic.

## Security rules

- Passwords and machine tokens: argon2id via `Bun.password` (`hashSecret` /
  `verifySecret` in `apps/hub/src/auth/password.ts`). Never a weaker hash,
  never plaintext comparison.
- `~/.mando.json` (the agent's config, holding the machine token) is written
  with mode `0o600` — see `packages/agent/src/config.ts`. Don't relax that.
- Never log secrets: machine tokens, `MANDO_OPENCODE_PASSWORD`, session
  cookies, `COOKIE_SECRET`, `DATABASE_URL`.
- Pairing tokens/machine tokens are revocable — revoking a machine
  (`POST /api/v1/machines/:id/revoke`) must drop any live tunnel immediately,
  not just block future connections.
- The hub must sit behind TLS (and ideally a private network / Tailscale-style
  overlay) in any real deployment; whatever proxies it must forward WebSocket
  upgrades through to `/ws/agent` unmodified. opencode itself must never be
  bound to a public interface — it only ever talks to the local agent over
  `localhost`.

## How to extend

**Adding a hub API route:**
1. Add the handler in the relevant `apps/hub/src/<area>/routes.ts` (or a new
   area following the same `routes.ts` + `repo.ts` split used by
   `users/`, `pairing/`, `machines/`).
2. Apply `requireUser(sql)` for anything that needs a logged-in user, and
   `requireMachineOwnership(sql)` for anything scoped to `:id` under
   `/api/v1/machines/:id/...`.
3. Zod-validate the request body/params before touching the database.
4. Mount the router in `buildApp` (`apps/hub/src/app.ts`).
5. Add integration tests under `apps/hub/test/integration/`.

**Adding an agent CLI command:**
1. Implement the command's logic in its own module in `packages/agent/src/`
   (following the pattern of `connect.ts` / `disconnect` in `index.ts` /
   `status`).
2. Wire it into the `switch` in `main()` in `packages/agent/src/index.ts`,
   parsing any new flags in `parseArgs`.
3. Support `--json` output alongside human-readable output, matching the
   existing commands (`printResult`).
4. Add unit tests under `packages/agent/test/unit/` (and integration tests
   under `packages/agent/test/integration/` if it talks to a real hub or
   opencode server).
