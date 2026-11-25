import { useSyncExternalStore } from "preact/compat";
import { shellPlatform } from "./shell.ts";

export type SendShortcut = "mod-enter" | "enter";

const STORAGE_KEY = "lumisca.sendShortcut";
const DEFAULT_SHORTCUT: SendShortcut = "mod-enter";

const listeners = new Set<() => void>();

function parseShortcut(raw: string | null): SendShortcut {
  return raw === "enter" ? "enter" : DEFAULT_SHORTCUT;
}

export function readSendShortcut(): SendShortcut {
  try {
    return parseShortcut(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_SHORTCUT;
  }
}

let current: SendShortcut = readSendShortcut();

export function setSendShortcut(next: SendShortcut): void {
  if (current === next) return;
  current = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // Storage may be unavailable in restricted contexts; keep in-memory state.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSendShortcut(): SendShortcut {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_SHORTCUT,
  );
}

/** True on macOS (desktop shell platform or browser platform hint). */
export function isMacPlatform(): boolean {
  if (shellPlatform() === "macos") return true;
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform ?? "");
}

/** Short human-readable key label for the active send shortcut. */
export function sendShortcutHint(shortcut: SendShortcut): string {
  if (shortcut === "enter") return "Enter";
  return isMacPlatform() ? "⌘+Enter" : "Ctrl+Enter";
}
