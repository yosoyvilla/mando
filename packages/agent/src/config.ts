import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";

// The port + directory of the most recent successful `mando connect` (see
// connect.ts) -- persisted so `mando autostart` (see autostart.ts) can
// replay the exact same setup (`connect --opencode-auto` from that
// directory) after a reboot, when there is no shell cwd or prior invocation
// to inherit either from. opencodePort is optional because the
// already-running-daemon short-circuit in connect() returns before
// re-resolving it; connectDirectory is always known (it's just cwd).
const lastConnectSchema = z.object({
  opencodePort: z.number().optional(),
  connectDirectory: z.string(),
});

const agentConfigSchema = z.object({
  hubUrl: z.string(),
  token: z.string().optional(),
  machineName: z.string(),
  lastConnect: lastConnectSchema.optional(),
});

export interface LastConnect {
  opencodePort?: number;
  connectDirectory: string;
}

export interface AgentConfig {
  hubUrl: string;
  token?: string;
  machineName: string;
  lastConnect?: LastConnect;
}

function getConfigPath(): string {
  const configPath = process.env.MANDO_CONFIG;
  if (configPath) {
    return configPath;
  }
  return join(homedir(), ".mando.json");
}

export function readConfig(): AgentConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }

  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read config from ${configPath}: ${error}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid mando config at ${configPath}: ${error}`);
  }

  const result = agentConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid mando config at ${configPath}: ${result.error.message}`);
  }

  return result.data;
}

export function writeConfig(config: AgentConfig): void {
  const configPath = getConfigPath();
  const parentDir = dirname(configPath);

  // Ensure parent directory exists
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  try {
    const content = JSON.stringify(config, null, 2);
    writeFileSync(configPath, content, { encoding: "utf-8", mode: 0o600 });
    chmodSync(configPath, 0o600);
  } catch (error) {
    throw new Error(`Failed to write config to ${configPath}: ${error}`);
  }
}
