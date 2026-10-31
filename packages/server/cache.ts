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
