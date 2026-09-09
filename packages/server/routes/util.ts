import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/http-status";
import { CoreError, errorMessage } from "@lumisca/core";

/** Hostnames that always mean "this machine". Shared by the Host guard and
 * the federation self-check. */
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** True when the hostname is a loopback address. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** Error with an explicit HTTP status. Thrown by route handlers when the
 * status matters (e.g. 404); everything else is classified by errorStatus. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode,
  ) {
    super(message);
  }
}

/** Classify an unknown error into an HTTP status. Route handlers throw
 * AppError; the core throws typed CoreError (kind maps to a status), so
 * error messages are never matched by text. Anything unclassified is a
 * server fault and maps to 500, never 400 — the client must be able to
 * distinguish "bad input" from "server is broken". */
export function errorStatus(error: unknown): ContentfulStatusCode {
  if (error instanceof AppError) return error.status;
  if (error instanceof CoreError) {
    if (error.kind === "not_found") return 404;
    if (error.kind === "forbidden") return 403;
    if (error.kind === "conflict") return 409;
    if (error.kind === "unavailable") return 503;
    if (error.kind === "invalid") return 400;
  }
  return 500;
}

/** Respond with an error message JSON body. */
export function jsonError(
  c: Context,
  error: unknown,
  status?: ContentfulStatusCode,
) {
  return c.json(
    { error: errorMessage(error) },
    status ?? errorStatus(error),
  );
}

/** Parse a JSON request body. Throws 400 on malformed JSON — a syntax
 * error must not masquerade as "field X is required" — and returns
 * undefined only when the body is empty. */
export async function parseBody<T = unknown>(
  c: Context,
): Promise<T | undefined> {
  const text = await c.req.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("Invalid JSON body", 400);
  }
}

/** Require the parsed body itself (most POST/PUT handlers need an object,
 * not an empty body). */
export function requireBody<T>(body: T | undefined, what = "JSON body"): T {
  if (body === undefined || body === null) {
    throw new AppError(`${what} is required`, 400);
  }
  return body;
}

/** Require a string field; throws `"<what> is required"` otherwise.
 * Empty strings pass — use {@link requireNonEmptyString} when emptiness
 * is also invalid. */
export function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require a non-empty string field; throws `"<what> is required"` for
 * missing, non-string, or empty values. */
export function requireNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require a boolean field; throws `"<what> is required"` otherwise. */
export function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require a finite-number field; throws `"<what> is required"`
 * otherwise. */
export function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require an array field; throws `"<what> is required"` otherwise. */
export function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require a string array whose entries are all non-empty; throws
 * `"<what> is required"` otherwise. Shared by workspace folders and any
 * future string-list field so the coercion never varies. */
export function requireStringArray(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || v.length === 0)
  ) {
    throw new AppError(`${what} is required`, 400);
  }
  return value as string[];
}

/** A small TTL cache: entries expire `ttlMs` after being set; with `max`
 * set, the oldest entry is evicted on overflow. Shared by the workspace
 * file cache and the provider auth cache so the pattern lives once. */
export function ttlCache<K, V>(ttlMs: number, max?: number): {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
} {
  const entries = new Map<K, { at: number; value: V }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (Date.now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.set(key, { at: Date.now(), value });
      if (max !== undefined && entries.size > max) {
        let oldest: K | undefined;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [k, entry] of entries) {
          if (entry.at < oldestAt) {
            oldestAt = entry.at;
            oldest = k;
          }
        }
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    },
  };
}
