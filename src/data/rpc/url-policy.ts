import { isIP } from "node:net";
// Static RPC URL admission. Remote registries are untrusted input; users can never supply URLs.
export type UrlVerdict =
  { ok: true; url: string; host: string } | { ok: false; reason: string };
const blockedSuffix =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|example|invalid|onion|arpa)$/i;
const metadataHosts = new Set([
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "metadata.azure.com",
]);
export function admitRpcUrl(
  raw: unknown,
  options: { allowPort?: boolean } = {},
): UrlVerdict {
  if (typeof raw !== "string" || raw.length > 300)
    return { ok: false, reason: "URL_INVALID" };
  if (/[{}$\s<>"'`\\]/.test(raw)) return { ok: false, reason: "URL_TEMPLATE" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URL_INVALID" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "HTTPS_REQUIRED" };
  if (url.username || url.password)
    return { ok: false, reason: "CREDENTIALS_IN_URL" };
  if (url.search || url.hash) return { ok: false, reason: "QUERY_REJECTED" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, "")))
    return { ok: false, reason: "IP_LITERAL" };
  if (
    !/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      host,
    ) ||
    blockedSuffix.test(host) ||
    metadataHosts.has(host)
  )
    return { ok: false, reason: "HOST_REJECTED" };
  if (
    url.port &&
    !(options.allowPort && /^(443|8443|[1-9]\d{3,4})$/.test(url.port))
  )
    return { ok: false, reason: "PORT_REJECTED" };
  if (!/^[A-Za-z0-9._~/-]*$/.test(url.pathname) || url.pathname.length > 120)
    return { ok: false, reason: "PATH_REJECTED" };
  // Path segments that look like API keys/project IDs are secret-bearing templates; reject them.
  for (const segment of url.pathname.split("/"))
    if (
      segment.length >= 20 &&
      /[0-9]/.test(segment) &&
      /[a-zA-Z]/.test(segment) &&
      /^[A-Za-z0-9_-]+$/.test(segment)
    )
      return { ok: false, reason: "SECRET_LIKE_PATH" };
  if (/(api[-_]?key|apikey|token|secret|auth)/i.test(url.pathname))
    return { ok: false, reason: "SECRET_LIKE_PATH" };
  return {
    ok: true,
    url: `https://${host}${url.port ? `:${url.port}` : ""}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`,
    host,
  };
}
