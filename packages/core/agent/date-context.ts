import { today } from "../environment.ts";
import type { ContextProvider, ContextUpdate } from "./context-providers.ts";

/**
 * The date context provider: publishes the current date as a durable
 * transcript message instead of baking it into the system prompt.
 *
 * The date is the one environment fact that changes while a session lives.
 * In the prompt it would freeze at session creation (the prompt is a
 * snapshot), so a session left open overnight would keep working from
 * yesterday; changing the prompt instead would cost the provider's whole
 * cached prefix. As a context message it is paid once, appended (never
 * inserted), and republished only when the day actually changes — the same
 * shape as the other dynamic contexts (see agent/context-providers.ts).
 */

/** Provider name of the date context. */
export const DATE_PROVIDER = "date";

export interface DateContextOptions {
  /** Clock override (tests). Defaults to the real clock. */
  now?: () => Date;
}

interface DateState {
  date: string;
}

function dateOf(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const date = (state as DateState).date;
  return typeof date === "string" ? date : undefined;
}

export function createDateProvider(
  options: DateContextOptions = {},
): ContextProvider {
  const now = options.now ?? (() => new Date());
  /** The date of the last publication; undefined until the first one. */
  let published: string | undefined;

  return {
    name: DATE_PROVIDER,
    next(): ContextUpdate[] {
      const date = today(now());
      if (published === date) return [];
      const replaced = published !== undefined;
      published = date;
      return [{
        title: `Date: ${date}`,
        body: `The current date is ${date}.${
          replaced
            ? " This reading replaces the earlier one: the previous date is no longer current."
            : ""
        }`,
        state: { date } satisfies DateState,
      }];
    },
    rebase(state: unknown): void {
      published = dateOf(state);
    },
  };
}
