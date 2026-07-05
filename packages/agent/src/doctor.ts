import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { readConfig } from "./config";
import { defaultExec, type ExecRunner } from "./autostart";
import { getOpencodeConfigDir } from "./install-command";
import { detectOpencodePort as defaultDetectOpencodePort } from "./opencode";
import { defaultPidFilePath, isProcessAlive as defaultIsProcessAlive, readPidFile } from "./daemon";

// How long the hub reachability check waits for GET /healthz before giving
// up -- per the task brief ("hub reachable ... bounded 5s"). Kept separate
// from opencode.ts's own PROBE_TIMEOUT_MS (1s): the hub is a remote network
// hop the diagnostic is specifically trying to characterize, so it gets a
// more generous budget than a same-host TCP probe.
const DEFAULT_HUB_HEALTH_TIMEOUT_MS = 5000;

// A narrower shape than `typeof fetch` (which, per Bun's lib types, also
// requires a static `preconnect` method) -- real `fetch` satisfies this
// structurally, so the real default below needs no cast, but tests can
// hand runDoctor a plain `async (url) => new Response(...)` fake without
// having to stub an unrelated static method just to satisfy the type.
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CheckStatus = "pass" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  // False if any check is "fail" -- what index.ts's `mando doctor` uses to
  // decide its exit code (see the task brief: "exit 1 if any FAIL"). A
  // "skip" (nothing meaningful to check, e.g. no hub URL configured yet)
  // never affects this on its own.
  ok: boolean;
}

export interface DoctorOpts {
  // Test-only injection points, mirroring connect.ts's ConnectOpts style --
  // none of these change runDoctor()'s documented behavior, they only let
  // tests swap the real network/process/exec calls for deterministic
  // stand-ins. Never invokes a real network request or subprocess in a
  // test.
  fetchFn?: FetchLike;
  exec?: ExecRunner;
  detectOpencodePort?: () => Promise<number | null>;
  isProcessAlive?: (pid: number) => boolean;
  hubHealthTimeoutMs?: number;
  opencodeBin?: string;
}

// runDoctor implements `mando doctor`: a fixed sequence of independent,
// read-mostly checks (see the task brief's list) covering every layer a
// working setup depends on -- local config, the hub, the background
// daemon, the local opencode server, the opencode binary itself, and the
// installed opencode commands -- so a broken setup can be diagnosed with
// one command instead of manually re-deriving each of these from `mando
// status`, curling the hub, and checking a few paths by hand.
export async function runDoctor(opts: DoctorOpts = {}): Promise<DoctorReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const exec = opts.exec ?? defaultExec;
  const detectOpencodePort = opts.detectOpencodePort ?? defaultDetectOpencodePort;
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const hubHealthTimeoutMs = opts.hubHealthTimeoutMs ?? DEFAULT_HUB_HEALTH_TIMEOUT_MS;
  const opencodeBin = opts.opencodeBin ?? process.env.MANDO_OPENCODE_BIN ?? "opencode";

  const checks: DoctorCheck[] = [];
  const config = readConfig();

  if (config?.hubUrl) {
    checks.push({ name: "config", status: "pass", detail: `hub URL configured: ${config.hubUrl}` });
  } else if (config) {
    checks.push({ name: "config", status: "fail", detail: "config file exists but has no hub URL" });
  } else {
    checks.push({ name: "config", status: "fail", detail: "no config found -- run `mando connect --hub <url>`" });
  }

  if (!config) {
    checks.push({ name: "token", status: "skip", detail: "no config to check" });
  } else if (config.token) {
    checks.push({ name: "token", status: "pass", detail: "pairing token present" });
  } else {
    checks.push({ name: "token", status: "fail", detail: "not paired -- run `mando connect --hub <url>`" });
  }

  if (!config?.hubUrl) {
    checks.push({ name: "hub", status: "skip", detail: "no hub URL configured" });
  } else {
    checks.push(await checkHubReachable(fetchFn, config.hubUrl, hubHealthTimeoutMs));
  }

  const pid = readPidFile(defaultPidFilePath());
  if (pid !== null && isProcessAlive(pid)) {
    checks.push({ name: "daemon", status: "pass", detail: `running (pid ${pid})` });
  } else {
    checks.push({
      name: "daemon",
      status: "fail",
      detail: pid === null ? "not running (no pidfile) -- run `mando connect`" : `not running (stale pidfile, pid ${pid}) -- run \`mando connect\``,
    });
  }

  const opencodePort = await detectOpencodePort();
  if (opencodePort) {
    checks.push({ name: "opencode-server", status: "pass", detail: `reachable on port ${opencodePort}` });
  } else {
    checks.push({
      name: "opencode-server",
      status: "fail",
      detail: "no local opencode server detected -- start one with `opencode serve` or `mando connect --opencode-auto`",
    });
  }

  checks.push(checkOpencodeBinary(exec, opencodeBin));
  checks.push(checkCommandsInstalled());

  return { checks, ok: !checks.some((c) => c.status === "fail") };
}

async function checkHubReachable(fetchFn: FetchLike, hubUrl: string, timeoutMs: number): Promise<DoctorCheck> {
  try {
    const res = await fetchFn(`${hubUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.ok
      ? { name: "hub", status: "pass", detail: `reachable at ${hubUrl} (status ${res.status})` }
      : { name: "hub", status: "fail", detail: `${hubUrl}/healthz responded with status ${res.status}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { name: "hub", status: "fail", detail: `could not reach ${hubUrl}: ${detail}` };
  }
}

function checkOpencodeBinary(exec: ExecRunner, opencodeBin: string): DoctorCheck {
  const result = exec(opencodeBin, ["--version"]);
  if (result.status !== 0) {
    return {
      name: "opencode-binary",
      status: "fail",
      detail: `\`${opencodeBin} --version\` failed -- is opencode installed and on PATH?`,
    };
  }
  const version = result.stdout.trim() || result.stderr.trim();
  return { name: "opencode-binary", status: "pass", detail: version ? `opencode ${version}` : "opencode found on PATH" };
}

function checkCommandsInstalled(): DoctorCheck {
  const commandsDir = join(getOpencodeConfigDir(), "commands");
  const paths = [join(commandsDir, "mando.md"), join(commandsDir, "mando-refresh.md")];
  const missing = paths.filter((p) => !existsSync(p));

  return missing.length === 0
    ? { name: "commands", status: "pass", detail: `installed in ${commandsDir}` }
    : {
        name: "commands",
        status: "fail",
        detail: `missing ${missing.map((p) => basename(p)).join(", ")} in ${commandsDir} -- run \`mando install-command\``,
      };
}

// formatDoctorReport renders the report as the one-PASS/FAIL/SKIP-line-per-
// check human output `mando doctor` prints without --json. Every status
// word is exactly four letters (pass/fail/skip), so upper-casing them all
// lines up without any padding logic.
export function formatDoctorReport(report: DoctorReport): string {
  return report.checks.map((c) => `${c.status.toUpperCase()}  ${c.name}: ${c.detail}`).join("\n");
}
