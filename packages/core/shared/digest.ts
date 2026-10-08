/**
 * Deterministic digests for change detection.
 *
 * Two callers need the same two primitives: the instructions provider
 * fingerprints the AGENTS.md files it publishes (memory/instructions.ts),
 * and the agent loop fingerprints the request it is about to send
 * (ai/agent.ts, the request-shape record). Both are pure string math, so
 * they live here with the rest of the frontend-safe helpers.
 */

/** 64-bit FNV-1a of a string, as lowercase hex.
 *
 * Change detection only — never a security boundary (a cryptographic digest
 * would buy nothing and cost more): two different texts may collide, and
 * the only consequence of a collision is one skipped republish. */
export function fnv1a(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16);
}

/** JSON with the keys of every object sorted, so two values that differ
 * only in property insertion order produce the same text (the repeat guard
 * counts `{"a":1,"b":2}` and `{"b":2,"a":1}` as the same call). Arrays keep
 * their order; non-JSON leaf values serialize as `JSON.stringify` does
 * (`undefined` inside an object drops the key, inside an array becomes
 * `null`). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => {
        const entry = (value as Record<string, unknown>)[key];
        return entry === undefined
          ? undefined
          : `${JSON.stringify(key)}:${canonicalJson(entry)}`;
      })
      .filter((entry): entry is string => entry !== undefined);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
