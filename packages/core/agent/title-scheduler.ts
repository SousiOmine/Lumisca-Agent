import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import type { Locale } from "../shared/mod.ts";
import type { TitleGenerator } from "./title-generation.ts";

const log = createLogger("session-agent");

/** What the scheduler needs from the session: the generator, the language the
 * title is written in, the rename that persists it, and whether the
 * transcript is still empty. */
export interface TitleSchedulerDeps {
  titleGenerator: TitleGenerator | null;
  language: Locale;
  renameSession(name: string): void;
  /** True while the session has no persisted message: the first prompt of a
   * fresh session is the one that generates the title. */
  hasNoPersistedMessages(): boolean;
}

/**
 * Generate a session's title from its first prompt, once.
 *
 * The provisional name ("Session <date>") is stored when the session is
 * created; the generated title replaces it asynchronously while the first run
 * is already going, so the user never waits for it. One attempt per session,
 * even after a failed first run that left the transcript unpersisted.
 */
export class TitleScheduler {
  private generated = false;

  constructor(private readonly deps: TitleSchedulerDeps) {}

  /** Kick off title generation for a first prompt, when this session still
   * needs one. */
  maybeGenerate(firstMessage: string): void {
    const generator = this.deps.titleGenerator;
    if (this.generated || generator === null) return;
    if (!this.deps.hasNoPersistedMessages()) return;
    this.generated = true;
    void this.generate(firstMessage);
  }

  private async generate(firstMessage: string): Promise<void> {
    const text = firstMessage.trim();
    if (!text) return;
    try {
      const title = await this.deps.titleGenerator!.generateTitle(
        text,
        this.deps.language,
      );
      this.deps.renameSession(title);
    } catch (error) {
      // Keep the provisional name; the failure is only visible on debug.
      log.debug(`title generation failed: ${errorMessage(error)}`);
    }
  }
}
