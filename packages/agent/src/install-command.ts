import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The `/mando` opencode slash-command template. This mirrors
// packages/opencode-plugin/commands/mando.md (task 4.1's canonical source);
// it's embedded here as a string constant until that package exists so
// `mando install-command` has something to write today.
const MANDO_COMMAND_TEMPLATE = `---
description: Connect this machine to Mando remote control
---
Report the result of connecting to Mando: !\`mando connect --opencode-auto --json\`
`;

// The \`/mando-refresh\` template (canonical copy:
// packages/opencode-plugin/commands/mando-refresh.md). A plain, non-attached
// opencode terminal never redraws from remote session activity and has no
// control surface a command could drive (its internal port answers 404 to
// everything, /tui/* included -- verified against opencode 1.17.13). What IS
// shared is the session store, so the assistant's context already contains
// whatever happened remotely; this command has the assistant replay it into
// the visible transcript. A replay, not a redraw -- costs one model call
// and arrives as an assistant message, which is exactly the trade the
// command's name advertises.
const MANDO_REFRESH_COMMAND_TEMPLATE = `---
description: Catch this terminal up with what happened in this session remotely
---
Without using any tools, quote verbatim and in chronological order every message in this conversation that came after my previous message, and before this one, labeling each with its author (user or assistant). Do not add commentary, analysis, or suggestions. If there are no such messages, reply exactly: Nothing new since your last message here.
`;

// getOpencodeConfigDir resolves opencode's config directory. We honor
// OPENCODE_CONFIG_DIR -- opencode's own override env var -- rather than
// inventing a mando-specific one, so this respects whatever config
// location the user (or opencode itself) has already configured.
function getOpencodeConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
}

// installCommand writes the `/mando` and `/mando-refresh` command files
// into opencode's commands directory, creating parent directories as
// needed, and returns the absolute paths written (mando.md first).
export function installCommand(): string[] {
  const commandsDir = join(getOpencodeConfigDir(), "commands");
  mkdirSync(commandsDir, { recursive: true });

  const mandoPath = join(commandsDir, "mando.md");
  writeFileSync(mandoPath, MANDO_COMMAND_TEMPLATE, "utf-8");

  const refreshPath = join(commandsDir, "mando-refresh.md");
  writeFileSync(refreshPath, MANDO_REFRESH_COMMAND_TEMPLATE, "utf-8");

  return [mandoPath, refreshPath];
}
