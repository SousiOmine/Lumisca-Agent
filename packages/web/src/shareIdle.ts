import { useSyncExternalStore } from "preact/compat";
import { shellCall } from "./shell.ts";

/** How long a folder lent from this computer stays connected without use.
 *
 * It is the desktop shell's own preference (the loan and its clock live on
 * this computer, see packages/desktop/src-tauri/src/share.rs), so the page
 * reads and writes it over the shell bridge. The two screens that show it —
 * Settings → アプリ and the lending dialog — share this one copy, so the
 * dialog cannot promise a deadline the settings page has changed.
 */
export type ShareIdleSetting = "5" | "10" | "15" | "30" | "never";

/** The shell's default, shown until its answer arrives (and in a browser). */
const DEFAULT: ShareIdleSetting = "30";

const listeners = new Set<() => void>();

/** `null` until the shell answers: a guessed deadline would be a promise the
 * user may not have made. */
let current: ShareIdleSetting | null = null;
let loading: Promise<void> | null = null;

function publish(next: ShareIdleSetting | null): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

/** The setting for a value from the shell, falling back to the default when
 * it is one neither side names (a newer shell's extra choice, a typo). */
function settingOf(minutes: number | null): ShareIdleSetting {
  if (minutes === null) return "never";
  const text = String(minutes);
  return text === "5" || text === "10" || text === "15" || text === "30"
    ? text
    : DEFAULT;
}

/** The wire value of one choice: minutes, or `null` for no automatic
 * disconnect. */
export function minutesOf(setting: ShareIdleSetting): number | null {
  return setting === "never" ? null : Number(setting);
}

/** Read the shell's answer once. A failure leaves the value unset, so the
 * next screen that needs it asks again. */
export function loadShareIdle(): void {
  if (loading !== null || current !== null) return;
  loading = shellCall<{ minutes: number | null }>("share/idle").then(
    (answer) => {
      loading = null;
      publish(settingOf(answer.minutes));
    },
    () => {
      loading = null;
    },
  );
}

/** Save one choice. The local copy moves first, so a control that reads it
 * shows the choice at once; a refused write puts it back and throws what the
 * shell said. */
export async function saveShareIdle(next: ShareIdleSetting): Promise<void> {
  const before = current;
  publish(next);
  try {
    await shellCall("share/set-idle", { minutes: next });
  } catch (error) {
    publish(before);
    throw error;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current choice, or `null` while it is unknown. */
export function useShareIdle(): ShareIdleSetting | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT,
  );
}
