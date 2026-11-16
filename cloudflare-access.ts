/**
 * Cloudflare Access service token (fork-specific, see .claude/skills/sync-upstream).
 *
 * A service token is a pair: Cloudflare Access only accepts the request when
 * both `CF-Access-Client-Id` and `CF-Access-Client-Secret` are present. The
 * pair comes from the process environment only. There is deliberately no CLI
 * flag: a command-line argument is visible in the process list.
 *
 * Nothing in this module may put a value in a message: warnings name the
 * variable, never its content.
 */
import type { Dispatcher } from "undici";

export const CF_ACCESS_CLIENT_ID_ENV = "CF_ACCESS_CLIENT_ID";
export const CF_ACCESS_CLIENT_SECRET_ENV = "CF_ACCESS_CLIENT_SECRET";

export const CF_ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const CF_ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

export interface CloudflareAccessServiceTokenSource {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly warn: (message: string) => void;
}

const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

// Printable ASCII only. fetch() rejects other header values with an error that
// can quote the value, so such a value must never reach a request.
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]+$/;

function presentValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve the service token headers once, at startup.
 *
 * Both variables set and usable: the two headers. Neither set: no header and no
 * warning, so a deployment that does not use the feature is untouched. Anything
 * else (one of the two missing or empty, or a value that cannot be an HTTP
 * header value): no header at all, and one warning that names the variable.
 */
export function resolveCloudflareAccessServiceTokenHeaders(
  source: CloudflareAccessServiceTokenSource
): Readonly<Record<string, string>> {
  const clientId = presentValue(source.clientId);
  const clientSecret = presentValue(source.clientSecret);

  if (clientId === undefined && clientSecret === undefined) {
    return NO_HEADERS;
  }

  if (clientId === undefined || clientSecret === undefined) {
    const present = clientId === undefined ? CF_ACCESS_CLIENT_SECRET_ENV : CF_ACCESS_CLIENT_ID_ENV;
    const missing = clientId === undefined ? CF_ACCESS_CLIENT_ID_ENV : CF_ACCESS_CLIENT_SECRET_ENV;
    source.warn(
      `Ignoring ${present} because ${missing} is not set: the Cloudflare Access service token headers are sent only when both are set`
    );
    return NO_HEADERS;
  }

  for (const [name, value] of [
    [CF_ACCESS_CLIENT_ID_ENV, clientId],
    [CF_ACCESS_CLIENT_SECRET_ENV, clientSecret],
  ] as const) {
    if (!HEADER_VALUE_PATTERN.test(value)) {
      source.warn(
        `Ignoring ${CF_ACCESS_CLIENT_ID_ENV} and ${CF_ACCESS_CLIENT_SECRET_ENV} because ${name} is not a valid HTTP header value: the Cloudflare Access service token headers are not sent`
      );
      return NO_HEADERS;
    }
  }

  return Object.freeze({
    [CF_ACCESS_CLIENT_ID_HEADER]: clientId,
    [CF_ACCESS_CLIENT_SECRET_HEADER]: clientSecret,
  });
}

const SERVICE_TOKEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  CF_ACCESS_CLIENT_ID_HEADER.toLowerCase(),
  CF_ACCESS_CLIENT_SECRET_HEADER.toLowerCase(),
]);

function isServiceTokenHeader(name: unknown): boolean {
  return SERVICE_TOKEN_HEADER_NAMES.has(String(name).toLowerCase());
}

/** Removes the service token headers from every header shape a dispatcher accepts. */
function withoutServiceTokenHeaders(
  headers: Dispatcher.DispatchOptions["headers"]
): Dispatcher.DispatchOptions["headers"] {
  if (headers === null || headers === undefined) {
    return headers;
  }
  if (Array.isArray(headers)) {
    // Flat [name, value, name, value, ...] list.
    const kept: string[] = [];
    for (let index = 0; index + 1 < headers.length; index += 2) {
      if (!isServiceTokenHeader(headers[index])) {
        kept.push(headers[index], headers[index + 1]);
      }
    }
    return kept;
  }
  if (Symbol.iterator in headers) {
    return [...headers].filter(([name]) => !isServiceTokenHeader(name));
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isServiceTokenHeader(name))
  );
}

function originOf(value: unknown): string | undefined {
  try {
    return new URL(String(value)).origin;
  } catch {
    return undefined;
  }
}

const guardedDispatchers = new WeakMap<Dispatcher, Map<string, Dispatcher>>();

/**
 * Keeps the service token on the GitLab origin it was configured for.
 *
 * fetch() follows a redirect with every custom header of the first request, and
 * only drops Authorization and Cookie on another origin. Each hop goes through
 * the dispatcher, so this is where the two headers are removed from a request
 * whose origin is not the origin of `apiUrl` (an identity provider, object
 * storage, a CDN). An unparsable `apiUrl` matches no origin: the headers are
 * then removed from every request.
 *
 * Without a service token the dispatcher is returned as is, so nothing changes
 * for a deployment that does not use the feature.
 */
export function guardCloudflareAccessServiceToken(
  dispatcher: Dispatcher,
  apiUrl: string,
  serviceTokenHeaders: Readonly<Record<string, string>>
): Dispatcher {
  if (Object.keys(serviceTokenHeaders).length === 0) {
    return dispatcher;
  }

  const allowedOrigin = originOf(apiUrl);
  const cacheKey = allowedOrigin ?? "";
  let byOrigin = guardedDispatchers.get(dispatcher);
  if (byOrigin === undefined) {
    byOrigin = new Map();
    guardedDispatchers.set(dispatcher, byOrigin);
  }
  const cached = byOrigin.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const guarded = dispatcher.compose(dispatch => (options, handler) => {
    const requestOrigin = originOf(options.origin);
    if (allowedOrigin !== undefined && requestOrigin === allowedOrigin) {
      return dispatch(options, handler);
    }
    return dispatch({ ...options, headers: withoutServiceTokenHeaders(options.headers) }, handler);
  });
  byOrigin.set(cacheKey, guarded);
  return guarded;
}
