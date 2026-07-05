# OpenCode Mando

OpenCode Mando lets you drive an opencode coding session from somewhere other than the machine it is running on (opencode is an AI coding-agent CLI you run in a terminal). You install a small program on the machine where opencode runs, connect it once, approve the connection in your browser, and from then on you can open a web page on your phone, a laptop, or any browser and watch and steer that session as if you were sitting in front of the original machine. Think of it as a remote control: the actual work still happens on your machine, but the screen and the buttons can be anywhere.

It is meant to be self-hosted. You run the server on a machine you control (your own computer, a VPS, a home server) and use it for yourself, or share it with a few people you trust. It is not a hosted service you sign up for.

![The session view: driving an opencode session from the browser](assets/screenshots/session.png)

## Contents

- [Quick start](#quick-start) — a working setup on one machine in about five minutes
- [How it works](#how-it-works) — including [how this compares to opencode web and /share](#how-this-compares-to-opencode-web-and-share)
- [Connecting a machine](#connecting-a-machine) — including a hub running on another server
- [Installing the agent](#installing-the-agent) — building the binary, config, commands and flags, and [starting on boot](#starting-on-boot)
- [The /mando command](#the-mando-command)
- [Live mirroring with mando tui](#live-mirroring-with-mando-tui) — and [how a session moves between terminal and browser](#how-a-session-moves-between-terminal-and-browser)
- [Configuration](#configuration) — environment variables
- [Deploying](#deploying) — running the hub on a server
- [Managing users and machines](#managing-users-and-machines)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting) — `mando doctor` and what its checks mean
- [Development](#development) and [Testing](#testing)

## Quick start

This gets a working setup running on a single machine in about five minutes: the server (called the "hub"), which hosts the web interface, and one machine connected to it. Here the hub and the machine are the same computer; see [Connecting a machine](#connecting-a-machine) for a hub on a different server.

**Prerequisites:** Docker (with Compose) to run the hub; on the machine you want to connect, either write access to `/usr/local/bin` (or `sudo`) for the one-line installer, or [Bun](https://bun.sh) and git if you'd rather build the agent from source.

### 1. Start the hub

The hub is a small server plus a PostgreSQL database. The repository ships a Docker Compose file that runs both together. Before starting it, set an admin email and password so you have an account to log in with — open `deploy/docker-compose.yml` and uncomment the `MANDO_ADMIN_EMAIL` and `MANDO_ADMIN_PASSWORD` lines under the `hub` service (the password must be at least 8 characters), then:

```bash
git clone https://github.com/yosoyvilla/mando.git
cd mando
docker compose -f deploy/docker-compose.yml up -d
```

The hub is now on `http://localhost:8080`. Open it in a browser and log in with the email and password you set.

![The login page](assets/screenshots/login.png)

### 2. Install the agent on the machine running opencode

```bash
curl -fsSL https://raw.githubusercontent.com/yosoyvilla/mando/main/install.sh | sh
mando install-command   # registers the /mando command with opencode
```

See [Installing the agent](#installing-the-agent) for what the script does and how to build from source instead.

### 3. Connect and pair the machine

From the project directory you work in, run the one-time connect, pointing at your hub:

```bash
cd ~/code/your-project
mando connect --hub http://localhost:8080 --opencode-auto
```

You do not need an opencode server running first: `--opencode-auto` finds one if it exists and starts one for you if it does not. The directory you run this from matters — the web interface scopes its session list to it.

This prints a short pairing code and a link such as `http://localhost:8080/pair?code=ABCD-EFGH`. Open that link (or go to the hub, choose **Pair a machine**, and type the code), then approve it.

![Approving a pairing code](assets/screenshots/pairing.png)

Once approved, the machine saves its hub address and its own token to `~/.mando.json` and starts a background connection. From now on you can reconnect from inside an opencode session just by typing `/mando` — you only pass `--hub` the first time.

### 4. Drive the session

Back in the browser, the machine now appears in your machine list with an online badge. Select it and you get the sessions from the project directory you connected in — most recent first, with the newest pinned as LIVE. Open one and start sending prompts. The opencode process keeps running on the original machine; the browser is just a window into it.

The everyday flow after this one-time setup: `cd` into your project, run `opencode` as usual, type `/mando` once, and your terminal session — messages included — is there in the browser, ready to be continued from a phone or any other machine. If you want the terminal itself to mirror live rather than just show up in the browser afterward, run `mando tui` instead of `opencode` — see [Live mirroring with mando tui](#live-mirroring-with-mando-tui).

![The machines list, showing an online machine](assets/screenshots/machines.png)

## How it works

Three pieces are involved: the browser, the hub, and the machine's own opencode server.

```
   your browser                  the hub                       your machine
+---------------+                +------------+                +---------------+
| web interface | <------------> | hub server | <------------> | mando agent   |
+---------------+  HTTPS / WSS   | (Postgres) |  outbound WSS  | -> opencode   |
                                 +------------+                | (localhost)   |
                                                               +---------------+
```

The machine's `mando` agent never listens for incoming connections. It dials out to the hub over a secure WebSocket and keeps that connection open. When you interact with a session in the browser, the hub forwards your request over that same connection to the machine, which relays it to the local opencode server and streams the response back the same way. Because the connection is always started by the machine, nothing on that machine needs to be reachable from the internet, and opencode's own local server is never exposed directly.

### How this compares to opencode web and /share

opencode itself ships two features that sound similar, and for some setups they are all you need:

| | `opencode web` | `/share` | OpenCode Mando |
|---|---|---|---|
| What it is | opencode's own browser interface, served by your machine | Public read link to a conversation, synced to opencode's cloud | A self-hosted hub your machines dial out to |
| Reach | Your local network — or a VPN/Tailscale you set up and secure yourself | Anyone with the link | Any browser, anywhere — you front the hub with your own reverse proxy or CDN for HTTPS |
| Machines | One (the one serving it) | N/A — shares one conversation, not a machine | A fleet — each paired, each revocable |
| Inbound exposure | Your machine listens; you manage TLS and what can reach it | None (their cloud) | None — the agent only dials out |
| Accounts | One shared basic-auth password | None | Multi-user, per-machine tokens, pairing approval |
| Where your data goes | Stays on your machine | opencode's servers | Infrastructure you control |

If you work from one machine and are always on the same network (or already run Tailscale and are comfortable securing an exposed service), `opencode web` is simpler — use it. `/share` is for showing a conversation to someone, not for driving it. Mando is for the remaining case: several machines, a phone on the move, and nothing on your machines exposed to the internet — while keeping everything on servers you own. They compose rather than compete: Mando drives opencode's standard server API, and `mando tui` uses opencode's own attach mode underneath.

## Connecting a machine

A machine needs to know one thing before it can pair: the address of your hub. The agent finds that address, in order, from:

1. the `--hub <url>` flag on `mando connect`,
2. the address saved in `~/.mando.json` from a previous successful pairing, or
3. the `MANDO_HUB` environment variable.

If none of these is set, `mando connect` (and therefore `/mando`) stops with `no hub URL configured`. This is why the first pairing always passes `--hub` (or sets `MANDO_HUB`); after that the address is saved and `/mando` alone is enough.

### Hub on the same machine (local)

```bash
mando connect --hub http://localhost:8080
```

Run this from the project directory whose sessions you want in the web interface, and add `--opencode-auto` if no opencode server is running yet (see Quick start step 3).

### Hub on another server (remote)

When the hub runs on a server, use its public HTTPS address for the first pairing:

```bash
mando connect --hub https://mando.example.com
```

The pairing link the agent prints will point at that same address, so you can open it on your phone to approve. After approval the address and token are saved locally and `/mando` works on its own.

If you would rather not pass `--hub` each time you set up a new machine — or you want `/mando` to work on its very first run inside a session — set the hub address in the environment instead, so the `/mando` command (which runs `mando connect` for you) inherits it:

```bash
export MANDO_HUB=https://mando.example.com   # add to your shell profile to make it permanent
```

For the hub to be reachable remotely it must be deployed with a matching public address and TLS; see [Deploying](#deploying).

## Installing the agent

The agent is the `mando` command-line tool (source in `packages/agent`).

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/yosoyvilla/mando/main/install.sh | sh
```

This detects your OS and architecture, downloads the matching binary attached to the latest [GitHub release](https://github.com/yosoyvilla/mando/releases/latest), and installs it as `mando` — to `/usr/local/bin` if that's writable (using `sudo` if available), otherwise to `~/.local/bin` (in which case add that directory to your `PATH` if it isn't already). On macOS it also clears the Gatekeeper quarantine flag the download picks up, since the binary isn't Apple-notarized.

### Build from source

If you'd rather not run a downloaded script, or you're working on the agent itself, build it into a single self-contained binary:

```bash
bun install
bun run --cwd packages/agent build:binary
```

This produces `packages/agent/dist/mando`, a standalone executable that needs no separate runtime on the target machine. Copy it onto your `PATH` as `mando` (for example `/usr/local/bin/mando`) so both you and the `/mando` opencode command can call it by name.

### Using the agent

The agent stores its configuration — hub address, machine name, and pairing token — in `~/.mando.json`, created with owner-only permissions. It also writes a small pid file and a last-seen marker (`~/.mando-pid`, `~/.mando-state.json`) so `mando status` can report whether the background connection is alive.

Commands:

| Command | What it does |
|---|---|
| `mando connect` | Pairs this machine with a hub (if not already paired) and starts the background process that keeps the tunnel open. Safe to run again; it detects an already-running connection instead of starting a second one. |
| `mando disconnect` | Stops the background connection. |
| `mando status` | Reports whether the machine is configured, paired, and currently connected, and when it was last seen. Includes the agent's version. |
| `mando tui` | Starts an opencode terminal attached to the machine's local opencode server, mirroring live with the browser. See [Live mirroring with mando tui](#live-mirroring-with-mando-tui). |
| `mando install-command` | Writes the `/mando` command file into opencode's commands directory so it can be run from inside a session. |
| `mando autostart <enable\|disable\|status>` | Registers (or removes) the agent as a startup service, so the machine reconnects on its own after a reboot. See [Starting on boot](#starting-on-boot). |
| `mando doctor` | Runs a set of diagnostic checks and reports PASS/FAIL/SKIP for each. See [Troubleshooting](#troubleshooting). |
| `mando version` (or `mando --version`) | Prints the agent's release version. |

Flags for `mando connect`:

| Flag | Effect |
|---|---|
| `--hub <url>` | Hub address to connect to. Required for the first pairing unless `MANDO_HUB` is set. |
| `--opencode-port <port>` | Local opencode port to use, skipping automatic detection. |
| `--opencode-auto` | Detects the local opencode server, and starts one (`opencode serve`, in the current directory) if none is running. Used by the `/mando` command. |
| `--json` | Machine-readable output. Accepted by `connect`, `disconnect`, `status`, `autostart`, and `doctor`. |

### Starting on boot

By default, the background connection `mando connect` starts does not survive a reboot — after the machine restarts, nothing reconnects it until you run `mando connect` (or `/mando`) again by hand. `mando autostart enable` fixes that by registering the agent as a startup service with your OS, so it reconnects on its own:

```bash
mando autostart enable
```

This writes a per-user service definition that runs `mando connect --opencode-auto` from the directory of your most recent successful `mando connect` (persisted alongside the rest of the agent's config) and asks the OS to start it at login/boot — on macOS, a `launchd` agent under `~/Library/LaunchAgents/`; on Linux, a `systemd --user` unit under `~/.config/systemd/user/`. Run `mando connect` at least once from the project directory you want autostart to use before enabling it.

On Linux, enabling autostart also runs `loginctl enable-linger` for your user — without it, `systemd --user` units (and the manager that runs them) are torn down the moment your last login session ends, so the service would never actually run when nobody is logged in, which is the exact scenario autostart exists for. Disabling autostart does not revoke linger, since other user services on the machine may depend on it staying on; run `loginctl disable-linger $(whoami)` yourself if you want it off too.

Other commands:

```bash
mando autostart status    # prints whether the startup service is currently registered
mando autostart disable   # removes it
```

Windows is not supported yet — `mando autostart` refuses gracefully there rather than doing anything.

## The /mando command

`mando install-command` writes two slash commands into opencode's commands directory (`~/.config/opencode/commands/`, or wherever `OPENCODE_CONFIG_DIR` points):

- `/mando` runs `mando connect --opencode-auto --json` for you, so you can connect and reconnect without leaving the session.
- `/mando-refresh` catches an already-open plain terminal up with what happened in the session remotely: it asks the assistant to quote, verbatim and in order, every message that arrived after your last one there. The missed exchange appears in the terminal as a normal reply — a replay, not a redraw, so it costs one model call and works because the assistant's context always includes the remote messages (see [how a session moves between terminal and browser](#how-a-session-moves-between-terminal-and-browser)). If nothing happened remotely, it says so in one line.

Because `/mando` runs `connect` without `--hub`, the machine must already know its hub — either from a previous `mando connect --hub ...` (saved in `~/.mando.json`) or from the `MANDO_HUB` environment variable. On the first ever run with neither set, `/mando` will report that no hub is configured; do the one-time `mando connect --hub ...` (or set `MANDO_HUB`) and it works from then on.

The command takes no arguments. Anything typed after `/mando` is ignored rather than passed to a shell, so it cannot be used to inject commands.

## Live mirroring with mando tui

Everything described so far gets your terminal session into the browser with its complete history, but neither side redraws the other live: the browser shows your terminal work when you open or come back to the session there, and a prompt sent from the browser does not appear in your already-open terminal at all until you reopen the session (see [how a session moves between terminal and browser](#how-a-session-moves-between-terminal-and-browser) below). `mando tui` closes that gap in both directions.

Instead of running `opencode` directly, run `mando tui`. You get the exact same opencode terminal — same keys, same screen — but now the terminal and the browser are two windows onto the same live session: a prompt sent from a phone appears in the open terminal as it streams in, and whatever you type in the terminal streams out to the browser the same way.

```bash
cd ~/code/your-project
mando tui
```

Under the hood, `mando tui` attaches the terminal to the machine's local opencode server — starting one in the current directory if none is running — and makes sure the background connection to the hub is up, the same one `mando connect` starts, so the session is reachable from the browser. If the machine isn't paired with a hub yet, `mando tui` still attaches the terminal (nothing about typing and reading opencode locally requires pairing); it just prints a reminder to run `mando connect --hub <url>` first if you also want the browser side.

Flags:

| Flag | Effect |
|---|---|
| `--dir <path>` | Project directory to attach in. Defaults to the current directory. |
| `--opencode-port <port>` | Local opencode port to attach to, skipping automatic detection. |

If you always want the mirrored terminal, alias it in place of the plain command:

```bash
alias oc='mando tui'
```

or, to replace `opencode` outright:

```bash
alias opencode='mando tui'
```

Either way, `mando tui` still runs the real `opencode` binary underneath — it attaches to it rather than replacing it, so anything opencode itself does is unaffected.

### How a session moves between terminal and browser

Whether or not you use `mando tui`, there is exactly one session and it lives in one place: opencode's own store on your machine. The browser and every terminal read and write that same session — nothing is copied, and nothing leaves the machine except what travels through your hub while you drive it remotely. The history is therefore always complete everywhere. What differs between the two ways of working is only when an already-open window redraws to show new activity:

| | Plain `opencode` | `mando tui` |
|---|---|---|
| Your terminal work, seen from the browser | Complete — shown when you open the session there, or when you come back to its tab | Streams live as you type |
| Your browser or phone work, seen in the open terminal | Never redrawn — reopen the session in the terminal to see it | Streams live |

The seam to know about is that bottom-left cell: a plain `opencode` terminal only redraws from its own activity. If you step away, continue the session from your phone, and come back, your still-open terminal will look exactly as you left it — and typing a new prompt there does not bring the missed messages into view either; only reopening the session does (pick it from the session list, or restart `opencode` and select it) — or run `/mando-refresh`, which replays the missed messages into the terminal as an assistant reply without leaving the session. Nothing is lost in the meantime: the work you did remotely is in the same session, and the assistant's context always includes those exchanges because everything reads from the same store. It is purely the display of an already-open plain terminal that does not refresh. The web interface shows a one-time note about this, and this is exactly the behavior `mando tui` exists to remove.

So the everyday flow with plain `opencode` is: work in the terminal, step away, continue on your phone, come back, run `/mando-refresh` (or reopen the session), keep going. If you would rather never think about the reopen step, use `mando tui` (or the alias above) and both sides stay live.

## Configuration

### Hub environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | none | PostgreSQL connection string. |
| `COOKIE_SECRET` | Yes | none | Secret for the session layer; must be at least 32 characters. Sessions are currently opaque server-side tokens, so this is reserved for future cookie signing, but a strong value is still required. |
| `PUBLIC_URL` | Yes | none | The hub's externally reachable base URL (for example `https://mando.example.com`). Set it to match how browsers and machines actually reach the hub. |
| `PORT` | No | `8080` | Port the hub listens on. |
| `MANDO_ADMIN_EMAIL` | No | none | With `MANDO_ADMIN_PASSWORD`, creates (or promotes to admin) this account on startup if it does not already exist. |
| `MANDO_ADMIN_PASSWORD` | No | none | Password for the admin account above (minimum 8 characters). |
| `MANDO_WEB_DIR` | No | the bundled build | Directory containing the built web interface to serve. |
| `MANDO_RATE_LIMIT_LOGIN_MAX` | No | a safe built-in limit | Max login attempts per IP per window. Raise it only if you have a good reason. |
| `MANDO_RATE_LIMIT_PAIRING_MAX` | No | a safe built-in limit | Max pairing-request/status calls per IP per window. |
| `MANDO_RATE_LIMIT_WS_AGENT_MAX` | No | a safe built-in limit | Max agent WebSocket connection attempts per IP per window. |
| `MANDO_RETENTION_INTERVAL_MS` | No | hourly | How often the hub purges expired sessions, consumed or expired pairing codes, and old revoked tokens. |

### Agent environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MANDO_HUB` | No | none | Hub URL to use when none is saved yet and `--hub` is not passed. |
| `MANDO_OPENCODE_PORT` | No | auto-detected (`4096`, then `4097`) | Local opencode port to connect to. |
| `MANDO_OPENCODE_PASSWORD` | No | none | Password to present to a local opencode server that requires one. Never leaves the machine. |
| `MANDO_CONFIG` | No | `~/.mando.json` | Path to the agent's configuration file. |
| `MANDO_PID_FILE` | No | `~/.mando-pid` | Path to the background process's pid file. |
| `MANDO_STATE_FILE` | No | `~/.mando-state.json` | Path to the last-seen marker file. |

## Deploying

Run the hub on a server you control, either with Docker Compose or on Kubernetes. The hub is a single stateless process backed by PostgreSQL. Machine connections are tracked in that one process's memory and are not yet shared across replicas, so run **exactly one** hub instance for now (the Kubernetes Deployment is pinned to one replica for this reason).

### What a server deployment needs

- A real `PUBLIC_URL` — the address browsers and machines use, for example `https://mando.example.com`.
- A strong `COOKIE_SECRET` (32+ characters), for example from `openssl rand -hex 32`.
- A `DATABASE_URL` for a PostgreSQL database you run or manage.
- An admin account, via `MANDO_ADMIN_EMAIL` / `MANDO_ADMIN_PASSWORD`.
- A reverse proxy or ingress in front that terminates TLS **and forwards WebSocket upgrade requests unmodified** — the tunnel endpoint (`/ws/agent`) depends on the connection staying open. Most proxies need an explicit setting to allow WebSocket upgrades.

### Docker Compose

The included `deploy/docker-compose.yml` is a good starting point. For a server, set `PUBLIC_URL`, `COOKIE_SECRET`, `DATABASE_URL`, and the admin variables to real values (do not ship the development defaults), and put a TLS-terminating reverse proxy in front. The compose file binds its ports to `127.0.0.1` by default, which is what you want when a reverse proxy sits in front on the same host.

Every tagged release also publishes the hub image to `ghcr.io/yosoyvilla/mando-hub` (tagged with the release version and `latest`). To use it instead of building locally, replace the `hub` service's `build:` line with `image: ghcr.io/yosoyvilla/mando-hub:latest` (or pin to a specific version tag).

### Kubernetes

`deploy/k8s` contains a Deployment, Service, NetworkPolicy, ServiceAccount, an example Secret, and an example Ingress. Supply the real configuration through the Secret (never commit real secrets), point the Deployment at your built image, and adjust the example Ingress for your ingress controller — including its WebSocket-upgrade annotation.

### Keeping it private

If you do not need the hub on the public internet, put it behind a private overlay network (such as a Tailscale-style tailnet) or a VPN and skip public exposure entirely. Machines still reach it the same way; only the network path changes.

### Logs, backups, and uptime monitoring

The Compose file caps both containers' logs at 10MB per file, 3 files (Docker's `json-file` driver, `max-size`/`max-file`) — without this, an unattended hub's logs grow unbounded and can fill the host's disk over time.

Back up the Postgres database with the included script, which dumps and gzips it via `docker compose exec` and keeps the last 14 days:

```bash
0 3 * * * /opt/mando/backup-postgres.sh
```

`MANDO_COMPOSE_FILE` and `MANDO_BACKUP_DIR` override the compose file location and backup destination (defaults: `/opt/mando/docker-compose.yml` and `/opt/mando/backups`) if you deploy from somewhere else.

For uptime monitoring, point an external checker — [healthchecks.io](https://healthchecks.io), [UptimeRobot](https://uptimerobot.com), or similar — at `GET /healthz` on your `PUBLIC_URL`; either service pings it on a schedule and alerts you when it stops responding. If you would rather push from the host instead, a cron entry works the same way:

```bash
*/5 * * * * curl -fsS "$PING_URL" >/dev/null
```

## Managing users and machines

- **The first user** is the admin you create with `MANDO_ADMIN_EMAIL` / `MANDO_ADMIN_PASSWORD`.
- **Adding people:** an admin can invite additional users. Inviting is restricted to admins, so ordinary users cannot create accounts.
- **Removing a machine:** revoke it from the web interface. Revocation immediately drops the machine's live connection and invalidates its token, so it can no longer reach the hub until it pairs again.
- **Deleting an account:** a user can delete their own account, and an admin can delete another user's account. Deleting an account removes that user and all of their machines, tokens, sessions, and pairing records.
- **Audit trail:** security-relevant events (logins, pairing approvals, revocations, account deletions, and invites) are recorded in an append-only audit log that admins can review. The audit trail is deliberately kept even when a user is deleted.

## Security model

- Browsers authenticate to the hub with a session established by an email-and-password login. Login is rate-limited per IP.
- Machines never share that login. Each machine goes through a pairing flow: it requests a short-lived pairing code, a logged-in user approves it in the browser, and only then does the machine receive its own long-lived, revocable token. Only a hash of each token is stored, never the token itself.
- Revoking a machine immediately drops its live connection and invalidates its token.
- A machine's local opencode server is never exposed to the internet. It only talks to the `mando` agent over `localhost`, and the agent only ever makes outbound connections to the hub. Nothing on the machine accepts inbound connections. Requests the hub relays are constrained to the local opencode server, so the tunnel cannot be steered at other hosts.
- Run the hub behind TLS whenever it is reachable from the internet, and behind a private network or VPN if you do not need it public.

## Troubleshooting

When something isn't working — a machine shows offline, a session won't load, a prompt never gets a reply — run `mando doctor` on the affected machine first:

```bash
mando doctor
```

It runs a fixed set of checks, one per line, each reported as `PASS`, `FAIL`, or `SKIP` with a one-line detail, and exits with status 1 if anything failed (0 otherwise), so it also works as a quick health gate in a script. Pass `--json` for machine-readable output.

| Check | What it means | If it fails |
|---|---|---|
| `config` | `~/.mando.json` exists and has a hub URL. | Run `mando connect --hub <url>` (see [Connecting a machine](#connecting-a-machine)). |
| `token` | The machine has a saved pairing token. Skipped if there is no config at all. | Run `mando connect --hub <url>` and approve the pairing code in the browser. |
| `hub` | The configured hub answers `GET /healthz` within 5 seconds. Skipped if no hub URL is configured. | Check the hub is running and reachable from this machine (DNS, TLS, firewall, reverse proxy) — see [Deploying](#deploying). |
| `daemon` | The background connection process recorded in `~/.mando-pid` is still alive. | Run `mando connect` again. If this machine should reconnect on its own after a reboot, see [Starting on boot](#starting-on-boot). |
| `opencode-server` | A local opencode server answers on the detected (or `MANDO_OPENCODE_PORT`-overridden) port. | Start one with `opencode serve`, or reconnect with `mando connect --opencode-auto` to have the agent start one for you. |
| `opencode-binary` | The `opencode` binary is on `PATH` and runs `--version` successfully. | Install or fix your opencode installation; if it's somewhere non-standard, point `MANDO_OPENCODE_BIN` at it. |
| `commands` | Both `/mando` command files are present in opencode's commands directory. | Run `mando install-command`. |

A `FAIL` on `daemon`, `opencode-server`, or `hub` explains most "machine shows offline" or "session won't load" reports; the exact same information is also on `mando status` and (for the hub side) the web interface's machine list, but `doctor` is the one command that checks everything at once.

## Development

A Bun-based monorepo managed with Turborepo.

```bash
bun install
bun run typecheck   # type-check every package
bun run test        # run every package's test suite
```

Layout:

| Path | Contents |
|---|---|
| `apps/hub` | The hosted server: web-interface hosting, REST/SSE API, the WebSocket tunnel endpoint, authentication, and the PostgreSQL-backed data layer. |
| `apps/web` | The browser interface (login, machine picker, pairing approval, session view). |
| `packages/agent` | The `mando` command-line tool. |
| `packages/opencode-plugin` | The `/mando` opencode command file. |
| `packages/protocol` | Shared message schemas the hub and agent use to talk over the tunnel. |
| `deploy` | Dockerfile, Docker Compose file, and Kubernetes manifests. |

To run the hub locally against a real database:

```bash
docker compose -f deploy/docker-compose.yml up postgres -d
cd apps/hub
bun run migrate
bun run dev
```

## Testing

Each package has its own test suite, runnable with `bun test` from that package's directory, or all together with `bun run test` from the repository root.

- Unit tests cover individual functions and modules in isolation (for example the agent's port-detection and reconnect-backoff logic, or the hub's password hashing).
- Integration tests exercise real components together: the hub's integration tests run against a real PostgreSQL database (by default `postgres://mando:mando@localhost:5433/mando`, matching the port Docker Compose publishes) and make real HTTP and WebSocket requests against the running application.
- End-to-end tests in `e2e/` use Playwright to drive the full stack in a real browser — logging in, pairing, watching a machine go online and offline, and sending a prompt whose reply streams back — against a real hub, a real agent, and a stub opencode server.
- A separate gated suite (`e2e/playwright.real.config.ts`) boots an actual `opencode serve` and proves the handoff end to end against it: a session created the way a terminal creates one is discovered, its messages load, and a prompt sent through the hub reaches it. CI runs this on every push, so drift between the stub and real opencode cannot go unnoticed.

To run the hub's integration tests locally, start a database first:

```bash
docker compose -f deploy/docker-compose.yml up postgres -d
bun run test --filter @mando/hub
```

## License

MIT. See [LICENSE](LICENSE).
