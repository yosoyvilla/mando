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
Report the result of connecting to Mando: !\`mando connect --opencode-auto --json $ARGUMENTS\`
`;

// getOpencodeConfigDir resolves opencode's config directory. We honor
// OPENCODE_CONFIG_DIR -- opencode's own override env var -- rather than
// inventing a mando-specific one, so this respects whatever config
// location the user (or opencode itself) has already configured.
function getOpencodeConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
}

// installCommand writes the `/mando` command file into opencode's commands
// directory, creating parent directories as needed, and returns the
// absolute path written.
export function installCommand(): string {
  const commandsDir = join(getOpencodeConfigDir(), "commands");
  mkdirSync(commandsDir, { recursive: true });

  const commandPath = join(commandsDir, "mando.md");
  writeFileSync(commandPath, MANDO_COMMAND_TEMPLATE, "utf-8");

  return commandPath;
}
