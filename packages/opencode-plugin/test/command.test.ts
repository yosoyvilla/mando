import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("mando command template", () => {
  it("should contain the exact arg-free connect line", () => {
    const commandPath = join(__dirname, "../commands/mando.md");
    const content = readFileSync(commandPath, "utf-8");

    expect(content).toContain(
      "!`mando connect --opencode-auto --json`"
    );
  });

  it("should never interpolate $ARGUMENTS into the shell line (regression guard for the RCE fix)", () => {
    const commandPath = join(__dirname, "../commands/mando.md");
    const content = readFileSync(commandPath, "utf-8");

    expect(content).not.toContain("$ARGUMENTS");
  });

  it("should have description frontmatter key", () => {
    const commandPath = join(__dirname, "../commands/mando.md");
    const content = readFileSync(commandPath, "utf-8");

    expect(content).toContain("description:");
  });
});
