import { randomUUID } from "node:crypto";
// Public error envelope: fixed messages only. No internal hosts, stacks, SQL or provider secrets.
export const ERRORS = {
  INVALID_REQUEST: [400, "The request is invalid."],
  INVALID_ADDRESS: [400, "The address is not valid for this ecosystem."],
  INVALID_CURSOR: [400, "The pagination cursor is invalid."],
  UNAUTHORIZED: [401, "A valid API key is required."],
  CLIENT_SUSPENDED: [403, "This API client is not active."],
  SCOPE_DENIED: [403, "The API key does not grant this scope."],
  NOT_FOUND: [404, "The resource was not found."],
  METHOD_NOT_ALLOWED: [405, "Only read-only GET requests are supported."],
  RATE_LIMITED: [429, "Rate limit exceeded."],
  QUOTA_EXCEEDED: [429, "Daily quota exceeded."],
  CONCURRENCY_LIMIT: [429, "Too many concurrent requests."],
  CHAIN_UNSUPPORTED: [422, "This chain is not covered for the requested data."],
  UPSTREAM_UNAVAILABLE: [503, "Chain data is temporarily unavailable."],
  RATE_LIMIT_UNAVAILABLE: [
    503,
    "Request protection is unavailable; the request was refused.",
  ],
  SERVICE_UNAVAILABLE: [503, "The service is temporarily unavailable."],
  TIMEOUT: [504, "The request exceeded its time budget."],
  INTERNAL: [500, "Unexpected error."],
} as const;
export type ErrorCode = keyof typeof ERRORS;
export class ApiError extends Error {
  constructor(public code: ErrorCode) {
    super(code);
    this.name = "ApiError";
  }
}
export const newRequestId = () => `req_${randomUUID().replace(/-/g, "")}`;
export function baseHeaders(
  requestId: string,
  extra: Record<string, string> = {},
) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  };
}
export function errorResponse(
  code: ErrorCode,
  requestId: string,
  extra: Record<string, string> = {},
) {
  const [status, message] = ERRORS[code];
  return new Response(JSON.stringify({ error: { code, message, requestId } }), {
    status,
    headers: baseHeaders(requestId, extra),
  });
}
const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v;
export function json(
  body: unknown,
  requestId: string,
  extra: Record<string, string> = {},
) {
  return new Response(JSON.stringify({ data: body, requestId }, replacer), {
    status: 200,
    headers: baseHeaders(requestId, extra),
  });
}
