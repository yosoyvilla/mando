import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readConfig, writeConfig, AgentConfig } from "../../src/config";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

  it("writeConfig creates nested non-existent parent directories", () => {
    const nestedPath = join(testDir, "a", "b", "c", ".mando.json");
    process.env.MANDO_CONFIG = nestedPath;

    const config: AgentConfig = {
      hubUrl: "https://hub.example.com",
      machineName: "nested-machine",
    };

    writeConfig(config);

    expect(existsSync(nestedPath)).toBe(true);
    expect(readConfig()).toEqual(config);

    unlinkSync(nestedPath);
    process.env.MANDO_CONFIG = configPath;
  });

  it("readConfig throws on corrupt JSON instead of returning null", () => {
    writeFileSync(configPath, "{ not valid json", "utf-8");

    expect(() => readConfig()).toThrow();
  });

  it("readConfig throws on schema-invalid config content", () => {
    writeFileSync(configPath, JSON.stringify({ hubUrl: "https://hub.example.com" }), "utf-8");

    expect(() => readConfig()).toThrow();
  });
});
