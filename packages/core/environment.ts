import { formatLocalDay } from "./shared/mod.ts";

/** Model facts, as the model context publishes them. */
export interface EnvironmentModel {
  provider: string;
  modelId: string;
  /** Human-readable display name (falls back to provider/modelId). */
  name?: string;
}

/** e.g. "2026-08-11 (Tuesday)". Both the date and the weekday name come
 * from the same instant on the MACHINE's clock (the process's local zone),
 * so a reader in another zone sees the date this machine works by.
 *
 * The date is published as a context message rather than written into the
 * system prompt (see agent/date-context.ts): it changes every day, and a
 * prompt that changed daily would throw away the provider's cached prefix.
 */
export function today(now: Date = new Date()): string {
  return formatLocalDay(now, "en-US");
}
