/**
 * CLI browser-host runtime: locating the lumisca-browser-host binary,
 * spawning it on demand, and wrapping it in a LazyBrowserBackend.
 *
 * The host is ONLY started when the agent actually uses a browser tool
 * (or with --browser-preview=always at CLI startup). It is killed on
 * close (browser_close / CLI exit) and never survives the CLI.
 */
import { HttpBrowserBackend, LazyBrowserBackend } from "@lumisca/core";
import type { BrowserBackend } from "@lumisca/core";

/** Browser preview policy of the CLI. */
export type BrowserPreviewMode = "auto" | "always" | "never";

/** Parse `--browser-preview` values; unknown values are an error. */
export function parseBrowserPreview(
  value: string | undefined,
): BrowserPreviewMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "always" || value === "never") return value;
  throw new Error(
    `--browser-preview は auto / always / never のいずれかです (got "${value}")`,
  );
}

export interface BrowserHostOptions {
  /** Idle timeout of the host process in ms (default 15 min). */
  idleTimeoutMs?: number;
}

/** How long to wait for the ready line (the host must create its window
 * server; a headless session fails fast here). */
const READY_TIMEOUT_MS = 10_000;
/** After RPC close: how long to wait for the host to exit on its own
 * before killing it (browser_close must leave no host behind). */
const EXIT_WAIT_MS = 2_000;

/** Locate the host binary:
 * 1. $LUMISCA_BROWSER_HOST (explicit path)
 * 2. the repository layout: packages/browser-host/target/{release,debug}
 * 3. PATH
 */
export function findBrowserHostBinary(): string | undefined {
  const explicit = Deno.env.get("LUMISCA_BROWSER_HOST");
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const name = Deno.build.os === "windows"
    ? "lumisca-browser-host.exe"
    : "lumisca-browser-host";
  const here = import.meta.dirname;
  if (here !== undefined) {
    // packages/cli → packages/browser-host
    const packagesDir = `${here}/..`;
    for (const profile of ["release", "debug"]) {
      const candidate = `${packagesDir}/browser-host/target/${profile}/${name}`;
      try {
        Deno.statSync(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  for (
    const dir of (Deno.env.get("PATH") ?? "").split(";").filter((d) =>
      d.length > 0
    )
  ) {
    const candidate = `${dir}\\${name}`;
    try {
      Deno.statSync(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read the first line of the host's stdout with a deadline. The line is
 * `LUMISCA_BROWSER_READY <port>`; anything else means the host failed
 * before becoming ready. */
async function readReadyLine(
  stdout: ReadableStream<Uint8Array>,
): Promise<{ port: number } | { error: string }> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const reader = stdout.getReader();
  let buffer = "";
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timeout")),
            remaining,
          )
        ),
      ]);
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        const port = Number(line.replace(/^LUMISCA_BROWSER_READY\s*/, ""));
        if (Number.isInteger(port) && port > 0) return { port };
        return { error: line };
      }
    }
  } catch {
    // timeout or stream error — falls through to the generic error
  } finally {
    reader.releaseLock();
  }
  return { error: "ready line が届きませんでした" };
}

/** Spawn the host binary. Rejects with a clear message on spawn failure,
 * early exit, or ready-line timeout (headless environments fail here —
 * never a silent virtual-DOM substitute). */
async function spawnHost(
  binary: string,
  idleTimeoutMs: number,
): Promise<{ backend: HttpBrowserBackend; child: Deno.ChildProcess }> {
  const token = randomToken();
  const child = new Deno.Command(binary, {
    args: [
      "--token",
      token,
      "--idle-timeout-ms",
      String(idleTimeoutMs),
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Drain stderr so the host's error messages surface in our failure
  // messages (and the pipe never fills).
  let stderrTail = "";
  void (async () => {
    try {
      const reader = child.stderr.pipeThrough(new TextDecoderStream())
        .getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stderrTail = (stderrTail + value).slice(-2000);
      }
    } catch {
      // the process is gone — nothing to drain
    }
  })();

  const ready = await readReadyLine(child.stdout);
  if ("error" in ready) {
    // Give a crashing host a moment to die, so the exit/message check
    // below can report the cause.
    const status = await Promise.race([
      child.status,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    let detail = stderrTail.trim();
    if (status !== null) {
      detail = `(exit code ${status.code}) ${detail}`;
    }
    child.kill();
    throw new Error(
      `lumisca-browser-host を起動できませんでした${
        detail ? `: ${detail}` : ""
      }。` +
        "OS標準WebView (WebView2 / WKWebView / WebKitGTK) が利用できるGUI " +
        "セッションが必要です。バイナリをビルドするには " +
        "packages/browser-host で `cargo build --release` を実行してください。",
    );
  }
  return {
    backend: new HttpBrowserBackend({
      url: `http://127.0.0.1:${ready.port}`,
      token,
    }),
    child,
  };
}

/** The CLI's browser backend: a lazily started host. The factory produces
 * a backend bound to the spawned process; close() closes the lab AND
 * kills the process (bounded wait), so no host survives browser_close or
 * CLI exit. */
export function createCliBrowserBackend(
  options: BrowserHostOptions = {},
): LazyBrowserBackend {
  const idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60 * 1000;
  return new LazyBrowserBackend(async () => {
    const binary = findBrowserHostBinary();
    if (binary === undefined) {
      throw new Error(
        "lumisca-browser-host が見つかりません。$LUMISCA_BROWSER_HOST で " +
          "指定するか、packages/browser-host で `cargo build --release` を" +
          "実行してください。",
      );
    }
    const { backend, child } = await spawnHost(binary, idleTimeoutMs);
    return new ProcessBoundBackend(backend, child);
  });
}

/** Wraps an HttpBrowserBackend with the owning process: close() first
 * asks the host to close (it exits after the reply flush), then waits a
 * bounded moment and kills whatever is left. */
class ProcessBoundBackend implements BrowserBackend {
  private closed = false;

  constructor(
    private readonly inner: HttpBrowserBackend,
    private readonly child: Deno.ChildProcess,
  ) {}

  open(
    options: Parameters<BrowserBackend["open"]>[0],
    signal?: AbortSignal,
  ) {
    return this.inner.open(options, signal);
  }
  observe(
    options?: Parameters<BrowserBackend["observe"]>[0],
    signal?: AbortSignal,
  ) {
    return this.inner.observe(options, signal);
  }
  act(
    action: Parameters<BrowserBackend["act"]>[0],
    signal?: AbortSignal,
  ) {
    return this.inner.act(action, signal);
  }
  wait(
    options: Parameters<BrowserBackend["wait"]>[0],
    signal?: AbortSignal,
  ) {
    return this.inner.wait(options, signal);
  }
  screenshot(
    options?: Parameters<BrowserBackend["screenshot"]>[0],
    signal?: AbortSignal,
  ) {
    return this.inner.screenshot(options, signal);
  }

  async close(signal?: AbortSignal): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.inner.close(signal);
    } catch {
      // The host may already be gone — killing below settles it.
    }
    // The host exits itself after the close reply; bound the wait so a
    // stuck process cannot outlive browser_close.
    const status = await Promise.race([
      this.child.status,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), EXIT_WAIT_MS)
      ),
    ]);
    if (status === null) {
      try {
        this.child.kill();
      } catch {
        // already dead
      }
    }
  }
}

/** Convenience for the CLI's `finally`: shuts the host down if it was
 * ever started. */
export async function closeBrowserBackend(
  backend: BrowserBackend | undefined,
): Promise<void> {
  if (backend !== undefined) {
    await backend.close();
  }
}
