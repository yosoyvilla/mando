import { test, expect } from "bun:test";
import { assertSafeProviderUrl, UnsafeProviderUrlError } from "../../src/providers/url-guard";

function resolverReturning(...addresses: string[]) {
  return async () => addresses;
}

function throwingResolver() {
  return async () => {
    throw new Error("dns lookup failed");
  };
}

test("rejects a non-https scheme", async () => {
  await expect(assertSafeProviderUrl("http://example.com")).rejects.toThrow(UnsafeProviderUrlError);
});

test("rejects a malformed URL", async () => {
  await expect(assertSafeProviderUrl("not a url")).rejects.toThrow(UnsafeProviderUrlError);
});

test("rejects the literal loopback host name", async () => {
  await expect(assertSafeProviderUrl("https://localhost/v1")).rejects.toThrow(UnsafeProviderUrlError);
});

test.each([
  ["127.0.0.1", "loopback"],
  ["10.1.2.3", "10/8 private"],
  ["172.16.5.5", "172.16/12 private"],
  ["172.31.255.255", "172.16/12 private upper bound"],
  ["192.168.1.1", "192.168/16 private"],
  ["169.254.169.254", "cloud metadata"],
  ["169.254.170.2", "ECS metadata"],
  ["100.64.0.1", "CGNAT 100.64/10"],
])("rejects literal IPv4 host %s (%s)", async (ip) => {
  await expect(assertSafeProviderUrl(`https://${ip}/v1`)).rejects.toThrow(UnsafeProviderUrlError);
});

test.each([
  ["[::1]", "IPv6 loopback"],
  ["[fe80::1]", "fe80::/10 link-local"],
  ["[fc00::1]", "fc00::/7 ULA"],
  ["[fd12:3456:789a::1]", "fc00::/7 ULA upper half"],
  ["[::ffff:169.254.169.254]", "IPv4-mapped cloud metadata"],
  ["[::ffff:10.0.0.5]", "IPv4-mapped 10/8 private"],
])("rejects literal IPv6 host %s (%s)", async (host) => {
  await expect(assertSafeProviderUrl(`https://${host}/v1`)).rejects.toThrow(UnsafeProviderUrlError);
});

test("rejects a public-looking hostname whose DNS resolution returns a metadata address", async () => {
  await expect(
    assertSafeProviderUrl("https://evil.example.com/v1", {
      resolver: resolverReturning("169.254.169.254"),
    }),
  ).rejects.toThrow(UnsafeProviderUrlError);
});

test("rejects when any one of several resolved addresses is private, even if others are public", async () => {
  await expect(
    assertSafeProviderUrl("https://mixed.example.com/v1", {
      resolver: resolverReturning("93.184.216.34", "127.0.0.1"),
    }),
  ).rejects.toThrow(UnsafeProviderUrlError);
});

test("rejects when DNS resolution returns a private IPv6 address", async () => {
  await expect(
    assertSafeProviderUrl("https://evil6.example.com/v1", {
      resolver: resolverReturning("fc00::1"),
    }),
  ).rejects.toThrow(UnsafeProviderUrlError);
});

test("rejects when the resolver itself fails", async () => {
  await expect(
    assertSafeProviderUrl("https://unresolvable.example.com/v1", { resolver: throwingResolver() }),
  ).rejects.toThrow(UnsafeProviderUrlError);
});

test("rejects when the resolver returns no addresses at all", async () => {
  await expect(
    assertSafeProviderUrl("https://empty.example.com/v1", { resolver: resolverReturning() }),
  ).rejects.toThrow(UnsafeProviderUrlError);
});

test("accepts a literal public IPv4 address", async () => {
  await expect(assertSafeProviderUrl("https://1.1.1.1/v1")).resolves.toBeUndefined();
});

test("accepts a public https hostname via an injected resolver returning only public addresses", async () => {
  await expect(
    assertSafeProviderUrl("https://api.nan.builders/v1", {
      resolver: resolverReturning("203.0.113.42"),
    }),
  ).resolves.toBeUndefined();
});
