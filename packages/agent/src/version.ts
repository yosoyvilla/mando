// The agent's release version.
//
// For a standalone compiled binary (`bun run build:binary`, or the release
// workflow's cross-compiled artifacts) there is no live `process.env` to
// read at runtime -- `build.ts` stamps the version in at build time via
// Bun.build's `define`, which statically replaces the
// `process.env.MANDO_VERSION` expression below with a literal string
// before the code is compiled. For anything that isn't going through that
// build (plain `bun run src/index.ts`, the test suite), this falls back to
// reading the real environment variable, and finally to a dev default.
export const VERSION = process.env.MANDO_VERSION ?? "0.0.0-dev";
