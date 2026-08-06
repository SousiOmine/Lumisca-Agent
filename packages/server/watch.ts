/** Watch the frontend sources for changes and notify a callback.
 * Used in dev mode to trigger rebundling and client reloads.
 * Events are debounced so a burst of filesystem events fires once. */
export class SourceWatcher {
  private watcher: Deno.FsWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(
    private readonly srcDir: string,
    debounceMs = 120,
  ) {
    this.debounceMs = debounceMs;
  }

  start(onChange: () => void): void {
    const watcher = Deno.watchFs(this.srcDir, { recursive: true });
    this.watcher = watcher;
    (async () => {
      try {
        for await (const event of watcher) {
          if (event.kind !== "modify" && event.kind !== "create") continue;
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
      } catch (error) {
        console.error("source watcher failed:", error);
      }
    })();
  }

  stop(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
