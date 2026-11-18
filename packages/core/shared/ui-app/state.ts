/**
 * The card's state: one JSON object, changed by paths, read by expressions.
 *
 * It belongs to one mounted card. Nothing writes it to the message, the
 * server or storage: reopening the message starts from the spec's `state`
 * again. Updates are immutable, so a component that kept a previous snapshot
 * still reads the value it drew.
 */

/** One state snapshot. Treat it as read-only; `set` replaces it. */
export type UiAppState = Readonly<Record<string, unknown>>;

/** One card's state store. */
export interface UiAppStateStore {
  /** The value at a path, or undefined when the path is absent. */
  get(path: string): unknown;
  /** The current root. It is replaced, never mutated. */
  snapshot(): UiAppState;
  /** Replace the value at a path. The path must exist. */
  set(path: string, value: unknown): void;
  /** Apply a function to the value at a path. The path must exist. */
  update(path: string, change: (current: unknown) => unknown): void;
  /** Start again from the spec's initial state. */
  reset(): void;
  /** Notified after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Keys that would reach an object's prototype if they were assigned. The
 * model writes paths, so they are refused before any assignment. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** The segments of a path (`/form/name` → `["form", "name"]`).
 *
 * A path is absolute, uses `/` between segments, and cannot be empty. The
 * parser checks the same shape, so a path that reaches the store has already
 * been accepted once; this function is the runtime's own guard. */
export function pathSegments(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new Error(`State path must start with "/": ${path}`);
  }
  const segments = path.slice(1).split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "")) {
    throw new Error(`State path has an empty segment: ${path}`);
  }
  for (const segment of segments) {
    if (FORBIDDEN_KEYS.has(segment)) {
      throw new Error(`State path uses a reserved key: ${segment}`);
    }
  }
  return segments;
}

/** The value at a path, or undefined when the path is absent. */
export function valueAtPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of pathSegments(path)) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index === null || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

/** One field of a repeated item (`name`, `a.b`, or "" for the item itself). */
export function itemValue(item: unknown, field: string): unknown {
  if (field === "") return item;
  let current = item;
  for (const segment of field.split(".")) {
    if (segment === "" || FORBIDDEN_KEYS.has(segment)) return undefined;
    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index === null || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

/** Create one card's state. The initial object is copied, so later writes
 * cannot reach the parsed spec. */
export function createUiAppState(
  initial: Readonly<Record<string, unknown>>,
): UiAppStateStore {
  const start = cloneJson(initial) as UiAppState;
  let root = start;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    get(path) {
      return valueAtPath(root, path);
    },
    snapshot() {
      return root;
    },
    set(path, value) {
      const segments = pathSegments(path);
      const current = valueAtPath(root, path);
      if (Object.is(current, value)) return;
      root = setAtPath(root, segments, cloneJson(value)) as UiAppState;
      notify();
    },
    update(path, change) {
      const current = valueAtPath(root, path);
      const next = change(current);
      if (Object.is(current, next)) return;
      const segments = pathSegments(path);
      root = setAtPath(root, segments, cloneJson(next)) as UiAppState;
      notify();
    },
    reset() {
      root = cloneJson(start) as UiAppState;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A copy of one JSON value. A value that is not JSON (a function, a symbol)
 * is refused: the spec came from JSON, so anything else is a caller's bug. */
export function cloneJson(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((child) => cloneJson(child));
  if (typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`JSON object uses a reserved key: ${key}`);
      }
      copy[key] = cloneJson(child);
    }
    return copy;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value === undefined) return undefined;
  throw new Error(`Value is not JSON: ${typeof value}`);
}

/** Replace one value in a tree, cloning every object and array on the way.
 * A missing parent is a mistake in the card, not a state to invent. */
function setAtPath(
  current: unknown,
  segments: readonly string[],
  value: unknown,
): unknown {
  const head = segments[0];
  if (head === undefined) return value;
  const rest = segments.slice(1);
  if (Array.isArray(current)) {
    const index = arrayIndex(head);
    if (index === null || index >= current.length) {
      throw new Error(`State path names no array element: ${head}`);
    }
    const copy = current.slice();
    copy[index] =
      rest.length === 0 ? value : setAtPath(current[index], rest, value);
    return copy;
  }
  if (current !== null && typeof current === "object") {
    if (!Object.hasOwn(current, head)) {
      throw new Error(`State path names no key: ${head}`);
    }
    const record = current as Record<string, unknown>;
    const copy = { ...record };
    copy[head] =
      rest.length === 0 ? value : setAtPath(record[head], rest, value);
    return copy;
  }
  throw new Error(`State path crosses a non-object: ${head}`);
}

/** The index a path segment names, or null when it is not one. */
function arrayIndex(segment: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) return null;
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : null;
}
