/**
 * LazyBrowserBackend: starts the browser host on the FIRST tool call
 * (on-demand boot for the CLI) and releases it on close().
 *
 * Lifecycle: exactly one launch attempt per open→close pair. A failed
 * launch stays failed until close() clears it (no silent retry); a host
 * that dies on its own surfaces transport errors unmodified. close()
 * followed by a new call starts a fresh host — that is the on-demand
 * open/close contract, not a fallback.
 */
import type {
  ActionResult,
  BrowserAction,
  BrowserBackend,
  ImageResult,
  ObserveOptions,
  OpenOptions,
  PageInfo,
  PageSnapshot,
  ScreenshotOptions,
  WaitOptions,
  WaitResult,
} from "./types.ts";

export class LazyBrowserBackend implements BrowserBackend {
  private launch: Promise<BrowserBackend> | null = null;

  constructor(
    /** Spawn the host and return its backend. Called at most once per
     * open→close pair. */
    private readonly factory: () => Promise<BrowserBackend>,
  ) {}

  private ensure(): Promise<BrowserBackend> {
    if (this.launch === null) {
      this.launch = this.factory();
    }
    return this.launch;
  }

  open(options: OpenOptions, signal?: AbortSignal): Promise<PageInfo> {
    return this.ensure().then((b) => b.open(options, signal));
  }

  observe(
    options?: ObserveOptions,
    signal?: AbortSignal,
  ): Promise<PageSnapshot> {
    return this.ensure().then((b) => b.observe(options, signal));
  }

  act(action: BrowserAction, signal?: AbortSignal): Promise<ActionResult> {
    return this.ensure().then((b) => b.act(action, signal));
  }

  wait(options: WaitOptions, signal?: AbortSignal): Promise<WaitResult> {
    return this.ensure().then((b) => b.wait(options, signal));
  }

  screenshot(
    options?: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ImageResult> {
    return this.ensure().then((b) => b.screenshot(options, signal));
  }

  /** Release the host. Idempotent; a failed launch or a host that already
   * died is treated as released. */
  async close(signal?: AbortSignal): Promise<void> {
    const launch = this.launch;
    this.launch = null;
    if (launch === null) return;
    try {
      const backend = await launch;
      await backend.close(signal);
    } catch {
      // Nothing left to release — close is best-effort by contract.
    }
  }

  /** Start the host immediately (--browser-preview=always);
   * --browser-preview=auto relies on the first tool call instead. */
  warm(): Promise<void> {
    return this.ensure().then(() => undefined);
  }

  /** True once the launch has been requested (a host process may exist). */
  get isStarted(): boolean {
    return this.launch !== null;
  }
}
