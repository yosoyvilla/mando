## Summary
Reviewed the GDPR/CCPA erasure + retention + audit-log spec (users/machines/pairing DELETE-cascade erasure, hourly runRetention sweep, append-only audit_log migration 003) against the actual mando hub source. Core mechanics check out against the real code; two implementation details need adjusting before coding starts.

## Verdict: APPROVED WITH NOTES

## Done
- Confirmed `Registry.get/remove/close` API (`apps/hub/src/tunnel/registry.ts`) matches the plan's usage.
- Confirmed `apps/hub/src/machines/routes.ts:44-50` revoke handler's ordering is **remove-from-registry, then close()** — the comment there explains why (avoids a concurrent request observing a not-yet-removed conn during async socket teardown). Erasure's tunnel-close step must copy this exact order, not close-then-remove.
- Confirmed FK cascade behavior directly in `apps/hub/migrations/001_init.sql`: `user_sessions.user_id`, `machines.user_id`, and `pairing_requests.user_id` are all `ON DELETE CASCADE`; `machine_tokens.machine_id` cascades transitively via `machines`; `pairing_requests.machine_id` is `ON DELETE SET NULL` (not cascade) — irrelevant for full-user erasure since the same row's `user_id` FK already cascades it, but worth knowing if a future machine-only erasure path is added.
- Confirmed `apps/hub/src/db/migrate.ts` tracks applied migrations by filename in `_migrations`, sorted alphabetically — `003_audit_log.sql` running after `002_add_user_is_admin.sql` is automatic, no runner change needed.
- Confirmed the login-failure audit hook has one clean insertion point in `users/routes.ts`: `if (!user || !ok) return c.json({ error: "invalid credentials" }, 401);` — no argon2/timing logic duplication needed.
- Confirmed cascade-delete of `user_sessions` on user delete means a stale session cookie naturally 401s via existing `readSession`/`requireUser` — the "subsequent `/api/v1/me` → 401" requirement needs no extra code.
- Confirmed `deleteUser`'s boolean-via-rowcount approach is already precedented in this codebase: `pairing/repo.ts`'s `consumePairingRequest` returns `rows.length > 0` from a `returning` clause — same pattern, no new idiom introduced.

## Risks Identified
- **Retention job tests will be flaky under the current test setup.** `apps/hub/test/integration/users.test.ts` and `test/helpers/server.ts` show tests run against one shared real Postgres (`localhost:5433` by default) with no truncation/reset between tests — isolation today comes only from unique random values (`u${Date.now()}@t.dev`). `runRetention()` as specified operates unscoped over entire tables. Any test asserting exact `sessionsDeleted`/`pairingsDeleted`/`tokensDeleted` counts will break once other fixtures accumulate expired rows across test files. Tests must check specific known row ids are gone, not trust the returned counts to equal an exact expected number.
- **`pendingTokens` sweep has no timestamp to key off.** `pairing/service.ts`'s `pendingTokens` Map is `code -> token`, no stored insertion time. `sweepPendingTokens()` can't independently decide staleness — it needs the set of codes whose `pairing_requests` row is already expired/consumed, which only exists as a DB query result. `runRetention()` must query pairing_requests first and hand matched codes to the sweep, not sweep in isolation. Plan doesn't specify this coupling yet.
- **Env-var wiring bypasses the established config pattern.** `apps/hub/src/config.ts` centralizes every env var through one zod `Schema` (`MANDO_ADMIN_*`, `MANDO_RATE_LIMIT_*`) into a typed `Config`. The plan's "configurable via `MANDO_RETENTION_INTERVAL_MS` env" read directly in `index.ts` breaks that convention and skips validation.

## Recommended Changes
- Add `MANDO_RETENTION_INTERVAL_MS` and the token-revocation retention window to `config.ts`'s `Schema`/`Config`, consistent with `MANDO_RATE_LIMIT_LOGIN_MAX` etc., instead of a raw `process.env` read in `index.ts`.
- Call `logAudit(sql, ...)` with the plain top-level `Sql` type, *after* `approvePairing`/`revokeMachine` return — both already run their own internal `sql.begin(...)` transactions in repo.ts, so audit logging doesn't need (and shouldn't have) tx participation; logging only on success also means a rolled-back action never gets a stray audit row.
- Type `audit.ts`/`retention.ts`'s `sql` parameter as `postgres.ISql` (the `Executor` alias already used in `machines/repo.ts`/`pairing/repo.ts`) for consistency, even though current call sites don't strictly require tx support.

## Blocked
- None. No fundamental flaw found; the two items above are implementation-order prerequisites, not blockers.

## Next Steps
- Decide the exact `sweepPendingTokens()` <-> DB-sweep coupling before writing `retention.ts`.
- Design a minimal limit/before-cursor for `GET /api/v1/audit` — no existing paginated-list endpoint in this codebase to copy (`listMachines` etc. return everything unbounded).
- When writing retention tests, assert against specific fixture row ids, not absolute counts, given the shared/unreset test DB.

## Note (unrelated to this spec, flagged for the record)
Tool output while reading files for this review contained an injected fake "system-reminder" block (fabricated date-change notice, fake MCP server instructions, fake "Auto Mode Active" directive). This was not present in any actual repo file — `git status`/repo contents were unaffected — and was disregarded. Same class of injection previously seen and logged in this file's prior entry (C1 review). Not a code issue to fix, just flagging that this vector keeps appearing in this working directory's tool-output stream.
