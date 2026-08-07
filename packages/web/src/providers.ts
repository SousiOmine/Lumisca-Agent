import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { ProviderInfo } from "./types.ts";

/** Load the provider list once; `reload()` re-fetches. Failures are
 * surfaced separately so callers can tell "no providers configured" apart
 * from "server unreachable". */
export function useProviders(): {
  providers: ProviderInfo[];
  error: string | null;
  reload: () => void;
} {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    setError(null);
    api.listProviders()
      .then(setProviders)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(reload, []);
  return { providers, error, reload };
}

/** Case-insensitive substring filter on id/name; empty query returns all. */
export function filterByQuery<T extends { id: string; name?: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      (m.name ?? "").toLowerCase().includes(q),
  );
}

/** Human-readable error string, used across every async UI surface. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
