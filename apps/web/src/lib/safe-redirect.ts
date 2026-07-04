// Guards the post-login destination against an open redirect. `redirect` is
// attacker-controlled: it round-trips through the `?redirect=` search param
// that RequireAuth stamps onto the /login link, so anything we don't
// recognize as an app-internal relative path is rejected in favor of "/".
//
// Rejects:
// - missing/empty values
// - absolute URLs with a scheme (e.g. "https://evil.com")
// - protocol-relative URLs (e.g. "//evil.com", which browsers resolve
//   against the current scheme)
// - backslash variants of the above (e.g. "/\evil.com"), since some
//   browsers normalize a leading "\" the same as "/"
export function getSafePostLoginRedirect(
  redirect: string | undefined,
): string {
  if (!redirect) return "/";
  if (!/^\/(?!\/|\\)/.test(redirect)) return "/";
  return redirect;
}
