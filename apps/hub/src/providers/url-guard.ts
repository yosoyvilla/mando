import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class UnsafeProviderUrlError extends Error {
  constructor(reason: string) {
    super(`unsafe provider URL: ${reason}`);
    this.name = "UnsafeProviderUrlError";
  }
}

export type ProviderUrlResolver = (hostname: string) => Promise<string[]>;

// Default resolver: every address a real DNS lookup would return (both A
// and AAAA records), not just the first one -- a DNS-rebinding or
// multi-answer response that mixes one public and one metadata/private
// address must fail closed on the private one, not succeed because the
// first answer happened to look safe.
const defaultResolver: ProviderUrlResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

// IPv4 CIDRs to reject: RFC1918 private ranges, loopback, link-local
// (includes both the cloud metadata address 169.254.169.254 and the ECS
// task metadata address 169.254.170.2 -- both fall inside 169.254.0.0/16),
// and the RFC6598 CGNAT range some cloud providers route internal traffic
// through.
const IPV4_DENYLIST: Array<{ network: string; prefix: number }> = [
  { network: "10.0.0.0", prefix: 8 },
  { network: "172.16.0.0", prefix: 12 },
  { network: "192.168.0.0", prefix: 16 },
  { network: "127.0.0.0", prefix: 8 },
  { network: "169.254.0.0", prefix: 16 },
  { network: "100.64.0.0", prefix: 10 },
];

function ipv4ToInt(address: string): number {
  const parts = address.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateIPv4(address: string): boolean {
  const addrInt = ipv4ToInt(address);
  return IPV4_DENYLIST.some(({ network, prefix }) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (addrInt & mask) === (ipv4ToInt(network) & mask);
  });
}

function bigIntToIPv4(value: bigint): string {
  const n = Number(value & 0xffffffffn);
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff).join(".");
}

// Expands any valid textual IPv6 address (with "::" compression and/or a
// trailing embedded IPv4 tail like "::ffff:169.254.169.254") into a single
// 128-bit integer, so range checks below are plain bit-shift comparisons
// instead of fragile string matching.
function ipv6ToBigInt(address: string): bigint {
  let addr = address.toLowerCase();

  const lastColonIdx = addr.lastIndexOf(":");
  const tail = addr.slice(lastColonIdx + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      throw new Error("invalid embedded IPv4 in IPv6 address");
    }
    const hi = (((octets[0]! << 8) | octets[1]!) & 0xffff).toString(16);
    const lo = (((octets[2]! << 8) | octets[3]!) & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColonIdx + 1)}${hi}:${lo}`;
  }

  let head: string[];
  let tail2: string[];
  if (addr.includes("::")) {
    const parts = addr.split("::");
    if (parts.length > 2) throw new Error("invalid IPv6 address");
    head = parts[0] ? parts[0].split(":").filter((g) => g.length > 0) : [];
    tail2 = parts[1] ? parts[1].split(":").filter((g) => g.length > 0) : [];
  } else {
    head = addr.split(":");
    tail2 = [];
  }

  const missing = 8 - head.length - tail2.length;
  if (missing < 0) throw new Error("invalid IPv6 address");
  const groups = [...head, ...Array(missing).fill("0"), ...tail2];
  if (groups.length !== 8) throw new Error("invalid IPv6 address");

  let result = 0n;
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) throw new Error("invalid IPv6 address");
    result = (result << 16n) | BigInt(value);
  }
  return result;
}

function isIPv4Mapped(big: bigint): boolean {
  return big >> 32n === 0xffffn;
}

// ::1 (loopback), fe80::/10 (link-local), fc00::/7 (unique local / ULA).
function isPrivateIPv6(big: bigint): boolean {
  if (big === 1n) return true;
  if (big >> 118n === 0x3fan) return true; // fe80::/10
  if (big >> 121n === 0x7en) return true; // fc00::/7
  return false;
}

function assertPublicAddress(address: string, version: 4 | 6): void {
  if (version === 4) {
    if (isPrivateIPv4(address)) {
      throw new UnsafeProviderUrlError(`address ${address} is a private/reserved IPv4 address`);
    }
    return;
  }

  const big = ipv6ToBigInt(address);
  if (isIPv4Mapped(big)) {
    const mapped = bigIntToIPv4(big);
    if (isPrivateIPv4(mapped)) {
      throw new UnsafeProviderUrlError(`address ${address} is an IPv4-mapped private/reserved address (${mapped})`);
    }
    return;
  }

  if (isPrivateIPv6(big)) {
    throw new UnsafeProviderUrlError(`address ${address} is a private/reserved IPv6 address`);
  }
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

// Validates a user-supplied provider base URL against SSRF: https only,
// and every IP it could actually connect to -- whether given literally or
// reached by resolving a DNS name -- must be public. Called both at save
// time (providers/routes.ts PUT) and, per the plan's Global Constraints,
// again immediately before each outbound provider request (Task 3, not
// implemented here) since a name that resolved safely at save time can
// re-resolve to a private address later (DNS rebinding).
export async function assertSafeProviderUrl(
  rawUrl: string,
  options: { resolver?: ProviderUrlResolver } = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeProviderUrlError("must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new UnsafeProviderUrlError("only https URLs are allowed");
  }

  const hostname = stripBrackets(parsed.hostname);

  if (hostname.toLowerCase() === "localhost") {
    throw new UnsafeProviderUrlError("localhost is not allowed");
  }

  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    assertPublicAddress(hostname, ipVersion as 4 | 6);
    return;
  }

  const resolver = options.resolver ?? defaultResolver;
  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new UnsafeProviderUrlError("failed to resolve host");
  }

  if (addresses.length === 0) {
    throw new UnsafeProviderUrlError("host did not resolve to any address");
  }

  for (const address of addresses) {
    const version = isIP(address);
    if (version === 0) continue;
    assertPublicAddress(address, version as 4 | 6);
  }
}
