import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("mando command template", () => {
  it("should contain the exact shell-injection line", () => {
    const commandPath = join(__dirname, "../commands/mando.md");
    const content = readFileSync(commandPath, "utf-8");

    expect(content).toContain(
      "!`mando connect --opencode-auto --json $ARGUMENTS`"
    );
  });

  it("should have description frontmatter key", () => {
    const commandPath = join(__dirname, "../commands/mando.md");
    const content = readFileSync(commandPath, "utf-8");

    expect(content).toContain("description:");
  });
});
