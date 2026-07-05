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
  it("writes /mando and /mando-refresh command files under OPENCODE_CONFIG_DIR/commands/", () => {
    const written = installCommand();

    const expectedMando = join(tmpDir!, "commands", "mando.md");
    const expectedRefresh = join(tmpDir!, "commands", "mando-refresh.md");
    expect(written).toEqual([expectedMando, expectedRefresh]);
    expect(existsSync(expectedMando)).toBe(true);
    expect(existsSync(expectedRefresh)).toBe(true);
  });

  it("mando.md contains the description frontmatter and the arg-free connect line", () => {
    const [mandoPath] = installCommand();
    const content = readFileSync(mandoPath, "utf-8");

    expect(content).toContain("description:");
    expect(content).toContain("!`mando connect --opencode-auto --json`");
  });

  it("mando-refresh.md replays remote activity without tools and has a no-op reply", () => {
    const [, refreshPath] = installCommand();
    const content = readFileSync(refreshPath, "utf-8");

    expect(content).toContain("description:");
    expect(content).toContain("Without using any tools");
    expect(content).toContain("Nothing new since your last message here.");
    // The replay must not invite tool use or commentary that could mutate state.
    expect(content).not.toContain("!`");
    expect(content).not.toContain("$ARGUMENTS");
  });

  it("never interpolates $ARGUMENTS into the shell line (regression guard for the RCE fix)", () => {
    const [mandoPath] = installCommand();
    const content = readFileSync(mandoPath, "utf-8");

    expect(content).not.toContain("$ARGUMENTS");
  });

  it("creates parent directories that do not yet exist", () => {
    const nestedDir = join(tmpDir!, "nested", "opencode-config");
    process.env.OPENCODE_CONFIG_DIR = nestedDir;

    const written = installCommand();

    expect(written[0]).toBe(join(nestedDir, "commands", "mando.md"));
    expect(existsSync(written[0])).toBe(true);
    expect(existsSync(written[1])).toBe(true);
  });
});
