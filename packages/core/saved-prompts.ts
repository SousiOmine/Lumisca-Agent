import { CoreError } from "./errors.ts";
import {
  parseSavedPrompts,
  SAVED_PROMPTS_KEY,
  type SavedPrompt,
  serializeSavedPrompts,
} from "./shared/mod.ts";
import type { SettingsRepo } from "./settings/repo.ts";

/** User-defined prompt snippets (`/prompt` slash menu). Extracted from
 * LumiscaCore so the parse/validate/persist cycle lives in one testable
 * unit; the core keeps only a delegating facade. */
export class SavedPromptsService {
  constructor(private readonly settings: SettingsRepo) {}

  /** All saved prompts, in insertion order. */
  list(): SavedPrompt[] {
    return parseSavedPrompts(this.settings.get(SAVED_PROMPTS_KEY));
  }

  /** Add a saved prompt. Throws when the id already exists. */
  add(input: { id: string; label: string; prompt: string }): SavedPrompt {
    const prompts = this.list();
    if (prompts.some((p) => p.id === input.id)) {
      throw new CoreError(
        `A saved prompt with id "${input.id}" already exists`,
        "conflict",
      );
    }
    const entry: SavedPrompt = {
      id: input.id,
      label: input.label,
      prompt: input.prompt,
    };
    this.settings.set(
      SAVED_PROMPTS_KEY,
      serializeSavedPrompts([...prompts, entry]),
    );
    return entry;
  }

  /** Update a saved prompt's label and/or prompt by id. Throws when the
   * id does not exist. */
  update(
    id: string,
    input: { label?: string; prompt?: string },
  ): SavedPrompt {
    const prompts = this.list();
    const existing = prompts.find((p) => p.id === id);
    if (existing === undefined) {
      throw new CoreError(`Saved prompt not found: ${id}`, "not_found");
    }
    const updated: SavedPrompt = {
      id,
      label: input.label ?? existing.label,
      prompt: input.prompt ?? existing.prompt,
    };
    this.settings.set(
      SAVED_PROMPTS_KEY,
      serializeSavedPrompts(prompts.map((p) => p.id === id ? updated : p)),
    );
    return updated;
  }

  /** Delete a saved prompt by id. Throws when the id does not exist. */
  delete(id: string): void {
    const prompts = this.list();
    const next = prompts.filter((p) => p.id !== id);
    if (next.length === prompts.length) {
      throw new CoreError(`Saved prompt not found: ${id}`, "not_found");
    }
    this.settings.set(SAVED_PROMPTS_KEY, serializeSavedPrompts(next));
  }
}
