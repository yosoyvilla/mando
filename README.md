# OpenCode Mando

Remote control for [OpenCode](https://opencode.ai). Mando gives you a web interface to start, monitor, and drive OpenCode sessions from any device: a phone, a tablet, or another machine.

> Mando is a personal project and is not affiliated with the OpenCode team.

## What it does

- Runs a web UI on top of a local OpenCode server
- Lets you create sessions, send prompts, and watch live output from a browser
- Manages multiple running instances from a single place
- Pairs well with [Tailscale](https://tailscale.com) for secure access from anywhere without exposing ports

## Requirements

- [Bun](https://bun.sh) 1.3+
- [OpenCode](https://opencode.ai) installed and configured

## Getting started

```bash
# Install dependencies
bun install

# Start the CLI (OpenCode server + web UI)
bun run --cwd packages/cli dev
```

## CLI commands

```
mando                    Start OpenCode + Web UI
mando run                Start only the OpenCode server (no Web UI)
mando stop               Stop running instances
mando list               List running instances
mando clean              Clean up stale entries
mando --port 8080        Use a custom web UI port
```

## Remote access

Run Mando on the machine where your code lives, join it to your tailnet, and open the web UI from any device on the same tailnet. Do not expose the port to the public internet.

```
[Your Phone] --(Tailscale)--> [Machine running Mando + OpenCode]
```

## Project structure

```
apps/web        Web UI (React Router + Nitro)
packages/cli    CLI launcher and instance manager
```

## License

MIT. See [LICENSE](LICENSE).
