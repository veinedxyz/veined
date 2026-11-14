// Explicit loopback-only development fixture origin. Never a deployment origin policy.
export const DEFAULT_E2E_ORIGIN = "http://127.0.0.1:3126";
export function parseE2EOrigin(raw = DEFAULT_E2E_ORIGIN) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}$/.test(raw))
    throw Error("E2E_ORIGIN_MUST_BE_EXACT_LOOPBACK");
  const url = new URL(raw);
  const port = Number(url.port);
  if (port < 1024 || port > 65535 || port === 3100 || url.origin !== raw)
    throw Error("E2E_PORT_MUST_BE_ISOLATED");
  return { origin: url.origin, host: url.host, port };
}
export function isolatedTestHost(env) {
  if (
    env.NODE_ENV !== "development" ||
    env.OTHERBRIDGE_MODE !== "local-test" ||
    env.OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION !== "false" ||
    env.OTHERBRIDGE_E2E_ISOLATED !== "1" ||
    !env.OTHERBRIDGE_E2E_ORIGIN
  )
    return null;
  try {
    return parseE2EOrigin(env.OTHERBRIDGE_E2E_ORIGIN).host;
  } catch {
    return null;
  }
}
