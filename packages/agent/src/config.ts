import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface AgentConfig {
  hubUrl: string;
  token?: string;
  machineName: string;
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

  try {
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as AgentConfig;
    return config;
  } catch (error) {
    throw new Error(`Failed to read config from ${configPath}: ${error}`);
  }
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
    writeFileSync(configPath, content, "utf-8");
    chmodSync(configPath, 0o600);
  } catch (error) {
    throw new Error(`Failed to write config to ${configPath}: ${error}`);
  }
}
