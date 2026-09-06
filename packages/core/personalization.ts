import { dirname, join } from "node:path";
import { CoreError } from "./errors.ts";
import { createLogger } from "./log.ts";
import { errorMessage } from "./errors.ts";
import type { SettingsRepo } from "./settings/repo.ts";

const log = createLogger("personalization");

/** Machine-level AGENTS.md (next to the settings file): read at session
 * creation and appended to generated system prompts. Extracted from
 * LumiscaCore so the file I/O, the missing-file contract, and the
 * permission bits live in one testable unit; the core keeps only a
 * delegating facade. */
export class PersonalizationService {
  constructor(private readonly settings: SettingsRepo) {}

  /** The machine-level AGENTS.md with the path it lives at. Absent file
   * → empty content. */
  get(): { path: string; content: string } {
    const path = this.path();
    return { path: path ?? "", content: this.load() ?? "" };
  }

  /** Replace the machine-level AGENTS.md. Applies to sessions created from
   * now on; existing sessions keep their snapshot. */
  set(content: string): void {
    const path = this.path();
    if (path === undefined) {
      throw new CoreError("No settings directory", "unavailable");
    }
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(path, content, { mode: 0o600 });
  }

  /** Personal instructions to append to generated system prompts. Absent
   * file → undefined. */
  load(): string | undefined {
    const path = this.path();
    if (path === undefined) return undefined;
    try {
      return Deno.readTextFileSync(path);
    } catch (error) {
      // Absent file is the normal case (no personalization configured);
      // anything else (permissions, I/O) is worth a debug line.
      if (!(error instanceof Deno.errors.NotFound)) {
        log.debug(
          `personalization unreadable at ${path}: ${errorMessage(error)}`,
        );
      }
      return undefined;
    }
  }

  /** The path of the machine-level AGENTS.md, or undefined when there is
   * no settings directory (in-memory repos). */
  path(): string | undefined {
    const dir = this.settings.dir();
    return dir === undefined ? undefined : join(dir, "AGENTS.md");
  }
}
