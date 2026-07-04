# OpenCode Mando — Remote Control Architecture

Date: 2026-07-04
Status: Approved pending user review
Scope: Hosted hub + reverse tunnel + /mando opencode command

## Problem

OpenCode Mando currently runs web UI and opencode on the same machine. The goal is the Claude Code "remote control" experience for opencode: the Mando UI runs on a public server (Docker Compose or Kubernetes), and any developer machine running opencode can register itself with a `/mando` slash command and be driven from a browser anywhere, with no inbound ports, port forwarding, or VPN on the developer machine.

The tunnel follows the well-known ngrok-style reverse pattern: the machine dials out over WSS, requests are relayed as JSON envelopes, and a registry tracks live tunnels. All tunnel code is written from scratch for this project.

## Decisions (from brainstorming, 2026-07-04)

| Decision | Choice |
|---|---|
| Hosting | Public VPS + domain, TLS at reverse proxy/ingress |
| Tunnel approach | ngrok-style reverse tunnel, written from scratch in TypeScript |
| Stack | TypeScript/Bun everywhere (Approach A: evolve monorepo, new packages written fresh) |
| Auth | Multi-tenant: user accounts (password v1, OIDC-ready) + per-machine pairing flow with revocable machine tokens |
| Agent lifecycle | Session-scoped: tunnel agent lives while the local opencode server lives |
| Tenancy | Multi-tenant from day one (fleet ambition) |
| Database | PostgreSQL from day one (user decision — no SQLite) |
| /mando UX | Parity with Claude Code /rc: pairing code + deep link when unpaired; direct machine URL when paired; arguments pass through (/mando status, /mando stop) |

## Key architectural property

Tunneled services are never publicly addressable. The only consumer of a tunneled opencode API is Mando's own UI, so there are no per-machine subdomains, no wildcard DNS/TLS. The browser talks only to the hub; the hub proxies over tunnels that machines dialed out:

```
Browser -> hub REST/SSE -> WSS tunnel (outbound from machine) -> localhost:4096 (opencode serve)
```

## Architecture

```
                mando.<domain> (VPS, TLS via reverse proxy)
               +--------------------------------------------+
Browser -----> |  hub (one Bun process, one Docker image)   |
               |   - serves web UI (static build)           |
               |   - REST API /api/v1/* (session auth)      |
               |   - WS agent endpoint /ws/agent            |
               |   - PostgreSQL: users, machines, tokens,   |
               |     pairing requests                       |
               +---------------------+----------------------+
                                     | outbound WSS only
                          +----------+-----------+
                          |                      |
                    mando agent            mando agent
                    (laptop)               (server)
                          |                      |
                    localhost:4096         localhost:4096
                    (opencode serve)       (opencode serve)
```

## Components (monorepo)

| Package | Role |
|---|---|
| `apps/hub` | NEW, multi-tenant from line one. Bun + Hono. Static UI hosting, REST API, WS tunnel endpoint, auth, machine registry, proxy. PostgreSQL behind a thin storage interface. |
| `apps/web` | Existing UI refactored: data layer switches from local `~/.mando.json` + process spawning to hub API (list my machines, drive selected machine through hub proxy). Session view, SSE handling, message rendering reused. |
| `packages/agent` | Existing `mando` CLI grows `connect`, `disconnect`, `status`, `install-command`. Compiled per platform with `bun build --compile` into a single static binary. |
| `packages/protocol` | Shared Zod schemas + TS types for all tunnel frames. Imported by hub and agent; runtime-validated on both ends. |
| `packages/opencode-plugin` | `/mando` command file (markdown, installed by `mando install-command`); optional npm plugin later. Thin shell-out to the CLI. |

## Database (PostgreSQL)

- Client: Bun native `Bun.sql` or `postgres.js` (decided at implementation start; both Bun-compatible).
- Migrations: SQL migration files (Drizzle optional if typed queries are wanted).
- Tables (v1): `users` (id, email, password_hash argon2id, created_at), `sessions` (browser sessions), `machines` (id, user_id, name, platform, last_seen_at, revoked_at), `machine_tokens` (hashed at rest, machine_id, created_at, revoked_at), `pairing_requests` (code, machine metadata, user binding on approval, expires_at, consumed_at).
- Tunnel liveness registry stays in-memory in the hub process (single replica v1); Postgres holds durable state only. Horizontal scaling later requires shared pub/sub (NATS/Redis) — out of scope, interface-isolated.

## Tunnel protocol

JSON text frames over WSS, every frame `{type, id, payload}`. Deliberate upgrade over the buffered-envelope model: responses stream in chunks (required for opencode SSE `/event` and incremental session output).

- Registration: agent -> `hello` (machine token, machine name, opencode port, agent version); hub -> `registered` or `error` (e.g. `token_revoked`).
- Proxying: hub -> `http_request` (method, path, headers, base64 body); agent -> `response_begin` (status, headers) -> `response_chunk` (base64, repeated) -> `response_end` | `response_error`.
- Streams: multiple in-flight requests multiplex over one socket by `id`. SSE is a response whose chunks keep flowing; browser disconnect triggers hub -> `cancel` for that id.
- Liveness: `ping`/`pong` every 30s; hub drops tunnels missing 2 pings. Read limit 16 MB per frame.
- Status: agent -> `status` frames (opencode healthy/unhealthy) drive machine health in the UI.

## Auth and multi-tenancy

Two credential planes:

1. Users (browser): email + argon2id password, httpOnly/secure/SameSite=Lax session cookie. Invite-only registration. Bootstrap admin via `MANDO_ADMIN_EMAIL`/`MANDO_ADMIN_PASSWORD` env or `hub bootstrap`. Middleware is OIDC-ready — an IdP later is a new login route, not a redesign.
2. Machines (tunnel): pairing flow. `mando connect` without a token requests a pairing code, prints an 8-char code + deep link `https://mando.<domain>/pair?code=...`. User approves in UI (Machines -> Approve). Hub issues a long-lived machine token (hashed at rest, user-scoped, revocable per machine in UI). Token stored in `~/.mando.json` (chmod 600).

Isolation: one middleware on every `/api/v1/machines/:id/*` route asserts `machine.user_id === session.user_id`. Explicit cross-tenant test required.

Revocation: revoking a token immediately closes the live WS tunnel.

## /mando command (Claude Code /rc parity)

Installed by `mando install-command` as `~/.config/opencode/commands/mando.md`:

```markdown
---
description: Connect this machine to Mando remote control
---
Report the result of connecting to Mando: !`mando connect --opencode-auto --json $ARGUMENTS`
```

Behavior (verified against opencode docs: command shell injection via !`cmd`, global commands dir, $ARGUMENTS):

- Unpaired: prints pairing code + deep link; agent daemonizes and waits for approval.
- Paired: replies with the direct URL to this machine in the UI (instant handoff, like /rc).
- `/mando status`, `/mando stop` pass through as CLI arguments.
- `mando connect` self-daemonizes: detects the local running opencode server port, forks a detached agent, prints JSON, exits fast (shell injection stays snappy). Daemon exits when the local opencode server stops (session-scoped). `mando disconnect` kills it explicitly.

## Deployment

- One `Dockerfile` (multi-stage: build web -> hub image; minimal final stage, non-root, HEALTHCHECK /healthz).
- `docker-compose.yml`: `hub` + `postgres:17` (volume, healthcheck, `DATABASE_URL`).
- `deploy/k8s/`: plain manifests — Deployment (requests/limits, liveness/readiness probes, non-root, `app.kubernetes.io/*` labels), Service, example Ingress, Secret refs. Postgres via managed instance or CloudNativePG; hub stays stateless.
- TLS terminates at reverse proxy/ingress (Traefik/Caddy — deploy-time choice); hub speaks plain HTTP/WS behind it.

## Error handling

- Agent reconnect: exponential backoff 1s -> 60s cap with jitter.
- opencode unreachable locally: agent sends `unhealthy` status; UI shows degraded, not vanished.
- Request to offline machine: `503 machine_offline`; UI renders "offline — run /mando on that machine".
- Per-request timeout 120s (SSE exempt). Tunnel death fails in-flight requests fast with `response_error`.
- Pairing codes: 10 min expiry, single use.

## Testing

Test pyramid — unit, integration, and browser E2E are all required; a feature is not done until all three layers covering it pass.

- Unit (bun test): `packages/protocol` frame schemas (valid/invalid/roundtrip); `packages/agent` backoff/reconnect, daemon lifecycle state machine, config read/write; `apps/hub` pure logic (pairing code generation/expiry, token hashing, subdomain-free routing table).
- Integration (bun test against real services): `apps/hub` with real Postgres (compose service): auth flows, pairing lifecycle, token revocation closes live tunnel, ownership isolation (user B cannot access user A's machine — explicit), proxy correctness including chunked SSE relay against a fake agent; `packages/agent` e2e: fake hub <-> real agent <-> stub opencode server.
- Browser E2E (Playwright, against the real stack: compose up hub + Postgres + a real agent + stub opencode server): login/logout; invite-only registration; pairing approval flow end to end (code entry and deep link); machines list shows online/offline/degraded states; driving a session through the proxied UI including live SSE output rendering; token revocation reflected in UI; cross-tenant isolation at the UI level (user B never sees user A's machines).
- CI: unit + integration on every push; Playwright E2E suite on every push (headless), with traces/screenshots uploaded on failure.

## Non-goals (v1)

- No OIDC integration (design-ready only). No public self-serve registration.
- No horizontal hub scaling (single replica; registry in-memory).
- No persistent machine daemon (session-scoped only; `--persist` is future work).
- No npm-published opencode plugin (command file first).
- No support for driving Codex/Claude backends remotely (the codebase contains multi-provider client code for Codex/Claude; v1 targets opencode only — revisit later as product direction).
- No mobile app; the web UI is the mobile surface.

## Open questions (carried to implementation planning)

1. Hub HTTP framework detail: Hono vs Nitro reuse — pick at plan time after checking Bun WS ergonomics in each.
2. `Bun.sql` vs `postgres.js` client choice.
3. Whether apps/web keeps its Nitro server layer or is built purely static once local-mode code is removed (local single-machine mode may remain as a dev convenience).

## Rollback / risk

Everything is new code in a repo not yet pushed; rollback is git. The riskiest refactor is apps/web's data layer (local-mode assumptions spread through server routes) — mitigated by keeping local mode working until hub mode passes e2e.
