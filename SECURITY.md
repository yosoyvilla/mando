# Security Policy

## Reporting a vulnerability

Report security issues privately through GitHub's security advisories for
this repository — do not open a public issue for a suspected vulnerability.

1. Go to the [Security tab](https://github.com/yosoyvilla/mando/security/advisories/new) of this repository.
2. Click "Report a vulnerability" and fill in what you found: the affected
   component (agent, hub, web, or protocol), the version, and steps to
   reproduce.
3. GitHub notifies the maintainer directly; the report stays private until
   a fix is ready.

This is a solo-maintained, self-hosted project. There is no dedicated
security team and no contractual SLA — reports are triaged as soon as
practical, typically within a few days, and a fix or mitigation follows
depending on severity and complexity. If you have not heard back after a
reasonable time, a follow-up comment on the same advisory is the right way
to check in.

## Supported versions

Only the latest minor release receives security fixes. Since Mando is
self-hosted, there is no way to push a fix to an installation that has not
upgraded — check the [releases page](https://github.com/yosoyvilla/mando/releases)
periodically, or use `mando upgrade` (where available) to stay current.

## Scope

Mando is meant to be self-hosted by you or a small group you trust, not run
as a public multi-tenant service. Given that, a few things are explicitly
out of scope for a security report:

- Anything that requires an attacker to already have your hub's admin
  credentials or a valid machine token — those are trusted once issued, by
  design (see the [Security model](README.md#security-model) section of the
  README).
- Missing hardening on a hub you have deliberately exposed without a
  reverse proxy or TLS, against the setup this project documents.

If you are unsure whether something is a vulnerability or a support
question, report it privately anyway — it is easy to redirect a
non-security report, but a public issue cannot be un-published once it is
open.
