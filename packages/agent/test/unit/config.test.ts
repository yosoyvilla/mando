import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readConfig, writeConfig, AgentConfig } from "../../src/config";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("AgentConfig", () => {
  let testDir: string;
  let configPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "mando-test-"));
    configPath = join(testDir, ".mando.json");
    process.env.MANDO_CONFIG = configPath;
  });

  afterEach(() => {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    delete process.env.MANDO_CONFIG;
  });

  it("readConfig returns null when file does not exist", () => {
    const result = readConfig();
    expect(result).toBeNull();
  });

  it("writeConfig and readConfig return the same object", () => {
    const config: AgentConfig = {
      hubUrl: "https://hub.example.com",
      token: "secret-token-123",
      machineName: "my-machine",
    };

    writeConfig(config);
    const result = readConfig();

    expect(result).toEqual(config);
  });

  it("writeConfig sets file mode to 0o600", () => {
    const config: AgentConfig = {
      hubUrl: "https://hub.example.com",
      machineName: "my-machine",
    };

    writeConfig(config);

    const stat = statSync(configPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("readConfig handles missing token field", () => {
    const config: AgentConfig = {
      hubUrl: "https://hub.example.com",
      machineName: "my-machine",
    };

    writeConfig(config);
    const result = readConfig();

    expect(result).toEqual(config);
    expect(result?.token).toBeUndefined();
  });
});
