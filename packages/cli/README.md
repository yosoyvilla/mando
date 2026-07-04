# mando (CLI)

CLI launcher for OpenCode Mando. Starts an OpenCode server together with the Mando web UI and manages running instances.

See the [repository README](../../README.md) for full documentation.

## Usage

```
mando [command] [options]

mando                    Start OpenCode + Web UI
mando run                Start only the OpenCode server (no Web UI)
mando stop               Stop running instances
mando list               List running instances
mando clean              Clean up stale entries
mando --port 8080        Use a custom web UI port
```

## Development

```bash
bun run dev          # Run from source
bun run build        # Build to dist/
bun run typecheck    # Type-check without emitting
```

## License

MIT. See [LICENSE](../../LICENSE).
