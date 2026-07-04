# OpenCode Mando

OpenCode Mando lets you drive an opencode coding session from somewhere other than the machine it's running on. Install a small program on your computer, run one command, approve the connection in your browser, and from then on you can open a web page on your phone, another computer, or any browser and watch and steer that session as if you were sitting in front of the original machine. Think of it as a remote control: the actual work still happens on your machine, but the screen and the buttons can be anywhere.

## Quick start

This gets a working setup running in about five minutes: a server (the "hub") that hosts the web interface, and one machine connected to it.

### 1. Start the hub

The hub is a small server plus a database. The repository ships a Docker Compose file that runs both together.

```bash
git clone <this-repository-url>
cd mando
docker compose -f deploy/docker-compose.yml up
```

This starts a PostgreSQL database and the hub, and publishes the hub on `http://localhost:8080`.

### 2. Create the first account

The compose file lets you bootstrap an admin account automatically by setting two environment variables before starting the hub: `MANDO_ADMIN_EMAIL` and `MANDO_ADMIN_PASSWORD`. Open `deploy/docker-compose.yml`, uncomment those two lines under the `hub` service, fill in an email and a password (at least 8 characters), and restart:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate hub
```

Then open `http://localhost:8080` in a browser and log in with that email and password.

### 3. Connect a machine

On the machine running opencode, clone the repository, build the `mando` command-line tool, and register the `/mando` command with opencode:

```bash
git clone <this-repository-url>
cd mando
bun install
cd packages/agent
bun run build:binary        # produces dist/mando
sudo cp dist/mando /usr/local/bin/mando
mando install-command
```

Now, from inside an opencode session on that machine, run:

```
/mando
```

This prints a short pairing code and a link such as `http://localhost:8080/pair?code=ABC123`. Open that link (or go to the hub and enter the code manually), log in if needed, and approve the pairing.

### 4. Drive the session

Back in the hub's web interface, the machine now appears in your machine list. Select it to open its session view in the browser and start sending prompts. The opencode process itself keeps running on the original machine; the browser is just a window into it.

## How it works

Three pieces are involved: the browser, the hub, and the machine's own opencode server.

```
   your browser                    the hub                      your machine
+----------------+   HTTPS/WSS   +------------+   outbound WSS   +------------------+
|  web interface | <-----------> | hub server | <--------------> | mando agent      |
+----------------+               | (Postgres) |                  |  -> opencode     |
                                  +------------+                  |     (localhost)  |
                                                                   +------------------+
```

The machine's `mando` agent never listens for incoming connections. It dials out to the hub over a secure WebSocket and keeps that connection open. When you interact with a session in the browser, the hub forwards your request over that same connection to the machine, which relays it to the local opencode server and streams the response back the same way. Because the connection is always initiated by the machine, nothing on that machine needs to be reachable from the internet, and opencode's own local server is never exposed directly.

## Installing the agent

The agent is the `mando` command-line tool (source in `packages/agent`). It can be run directly with Bun, or compiled into a single self-contained binary:

```bash
cd packages/agent
bun install
bun run build:binary
```

This produces `dist/mando`, a standalone executable with no separate runtime required on the target machine. Copy it onto your `PATH` as `mando` (for example, `/usr/local/bin/mando`) so both you and the `/mando` opencode command below can call it by name.

The agent stores its configuration (hub address, machine name, and pairing token) in `~/.mando.json`, created automatically with permissions restricted to your user, and writes a small pid file and last-seen marker (`~/.mando-pid`, `~/.mando-state.json`) so it can report its own status.

Available commands:

| Command | What it does |
|---|---|
| `mando connect` | Pairs this machine with a hub (if not already paired) and starts the background process that keeps the tunnel to the hub open. |
| `mando disconnect` | Stops the background process. |
| `mando status` | Reports whether the machine is configured, paired, and currently connected. |
| `mando install-command` | Writes the `/mando` command file into opencode's commands directory so it can be run from inside a session. |

`mando connect` accepts:

| Flag | Effect |
|---|---|
| `--hub <url>` | Hub address to connect to (overrides a saved or environment-configured address). |
| `--opencode-port <port>` | Local opencode port to use, skipping automatic detection. |
| `--opencode-auto` | Marks the connection as machine-initiated (used by the `/mando` command). |
| `--json` | Prints machine-readable output instead of plain text. |

All commands accept `--json` for machine-readable output.

## The /mando command

Running `mando install-command` writes a `/mando` slash command into opencode's commands directory (`~/.config/opencode/commands/mando.md`, or wherever `OPENCODE_CONFIG_DIR` points). Typing `/mando` inside an opencode session runs `mando connect --opencode-auto --json` for you, so pairing and connecting can be done without leaving the session: it prints a pairing code and a link the first time, and simply reports the connection status on later runs once the machine is already paired.

## Configuration

### Hub environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | none | PostgreSQL connection string. |
| `COOKIE_SECRET` | Yes | none | Secret used to sign browser session cookies. |
| `PUBLIC_URL` | Yes | none | The externally reachable URL of the hub (used to build pairing links). |
| `PORT` | No | `8080` | Port the hub listens on. |
| `MANDO_ADMIN_EMAIL` | No | none | If set together with `MANDO_ADMIN_PASSWORD`, creates an admin account on startup if it doesn't already exist. |
| `MANDO_ADMIN_PASSWORD` | No | none | Password for the account above (minimum 8 characters). |
| `MANDO_WEB_DIR` | No | `apps/web/dist` | Directory containing the built web interface to serve. |

### Agent environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MANDO_HUB` | No | none | Hub URL to use when none is saved yet and `--hub` isn't passed. |
| `MANDO_OPENCODE_PORT` | No | auto-detected (`4096`, falling back to `4097`) | Local opencode port to connect to. |
| `MANDO_OPENCODE_PASSWORD` | No | none | Password to present to a local opencode server that requires one. |
| `MANDO_CONFIG` | No | `~/.mando.json` | Path to the agent's configuration file. |
| `MANDO_PID_FILE` | No | `~/.mando-pid` | Path to the file tracking the background process's process ID. |
| `MANDO_STATE_FILE` | No | `~/.mando-state.json` | Path to the file recording when the agent last confirmed it was alive. |

## Deploying

For anything beyond trying it out locally, run the hub with Docker Compose (`deploy/docker-compose.yml`) on a server you control, or on Kubernetes using the manifests in `deploy/k8s` (a Deployment, Service, NetworkPolicy, ServiceAccount, an example Secret, and an example Ingress). The hub is a single stateless process backed by PostgreSQL; the Kubernetes Deployment is deliberately pinned to one replica, since machine connections are tracked in that one process's memory and are not yet shared across replicas.

Whatever you use in front of the hub (reverse proxy or ingress controller) must terminate TLS and must forward WebSocket upgrade requests through to the hub unmodified, since the tunnel endpoint (`/ws/agent`) depends on the connection staying open.

## Security model

- Browsers authenticate to the hub with a signed session cookie after logging in with an email and password.
- Machines never share that login. Instead, each machine goes through a pairing flow: it requests a short-lived pairing code, a logged-in user approves it in the browser, and only then does the machine receive its own long-lived, revocable token. That token identifies the machine on every future connection.
- Revoking a machine (from the web interface) immediately drops its live connection to the hub, if one is open.
- A machine's local opencode server is never exposed to the internet. It only ever talks to the `mando` agent process on the same machine over `localhost`, and the agent only ever makes outbound connections to the hub. Nothing needs to accept inbound connections on the machine running opencode.
- Keep the hub itself behind a private network (such as a Tailscale-style overlay network or a VPN) if you don't need it reachable from the public internet, and always run it behind TLS if you do.

## Development

This is a Bun-based monorepo managed with Turborepo.

```bash
bun install
bun run typecheck   # type-check every package
bun run test        # run every package's test suite
bun run lint        # lint every package
```

Layout:

| Path | Contents |
|---|---|
| `apps/hub` | The hosted server: web interface hosting, REST/SSE API, the WebSocket tunnel endpoint, authentication, and the PostgreSQL-backed data layer. |
| `apps/web` | The browser interface (login, machine picker, pairing approval, session view). |
| `packages/agent` | The `mando` command-line tool. |
| `packages/opencode-plugin` | The `/mando` opencode command file. |
| `packages/protocol` | Shared message schemas used by both the hub and the agent to talk to each other over the tunnel. |
| `deploy` | Dockerfile, Docker Compose file, and Kubernetes manifests. |

To run the hub locally against a real database during development:

```bash
docker compose -f deploy/docker-compose.yml up postgres -d
cd apps/hub
bun run migrate
bun run dev
```

## Testing

Each package has its own test suite, runnable with `bun test` from that package's directory, or all together with `bun run test` from the repository root.

- Unit tests cover individual functions and modules in isolation (for example, the agent's port-detection and reconnect-backoff logic, or the hub's password hashing).
- Integration tests exercise real components together: the hub's integration tests run against a real PostgreSQL database (by default `postgres://mando:mando@localhost:5433/mando`, matching the port Docker Compose publishes) and make real HTTP and WebSocket requests against the running application.
- The hub's integration suite includes end-to-end style tests that start a real server, connect a simulated agent over a real WebSocket, and confirm a request made against the hub's proxy API is relayed to that agent and back, exercising the full pairing-to-proxy path in one test rather than mocking any layer of it.

To run the hub's integration tests locally, start a database first:

```bash
docker compose -f deploy/docker-compose.yml up postgres -d
bun run test --filter @mando/hub
```

## License

MIT. See [LICENSE](LICENSE).
