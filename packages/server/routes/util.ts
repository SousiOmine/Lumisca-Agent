import type { Context } from "npm:hono@4";

/** Respond with an error message JSON body. */
export function jsonError(c: Context, error: unknown, status: 400 = 400) {
  return c.json(
    { error: error instanceof Error ? error.message : String(error) },
    status,
  );
}
