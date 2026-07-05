# Contributing

Thanks for taking the time to contribute to OpenCode Mando.

## Before you start

For anything beyond a small fix, open an issue first (or comment on an
existing one) describing what you want to change and why — it saves you
from doing work on an approach that would not be accepted. Small,
self-contained fixes (typos, obvious bugs) can go straight to a pull
request.

If you are an AI coding agent working in this repository, read
[AGENTS.md](AGENTS.md) first — it has the golden rules, architecture
notes, and verified contract quirks this project depends on.

## Setting up

```bash
bun install
docker compose -f deploy/docker-compose.yml up -d postgres
```

That gets you the workspace dependencies and a local Postgres for the
hub's integration tests. See the [Development](README.md#development) and
[Testing](README.md#testing) sections of the README for the full layout,
how to run the hub and web app locally, and what each test layer (unit,
integration, end-to-end) covers — this file does not repeat any of that.

## Making a change

```bash
bun run test        # every package's test suite
bun run typecheck    # type-check every package
```

Run both from the repository root before opening a pull request. If your
change touches the browser-facing behavior, also run the end-to-end suite
from `e2e/` (see the README's Testing section for the default and
real-opencode configs).

Follow test-driven development where practical: write a failing test for
the behavior you are adding or fixing, then make it pass.

## Opening a pull request

- Tests and typecheck must be green.
- Commit messages are single-line, no emojis.
- No emojis anywhere in code, comments, or docs.
- Describe what changed, why, and how you tested it — the pull request
  template will prompt you for this.

A maintainer will review and may ask for changes before merging. This is a
solo-maintained project, so review can take a few days depending on
availability.
