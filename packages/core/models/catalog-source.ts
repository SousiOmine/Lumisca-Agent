import snapshot, {
  generatedAt as snapshotGeneratedAt,
} from "@opencode-ai/models/snapshot";
import type { ProviderMap } from "@opencode-ai/models";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import { errorMessage } from "../errors.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import { atomicWriteTextFileSync, isRecord } from "../fs.ts";
import type { CatalogSourceKind, CatalogStatus } from "../shared/providers.ts";
export type { CatalogSourceKind, CatalogStatus };

const log = createLogger("catalog");

/** Default models.dev deployment serving `/api.json`. */
export const MODELS_DEV_BASE_URL = "https://models.dev";

/** Timeout for the live models.dev fetch (startup must never block). */
export const LIVE_CATALOG_TIMEOUT_MS = 5_000;

/** File name of the cached catalog next to the settings file. */
export const CACHED_CATALOG_FILE = "model-catalog.json";

/** A models.dev provider catalog with its generation timestamp. */
export interface CatalogSource {
  providers: ProviderMap;
  generatedAt?: string;
}

/** Minimal shape guard for a ProviderMap: every provider carries a
 * `models` record whose entries at least have string `id`/`name`. The
 * remaining fields (npm/env/api/limit/... — see `toLumiscaProvider`, which
 * substitutes defaults) stay optional so a future models.dev shape change
 * degrades to the transport fallback instead of failing the whole refresh.
 * A map with no providers at all is rejected: an empty 200 OK (outage, a
 * proxy error parsed as JSON, ...) must fall through to the cache/snapshot
 * path rather than wipe the built-in registry. */
export function isProviderMap(value: unknown): value is ProviderMap {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  for (const provider of Object.values(value)) {
    if (!isRecord(provider)) return false;
    const models = (provider as Record<string, unknown>).models;
    if (!isRecord(models)) return false;
    for (const model of Object.values(models)) {
      if (!isRecord(model)) return false;
      if (typeof model.id !== "string") return false;
      if (typeof model.name !== "string") return false;
    }
  }
  return true;
}

/** Fetch the live provider catalog (`GET {baseUrl}/api.json`). Throws on
 * transport failure, non-2xx status, malformed JSON, or shape mismatch —
 * callers decide the fallback (see `resolveCatalogSource`). */
export async function fetchLiveCatalog(
  options: {
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    baseUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<CatalogSource> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? LIVE_CATALOG_TIMEOUT_MS;
  const base = options.baseUrl ?? MODELS_DEV_BASE_URL;
  const url = base.endsWith("/") ? `${base}api.json` : `${base}/api.json`;
  const signal = options.signal ??
    (typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined);
  let res: Response;
  try {
    res = await fetchFn(url, signal !== undefined ? { signal } : undefined);
  } catch (error) {
    throw new Error(`models.dev fetch failed: ${errorMessage(error)}`);
  }
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // Ignore cancellation errors; the status is what matters.
    }
    throw new Error(`models.dev responded with status ${res.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (error) {
    throw new Error(`models.dev returned invalid JSON: ${errorMessage(error)}`);
  }
  if (!isProviderMap(parsed)) {
    throw new Error("models.dev returned an unexpected catalog shape");
  }
  return { providers: parsed };
}

interface CachedCatalogFile {
  savedAt: number;
  generatedAt?: string;
  providers: ProviderMap;
}

function cachedPath(dir: string): string {
  return join(dir, CACHED_CATALOG_FILE);
}

/** Load the cached catalog written by a previous successful refresh, or
 * undefined when absent/unreadable/invalid (including in-memory settings
 * with no directory). Corrupt caches read as absent and are overwritten
 * on the next successful refresh. */
export function loadCachedCatalog(
  dir: string | undefined,
): CatalogSource | undefined {
  if (dir === undefined) return undefined;
  let text: string;
  try {
    text = Deno.readTextFileSync(cachedPath(dir));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      log.debug(`cached catalog unreadable: ${errorMessage(error)}`);
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    log.debug(`cached catalog is not JSON: ${errorMessage(error)}`);
    return undefined;
  }
  if (!isRecord(parsed) || !isProviderMap(parsed.providers)) {
    log.debug("cached catalog has an unexpected shape");
    return undefined;
  }
  const generatedAt = typeof parsed.generatedAt === "string"
    ? parsed.generatedAt
    : undefined;
  return {
    providers: parsed.providers as ProviderMap,
    generatedAt,
  };
}

/** Persist a successfully fetched catalog next to the settings file
 * (atomic tmp + rename, mode 0o600 like the settings file). No-op for
 * in-memory settings (no directory). Throwing here must never fail a
 * refresh — callers treat a save failure as debug noise. */
export function saveCachedCatalog(
  dir: string | undefined,
  source: CatalogSource,
): void {
  if (dir === undefined) return;
  const payload: CachedCatalogFile = {
    savedAt: Date.now(),
    ...(source.generatedAt !== undefined
      ? { generatedAt: source.generatedAt }
      : {}),
    providers: source.providers,
  };
  try {
    atomicWriteTextFileSync(cachedPath(dir), JSON.stringify(payload), {
      mode: 0o600,
    });
  } catch (error) {
    log.debug(`cached catalog write failed: ${errorMessage(error)}`);
  }
}

/** The bundled snapshot catalog (the offline fallback). */
export function snapshotCatalog(): CatalogSource {
  return {
    providers: snapshot.providers as ProviderMap,
    generatedAt: snapshotGeneratedAt,
  };
}

/** Resolve the catalog in `live → cache → snapshot` order. Never throws:
 * every failure is recorded on the returned status (`error`) and logged
 * at debug level, so the app always starts with a usable catalog. */
export async function resolveCatalogSource(
  options: {
    settings: Pick<SettingsRepo, "dir">;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    baseUrl?: string;
  },
): Promise<{ source: CatalogSource; status: CatalogStatus }> {
  const lastCheckAt = Date.now();
  try {
    const live = await fetchLiveCatalog({
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      baseUrl: options.baseUrl,
    });
    saveCachedCatalog(options.settings.dir(), live);
    return {
      source: live,
      status: {
        source: "live",
        ...(live.generatedAt !== undefined
          ? { generatedAt: live.generatedAt }
          : {}),
        lastCheckAt,
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    log.debug(`live catalog unavailable: ${message}`);
    const cached = loadCachedCatalog(options.settings.dir());
    if (cached !== undefined) {
      return {
        source: cached,
        status: {
          source: "cache",
          ...(cached.generatedAt !== undefined
            ? { generatedAt: cached.generatedAt }
            : {}),
          lastCheckAt,
          error: message,
        },
      };
    }
    const fallback = snapshotCatalog();
    return {
      source: fallback,
      status: {
        source: "snapshot",
        ...(fallback.generatedAt !== undefined
          ? { generatedAt: fallback.generatedAt }
          : {}),
        lastCheckAt,
        error: message,
      },
    };
  }
}
