import { chmodSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { VERSION } from "./version";
import { defaultExec, type ExecRunner } from "./autostart";
import { printResult, runningFromCompiledBinary } from "./connect";
import type { FetchLike } from "./doctor";

// How long the GitHub API's `/releases/latest` lookup gets before giving up
// -- per the task brief ("bounded fetch"). A same-continent, well-known API
// endpoint; generous enough to ride out a slow DNS/TLS handshake without
// letting `mando upgrade` hang indefinitely on a network problem.
const DEFAULT_API_TIMEOUT_MS = 10_000;

// The release asset itself is a full standalone Bun binary (tens of MB) --
// a much larger, slower download than the JSON API call above, so it gets
// its own, longer budget.
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

const DEFAULT_REPO = "yosoyvilla/mando";

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GithubRelease {
  tag_name: string;
  assets: GithubReleaseAsset[];
}

export interface UpgradeOpts {
  json?: boolean;
  // `mando upgrade --check`: report what would happen without downloading
  // or installing anything.
  checkOnly?: boolean;
  // Test-only injection points, mirroring connect.ts's ConnectOpts style --
  // none of these change runUpgrade()'s documented behavior, they only let
  // tests swap the real network/process/exec calls for deterministic
  // stand-ins. Never invokes a real network request or subprocess in a
  // test.
  fetchFn?: FetchLike;
  exec?: ExecRunner;
  isCompiledBinary?: () => boolean;
  execPath?: string;
  platform?: string;
  arch?: string;
  currentVersion?: string;
  repo?: string;
  apiTimeoutMs?: number;
  downloadTimeoutMs?: number;
  // Defaults to node:fs's copyFileSync/renameSync respectively -- broken
  // out as their own seams (rather than only exercised transitively
  // through a real filesystem in tests) specifically so the EPERM
  // fallback-message path and the "backup failure doesn't abort the
  // upgrade" best-effort behavior can each be exercised deterministically,
  // without needing to coax a real EPERM out of the host filesystem.
  backup?: (from: string, to: string) => void;
  install?: (stagingPath: string, execPath: string) => void;
}

export type UpgradeResult =
  | { status: "up_to_date"; version: string }
  | { status: "available"; from: string; to: string }
  | { status: "upgraded"; from: string; to: string }
  | { status: "error"; message: string };

function mapPlatform(platform: string): string | null {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return null;
  }
}

function mapArch(arch: string): string | null {
  switch (arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function cleanupStagingFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort cleanup only -- a leftover `.new` file next to the
    // binary is harmless and gets overwritten by the next attempt.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// runUpgrade implements `mando upgrade`: check the latest GitHub release,
// and -- unless `checkOnly` -- download, verify, and install it in place of
// the currently running binary. See the task brief for the exact flow this
// follows (compare -> download -> chmod +x -> verify --version -> best-
// effort .bak -> atomic rename).
//
// Refuses outright when not running from a compiled binary (see
// runningFromCompiledBinary in connect.ts) -- there is nothing meaningful
// to overwrite when this code is running straight from source under `bun`.
export async function runUpgrade(opts: UpgradeOpts = {}): Promise<UpgradeResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const exec = opts.exec ?? defaultExec;
  const isCompiledBinary = opts.isCompiledBinary ?? runningFromCompiledBinary;
  const execPath = opts.execPath ?? process.execPath;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const currentVersion = opts.currentVersion ?? VERSION;
  const repo = opts.repo ?? DEFAULT_REPO;
  const apiTimeoutMs = opts.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const backup = opts.backup ?? copyFileSync;
  const install = opts.install ?? renameSync;

  if (!isCompiledBinary()) {
    const message = "mando upgrade only works on an installed binary -- running from source, use `git pull` (or your package manager) instead";
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  const osName = mapPlatform(platform);
  const archName = mapArch(arch);
  if (!osName || !archName) {
    const message = `mando does not ship a binary for this platform (${platform}/${arch})`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  let release: GithubRelease;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      // GitHub's REST API rejects requests with no User-Agent at all;
      // Accept pins the response shape to the documented release JSON.
      headers: { "User-Agent": "mando-upgrade", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(apiTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`GitHub API responded with status ${res.status}`);
    }
    release = (await res.json()) as GithubRelease;
  } catch (error) {
    const message = `could not check for updates: ${errorMessage(error)}`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  const latestVersion = release.tag_name;
  if (latestVersion === currentVersion) {
    printResult(
      opts.json,
      { status: "up_to_date", version: currentVersion },
      `Already up to date (${currentVersion}).`,
    );
    return { status: "up_to_date", version: currentVersion };
  }

  if (opts.checkOnly) {
    printResult(
      opts.json,
      { status: "available", from: currentVersion, to: latestVersion },
      `Update available: ${currentVersion} -> ${latestVersion}. Run \`mando upgrade\` to install it.`,
    );
    return { status: "available", from: currentVersion, to: latestVersion };
  }

  const assetName = `mando-${osName}-${archName}`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    const message = `release ${latestVersion} has no asset named ${assetName}`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  // Staged next to the binary being replaced (same directory, so the final
  // rename below is a same-filesystem, atomic operation) rather than in a
  // system temp dir, which could be a different filesystem/mount.
  const stagingPath = `${execPath}.new`;
  try {
    const assetRes = await fetchFn(asset.browser_download_url, { signal: AbortSignal.timeout(downloadTimeoutMs) });
    if (!assetRes.ok) {
      throw new Error(`asset download responded with status ${assetRes.status}`);
    }
    await Bun.write(stagingPath, assetRes);
    chmodSync(stagingPath, 0o755);
  } catch (error) {
    cleanupStagingFile(stagingPath);
    const message = `failed to download the update: ${errorMessage(error)}`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  // Verify the downloaded binary actually runs and reports the version we
  // just downloaded, before it ever replaces the binary currently running
  // this process -- a truncated download, a wrong asset, or a binary that
  // can't execute on this machine must never make it as far as the rename
  // below.
  const verify = exec(stagingPath, ["--version"]);
  const verifiedVersion = (verify.stdout.trim() || verify.stderr.trim());
  if (verify.status !== 0 || verifiedVersion !== latestVersion) {
    cleanupStagingFile(stagingPath);
    const message = `downloaded binary failed verification (expected \`--version\` to print ${latestVersion}, got ${verifiedVersion ? `\`${verifiedVersion}\`` : "nothing"})`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  // Best-effort rollback path: if this fails (disk full, permissions),
  // the upgrade still proceeds -- losing the ability to roll back is far
  // less harmful than refusing an otherwise-good, already-verified update.
  try {
    backup(execPath, `${execPath}.bak`);
  } catch {
    // Best-effort only, per the task brief.
  }

  try {
    // Renaming over the path of the currently-running executable is safe
    // on both Linux and macOS: the kernel keeps the running process's
    // existing inode/text mapping open by name, not by path, so this
    // process keeps running unaffected -- only the NEXT `mando` invocation
    // picks up the new binary. ETXTBSY only fires on an *open-for-write*
    // to a path backing a running executable, which a rename is not.
    install(stagingPath, execPath);
  } catch (error) {
    cleanupStagingFile(stagingPath);
    const message = isErrnoException(error) && error.code === "EPERM"
      ? `permission denied writing to ${execPath} -- reinstall instead: curl -fsSL https://raw.githubusercontent.com/${repo}/main/install.sh | sh`
      : `failed to install the update: ${errorMessage(error)}`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  printResult(
    opts.json,
    { status: "upgraded", from: currentVersion, to: latestVersion },
    `Upgraded ${currentVersion} -> ${latestVersion}.`,
  );
  return { status: "upgraded", from: currentVersion, to: latestVersion };
}
