import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpgrade, type GithubRelease } from "../../src/upgrade";
import type { ExecResult } from "../../src/autostart";

// This suite never touches the real network -- every test injects fetchFn
// (and, where relevant, exec/backup/install) with deterministic fakes, per
// the task brief ("fake GitHub API + asset server via seams; never touch
// the real network in tests").

let workDir: string;
let execPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mando-upgrade-test-"));
  execPath = join(workDir, "mando");
  writeFileSync(execPath, "old-binary-contents", "utf-8");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function releaseResponse(release: GithubRelease): Response {
  return new Response(JSON.stringify(release), { status: 200 });
}

function passingVerify(version: string): ExecResult {
  return { status: 0, stdout: version, stderr: "" };
}

describe("runUpgrade", () => {
  it("reports up_to_date and makes no download when the latest release tag matches the current version", async () => {
    let fetchCalls = 0;
    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      currentVersion: "v1.2.0",
      fetchFn: async () => {
        fetchCalls++;
        return releaseResponse({ tag_name: "v1.2.0", assets: [] });
      },
    });

    expect(result).toEqual({ status: "up_to_date", version: "v1.2.0" });
    expect(fetchCalls).toBe(1); // only the releases/latest lookup -- no asset download
    expect(readFileSync(execPath, "utf-8")).toBe("old-binary-contents");
  });

  it("--check reports an available update without downloading or installing anything", async () => {
    let fetchCalls = 0;
    const result = await runUpgrade({
      checkOnly: true,
      isCompiledBinary: () => true,
      execPath,
      platform: "linux",
      arch: "x64",
      currentVersion: "v1.2.0",
      fetchFn: async () => {
        fetchCalls++;
        return releaseResponse({ tag_name: "v1.3.0", assets: [{ name: "mando-linux-x64", browser_download_url: "https://example.invalid/mando-linux-x64" }] });
      },
    });

    expect(result).toEqual({ status: "available", from: "v1.2.0", to: "v1.3.0" });
    expect(fetchCalls).toBe(1);
    expect(readFileSync(execPath, "utf-8")).toBe("old-binary-contents");
    expect(existsSync(`${execPath}.new`)).toBe(false);
  });

  it("downloads, verifies, backs up, and atomically installs the new binary when an update is available", async () => {
    const newBinaryBytes = "brand-new-binary-contents";
    const installCalls: Array<[string, string]> = [];
    const backupCalls: Array<[string, string]> = [];

    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      currentVersion: "v1.2.0",
      fetchFn: async (url) => {
        if (url.includes("api.github.com")) {
          return releaseResponse({
            tag_name: "v1.3.0",
            assets: [{ name: "mando-darwin-arm64", browser_download_url: "https://example.invalid/mando-darwin-arm64" }],
          });
        }
        return new Response(newBinaryBytes, { status: 200 });
      },
      exec: (cmd, args) => {
        expect(cmd).toBe(`${execPath}.new`);
        expect(args).toEqual(["--version"]);
        return passingVerify("v1.3.0");
      },
      backup: (from, to) => {
        backupCalls.push([from, to]);
        writeFileSync(to, readFileSync(from, "utf-8"), "utf-8");
      },
      install: (from, to) => {
        installCalls.push([from, to]);
        writeFileSync(to, readFileSync(from, "utf-8"), "utf-8");
        rmSync(from, { force: true });
      },
    });

    expect(result).toEqual({ status: "upgraded", from: "v1.2.0", to: "v1.3.0" });
    expect(backupCalls).toEqual([[execPath, `${execPath}.bak`]]);
    expect(installCalls).toEqual([[`${execPath}.new`, execPath]]);
    expect(readFileSync(`${execPath}.bak`, "utf-8")).toBe("old-binary-contents");
    expect(readFileSync(execPath, "utf-8")).toBe(newBinaryBytes);
    expect(existsSync(`${execPath}.new`)).toBe(false);
  });

  it("refuses to run when not on a compiled binary (running from source)", async () => {
    const result = await runUpgrade({ isCompiledBinary: () => false, execPath });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("running from source");
    }
  });

  it("refuses for a platform/arch mando does not ship a binary for", async () => {
    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "win32",
      arch: "x64",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("win32");
    }
  });

  it("fails clearly when the GitHub API responds with a non-2xx status", async () => {
    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      fetchFn: async () => new Response("rate limited", { status: 403 }),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("403");
    }
  });

  it("fails clearly when the release has no asset for this platform/arch", async () => {
    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      currentVersion: "v1.2.0",
      fetchFn: async () => releaseResponse({ tag_name: "v1.3.0", assets: [{ name: "mando-linux-x64", browser_download_url: "https://example.invalid/x" }] }),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("mando-darwin-arm64");
    }
    expect(existsSync(`${execPath}.new`)).toBe(false);
  });

  it("fails and cleans up the staged download when verification's --version output does not match the release tag", async () => {
    const installCalls: Array<[string, string]> = [];

    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      currentVersion: "v1.2.0",
      fetchFn: async (url) => {
        if (url.includes("api.github.com")) {
          return releaseResponse({
            tag_name: "v1.3.0",
            assets: [{ name: "mando-darwin-arm64", browser_download_url: "https://example.invalid/mando-darwin-arm64" }],
          });
        }
        return new Response("truncated-or-wrong-binary", { status: 200 });
      },
      exec: () => passingVerify("v1.2.9"), // wrong version -- verification must fail
      install: (from, to) => installCalls.push([from, to]),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("verification");
    }
    expect(installCalls).toEqual([]); // never reached the install step
    expect(existsSync(`${execPath}.new`)).toBe(false); // staged download cleaned up
    expect(readFileSync(execPath, "utf-8")).toBe("old-binary-contents"); // untouched
  });

  it("fails and cleans up when the verification exec itself reports a non-zero exit", async () => {
    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      currentVersion: "v1.2.0",
      fetchFn: async (url) => {
        if (url.includes("api.github.com")) {
          return releaseResponse({
            tag_name: "v1.3.0",
            assets: [{ name: "mando-darwin-arm64", browser_download_url: "https://example.invalid/mando-darwin-arm64" }],
          });
        }
        return new Response("bad-binary", { status: 200 });
      },
      exec: () => ({ status: 126, stdout: "", stderr: "cannot execute binary file" }),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("verification");
    }
    expect(existsSync(`${execPath}.new`)).toBe(false);
  });

  it("still installs the update when the best-effort backup step fails", async () => {
    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      currentVersion: "v1.2.0",
      fetchFn: async (url) => {
        if (url.includes("api.github.com")) {
          return releaseResponse({
            tag_name: "v1.3.0",
            assets: [{ name: "mando-darwin-arm64", browser_download_url: "https://example.invalid/mando-darwin-arm64" }],
          });
        }
        return new Response("new-binary", { status: 200 });
      },
      exec: () => passingVerify("v1.3.0"),
      backup: () => {
        throw new Error("disk full");
      },
      install: (from, to) => {
        writeFileSync(to, readFileSync(from, "utf-8"), "utf-8");
        rmSync(from, { force: true });
      },
    });

    expect(result).toEqual({ status: "upgraded", from: "v1.2.0", to: "v1.3.0" });
    expect(readFileSync(execPath, "utf-8")).toBe("new-binary");
    expect(existsSync(`${execPath}.bak`)).toBe(false);
  });

  it("reports a clear reinstall-via-install.sh message when the final install step fails with EPERM", async () => {
    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      currentVersion: "v1.2.0",
      repo: "yosoyvilla/mando",
      fetchFn: async (url) => {
        if (url.includes("api.github.com")) {
          return releaseResponse({
            tag_name: "v1.3.0",
            assets: [{ name: "mando-darwin-arm64", browser_download_url: "https://example.invalid/mando-darwin-arm64" }],
          });
        }
        return new Response("new-binary", { status: 200 });
      },
      exec: () => passingVerify("v1.3.0"),
      install: () => {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("install.sh");
    }
    expect(readFileSync(execPath, "utf-8")).toBe("old-binary-contents"); // never touched
    expect(existsSync(`${execPath}.new`)).toBe(false); // staged download cleaned up
  });

  it("reports a generic install failure message for a non-EPERM install error", async () => {
    const result = await runUpgrade({
      isCompiledBinary: () => true,
      execPath,
      platform: "darwin",
      arch: "arm64",
      currentVersion: "v1.2.0",
      fetchFn: async (url) => {
        if (url.includes("api.github.com")) {
          return releaseResponse({
            tag_name: "v1.3.0",
            assets: [{ name: "mando-darwin-arm64", browser_download_url: "https://example.invalid/mando-darwin-arm64" }],
          });
        }
        return new Response("new-binary", { status: 200 });
      },
      exec: () => passingVerify("v1.3.0"),
      install: () => {
        throw new Error("device busy");
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("device busy");
      expect(result.message).not.toContain("install.sh");
    }
  });
});
