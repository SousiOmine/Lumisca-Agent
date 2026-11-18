import * as fsSync from "node:fs";
import { dirname, join } from "node:path";
import { CoreError, errorMessage, isNotFoundError } from "./errors.ts";
import { createLogger } from "./log.ts";
import type { SettingsRepo } from "./settings/repo.ts";

const log = createLogger("personalization");

/** Machine-level AGENTS.md (next to the settings file): published with a
 * session's instructions whenever it changes (memory/instructions.ts) rather
 * than written into the generated system prompt, so an edit reaches a
 * session that is already open. Extracted from LumiscaCore so the file I/O,
 * the missing-file contract, and the permission bits live in one testable
 * unit; the core keeps only a delegating facade. */
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
    fsSync.mkdirSync(dirname(path), { recursive: true });
    fsSync.writeFileSync(path, content, { mode: 0o600 });
  }

  /** Personal instructions to append to generated system prompts. Absent
   * file → undefined. */
  load(): string | undefined {
    const path = this.path();
    if (path === undefined) return undefined;
    try {
      return fsSync.readFileSync(path, "utf8");
    } catch (error) {
      // Absent file is the normal case (no personalization configured);
      // anything else (permissions, I/O) is worth a debug line.
      if (!isNotFoundError(error)) {
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
