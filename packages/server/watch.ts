/** Watch the frontend sources for changes and notify a callback.
 * Used in dev mode to trigger rebundling and client reloads.
 * Events are debounced so a burst of filesystem events fires once. */
export class SourceWatcher {
  private watcher: Deno.FsWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly debounceMs: number;

  constructor(
    private readonly srcDir: string,
    debounceMs = 120,
  ) {
    this.debounceMs = debounceMs;
  }

  start(onChange: () => void): void {
    this.stopped = false;
    this.watcher = Deno.watchFs(this.srcDir, { recursive: true });
    (async () => {
      for (;;) {
        const watcher = this.watcher;
        if (watcher === null) return;
        try {
          for await (const event of watcher) {
            // `rename` included: editors often save via atomic rename
            // (write temp + rename over the target), which never emits
            // modify/create for the final path.
            if (
              event.kind !== "modify" && event.kind !== "create" &&
              event.kind !== "rename"
            ) {
              continue;
            }
            const relevant = event.paths.some((p) =>
              /\.(ts|tsx|css)$/.test(p) && !p.includes(".lumisca-cache")
            );
            if (!relevant) continue;
            if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
              this.debounceTimer = null;
              onChange();
            }, this.debounceMs);
          }
          return; // watcher closed cleanly (stop())
        } catch (error) {
          // The watcher died (e.g. transient OS error): log and restart so
          // dev reloads do not silently stop.
          if (this.stopped) return;
          console.error("source watcher failed, restarting:", error);
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (this.stopped) return;
          this.watcher = Deno.watchFs(this.srcDir, { recursive: true });
        }
      }
    })();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
