import { useState } from "preact/compat";
import { request } from "../api-client.ts";
import { NEVER, useVisibleInterval } from "./useVisibleInterval.ts";

/** How often an open page asks which client build its server serves. The
 * question is not urgent (a page keeps working on the bundle it loaded) but
 * it is not free either, so it rides on the same cadence as the update status
 * poll rather than anything faster. */
export const BUILD_WATCH_MS = 60_000;

/** Cadence while this page is waiting for a server it asked to restart: the
 * successor answers the first tick after it binds, and the page reloads on
 * that answer. */
export const RESTART_POLL_MS = 2_000;

/** Whether the server's build is a different one from this page's. Pure, so
 * the rule is testable without a browser.
 *
 * A missing value on either side means "cannot tell" and must not read as a
 * change: a page served by a server that predates the field, or a page whose
 * own build id never arrived, simply has nothing to compare. */
export function buildMoved(
  loaded: string | undefined,
  current: string | undefined,
): boolean {
  if (loaded === undefined || loaded === "") return false;
  if (current === undefined || current === "") return false;
  return loaded !== current;
}

export interface BuildWatchOptions {
  /** Poll quickly: this page asked the server to restart and is waiting for
   * the successor, which is when the reload should happen without a wait. */
  restartPending?: boolean;
}

export interface BuildWatch {
  /** True once the server reported a build other than the one this page was
   * served with: the bundle is stale and only a reload replaces it. */
  stale: boolean;
}

/**
 * Watch for a client bundle that the server has replaced.
 *
 * An installed PWA has no address bar and no reload button, and its window
 * keeps the bundle it loaded for as long as the OS keeps the process: after a
 * server update — or after months of releases — the page can still be running
 * a client from before the features it is looking for existed. Nothing inside
 * the old bundle can fix that, so the server names the build it serves
 * (`/api/build`'s `buildId`, see Assets.buildId) and this hook compares it
 * with the one the page was served with (`__INITIAL_DATA__.buildId`).
 *
 * The build id has a route of its own rather than riding on `/api/health`:
 * that route answers liveness, which several callers ask with a 3-second
 * budget, and computing the id runs a frontend build (see app.ts).
 *
 * The check runs on the visible-page cadence and once every time the page
 * comes back, which is exactly when an installed app is looked at again.
 */
export function useBuildWatch(
  loadedBuildId: string | undefined,
  options: BuildWatchOptions = {},
): BuildWatch {
  const [stale, setStale] = useState(false);
  const loaded = loadedBuildId ?? "";
  useVisibleInterval(
    () => {
      void request<{ buildId?: string }>("/api/build").then(
        (build) => {
          if (buildMoved(loaded, build.buildId)) setStale(true);
        },
        // A failed read says nothing about the build: the server may be
        // restarting, which the next tick (or the one after it) will see.
        () => {},
      );
    },
    loaded === ""
      ? NEVER
      : options.restartPending === true
        ? RESTART_POLL_MS
        : BUILD_WATCH_MS,
  );
  return { stale };
}
