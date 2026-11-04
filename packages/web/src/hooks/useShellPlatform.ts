import { useEffect, useState } from "preact/compat";
import { type ShellState, shellState } from "../shell.ts";

/** How many times a cold window asks again: the bridge listener can be a
 * moment behind the first page load, and a plain browser never answers. */
const ATTEMPTS = 5;
const RETRY_MS = 500;

/**
 * The OS hosting this page, or null outside the desktop shell.
 *
 * The page itself cannot answer this: a window may display a server on
 * another machine, and a plain browser has no window chrome at all. The
 * shell answers it in `state`, through the same shared read as the title
 * bar and the connection picker.
 *
 * Read once it succeeds: the OS does not change under a running window, and
 * the page is reloaded when the displayed server changes.
 */
export function useShellPlatform(): ShellState["platform"] | null {
  const [platform, setPlatform] = useState<ShellState["platform"] | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const read = () => {
      shellState.read().then(
        (state) => {
          if (!cancelled) setPlatform(state.platform);
        },
        () => {
          // A failed read is not cached, so asking again is safe. Stop after
          // a few tries: a plain browser has no bridge, and no amount of
          // waiting will give it one.
          if (!cancelled && ++attempt < ATTEMPTS) {
            timer = setTimeout(read, RETRY_MS);
          }
        },
      );
    };
    read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return platform;
}
