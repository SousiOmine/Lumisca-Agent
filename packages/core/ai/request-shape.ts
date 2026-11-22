/**
 * The request-shape record: which request the loop just sent, and whether the
 * provider can serve it from the prefix it cached.
 *
 * The provider's prompt cache serves a request only from the prefix it shares
 * with the previous one, so the loop fingerprints every request it sends and
 * reports why it differs from its predecessor (see RequestShape). Kept out of
 * agent.ts because nothing here is loop control: it observes the request, and
 * the fingerprint and its caches are all it carries between steps.
 */

import { canonicalJson, fnv1a } from "../shared/digest.ts";
import type { AgentTool, RequestShape } from "./agent-types.ts";

/** True when `previous` is a prefix of `current` (same length or shorter,
 * every element equal in order). */
function isPrefix(
  previous: readonly string[],
  current: readonly string[],
): boolean {
  if (previous.length > current.length) return false;
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] !== current[i]) return false;
  }
  return true;
}

/** What the head hash is computed from: the parts of the request the provider
 * sees before the messages. */
export interface RequestHead {
  systemPrompt: string;
  tools: AgentTool[];
}

/** Fingerprints the requests one agent sends and reports them to its
 * observer.
 *
 * The state it accumulates is what makes the classification cheap: the head
 * hash of the current prompt + tool set is cached by identity (it is computed
 * once per revision, not once per step), the per-message hashes are cached per
 * object (the messages the converter passes through keep their identity
 * between steps), and the message fold is extended rather than recomputed (a
 * request is normally its predecessor plus a few messages). */
export class RequestShapeRecorder {
  private previousHeadHash: string | undefined;
  private previousMessageHashes: string[] | undefined;
  private previousMessagesHash: string | undefined;
  private readonly messageHashes = new WeakMap<object, string>();
  private headFingerprint:
    | { prompt: string; tools: AgentTool[]; hash: string }
    | undefined;

  /** Report the request about to be sent, if an observer was given. A request
   * is an append-extension of its predecessor when the head is unchanged and
   * the message list starts with exactly the previous one: only then can the
   * provider serve the shared prefix from its cache. A changed head and a
   * rewritten history (compaction, rewind) are the two events that cost the
   * whole cached prefix, and each is reported with its reason. */
  record(
    head: RequestHead,
    messages: unknown[],
    observer: ((shape: RequestShape) => void) | undefined,
  ): void {
    if (observer === undefined) return;
    const headHash = this.headHash(head);
    const hashes = messages.map((message) => this.messageHash(message));
    const previous = this.previousMessageHashes;
    const previousFold = this.previousMessagesHash;
    const extended = previous !== undefined && isPrefix(previous, hashes);
    let change: RequestShape["change"];
    if (this.previousHeadHash === undefined) change = "initial";
    else if (headHash !== this.previousHeadHash) change = "head-changed";
    else if (!extended) change = "history-rewritten";
    // Fold incrementally: a request is normally its predecessor plus a few
    // messages, so only that tail is folded again.
    let messagesHash: string;
    if (extended && previous !== undefined && previousFold !== undefined) {
      messagesHash = fnv1a(
        previousFold + hashes.slice(previous.length).join(""),
      );
    } else {
      messagesHash = fnv1a(hashes.join(""));
    }
    this.previousHeadHash = headHash;
    this.previousMessageHashes = hashes;
    this.previousMessagesHash = messagesHash;
    observer({
      headHash,
      messagesHash,
      messageCount: hashes.length,
      ...(change !== undefined ? { change } : {}),
    });
  }

  /** The head hash of the current request (system prompt + tool schemas).
   * Cached by identity: the prompt string and the tools array are replaced
   * only when they actually change, so the hash is computed once per revision
   * instead of once per step. */
  private headHash(head: RequestHead): string {
    const cached = this.headFingerprint;
    if (
      cached !== undefined &&
      cached.prompt === head.systemPrompt &&
      cached.tools === head.tools
    ) {
      return cached.hash;
    }
    const hash = fnv1a(
      `${head.systemPrompt}\u0000${canonicalJson(head.tools)}`,
    );
    this.headFingerprint = {
      prompt: head.systemPrompt,
      tools: head.tools,
      hash,
    };
    return hash;
  }

  /** Hash of one wire message. Cached per object: the messages the converter
   * passes through keep their identity between steps, so only the messages
   * derived for this step (a context snapshot, a notification, a checkpoint)
   * are hashed again. */
  private messageHash(message: unknown): string {
    if (message === null || typeof message !== "object") {
      return fnv1a(JSON.stringify(message) ?? "null");
    }
    const key = message as object;
    const cached = this.messageHashes.get(key);
    if (cached !== undefined) return cached;
    const hash = fnv1a(JSON.stringify(message) ?? "null");
    this.messageHashes.set(key, hash);
    return hash;
  }
}
