import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand } from "../../src/install-command";

let tmpDir: string | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mando-install-command-test-"));
  process.env.OPENCODE_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.OPENCODE_CONFIG_DIR;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("installCommand", () => {
  it("writes the /mando command file under OPENCODE_CONFIG_DIR/commands/mando.md", () => {
    const written = installCommand();

    const expectedPath = join(tmpDir!, "commands", "mando.md");
    expect(written).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("contains the description frontmatter and the shell-injection line", () => {
    const written = installCommand();
    const content = readFileSync(written, "utf-8");

    expect(content).toContain("description:");
    expect(content).toContain("!`mando connect --opencode-auto --json $ARGUMENTS`");
  });

  it("creates parent directories that do not yet exist", () => {
    const nestedDir = join(tmpDir!, "nested", "opencode-config");
    process.env.OPENCODE_CONFIG_DIR = nestedDir;

    const written = installCommand();

    expect(written).toBe(join(nestedDir, "commands", "mando.md"));
    expect(existsSync(written)).toBe(true);
  });
});
