/**
 * The locale catalogue: every user-facing string of the app, grouped by the
 * surface that owns it and stored with all supported languages side by side
 * (see `types.ts`).
 *
 * Rules for adding a string:
 * 1. Pick the area file that owns the surface (`common` = shared/generic
 *    text and the text the CORE generates, `chrome` = title bar, tabs, menus,
 *    pickers and banners, `settings` = the settings dialog, `chat` = the chat
 *    view and composer, `panels` = the side panels and session lists).
 * 2. Key it `<area>.<surface>.<element>` (e.g. `settings.general.autoUpdate`)
 *    and give it BOTH languages in the same edit.
 * 3. Use `{name}` placeholders for values; keep the placeholder names
 *    identical across languages (asserted by the catalogue test).
 *
 * Everything here is USER-FACING TEXT. The prompts sent to the model are
 * uniformly English and live next to the code that builds them (see
 * tools/system-prompt.ts, modes/, skills/slash.ts) — they are deliberately
 * not part of this catalogue.
 */
import { chat } from "./chat.ts";
import { chrome } from "./chrome.ts";
import { common } from "./common.ts";
import { panels } from "./panels.ts";
import { settings } from "./settings.ts";

/** Every message of the app, keyed by `MessageKey`. */
export const messages = {
  ...common,
  ...chrome,
  ...settings,
  ...chat,
  ...panels,
};

/** The key space of the catalogue. A key that is not here does not exist:
 * `translate` rejects it at compile time. */
export type MessageKey = keyof typeof messages;
