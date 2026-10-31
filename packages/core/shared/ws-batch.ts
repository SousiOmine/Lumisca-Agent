/**
 * Coalescing of a streaming event stream's delta frames.
 *
 * A run streams one `text_delta` per token, and the server forwards each as
 * its own WebSocket frame. Locally that is invisible (the socket's send is a
 * memory copy), but over a link with a real round trip — a tailnet, a WAN, a
 * phone — every frame is a packet to acknowledge, and dozens of tiny frames
 * arrive as one burst. The UI then renders the burst as one jump, which is
 * exactly the "stutters instead of flowing" the user sees.
 *
 * So the transport batches the DELTAS only, into one frame per interval and
 * per session. Everything else in the stream is an event with a meaning of
 * its own (a tool started, a run ended, a message is complete); those must
 * not be delayed and must not be reordered behind a delta that is still
 * buffered, so the caller flushes the batch before sending one.
 *
 * Three things this deliberately does NOT do:
 *
 * - **It does not merge sessions.** One socket carries every session's
 *   events (code mode runs several tabs at once), and a batch is text of ONE
 *   transcript: concatenating two tabs' tokens would hand each viewer another
 *   tab's words. The key is the session, and each key flushes on its own.
 * - **It does not change the revision count.** The revision is how many
 *   events the server emitted for a session, not how many frames reached the
 *   client, so a batch carries the revision of its LAST delta and the number
 *   of events it covers (the client needs both — see the web's revisionGap).
 * - **It does not delay the first delta by more than one interval.** The
 *   timer starts with the first buffered delta, so a lone delta goes out at
 *   worst `flushMs` later, and typically much sooner (a following non-delta
 *   event flushes it immediately).
 */

/** One batch as it goes on the wire. */
export interface DeltaFrame<K, R> {
  /** The batch's key (the session id): the caller writes it into the frame
   * so the client can route its text. */
  key: K;
  /** The concatenated text. */
  delta: string;
  /** Per-event revision of the last delta in the batch (undefined when the
   * caller's deltas carry no revision). */
  rev: R | undefined;
  /** How many events (deltas) the batch covers. The revision is a running
   * count, so a reader comparing it against what it has seen needs this to
   * tell "one frame for six tokens" from "five frames went missing". */
  events: number;
}

export interface FrameBatcherOptions<K, R> {
  /** Emit one frame containing one key's buffered text. Called once per
   * buffered key, never with empty text. */
  flush: (frame: DeltaFrame<K, R>) => void;
  /** How long the first buffered delta waits for company. 16 ms is one
   * display frame, which matches the cadence the reader can perceive. */
  flushMs?: number;
  /** A batch is also flushed as soon as its text reaches this many
   * characters: a fast model must not make one frame grow unboundedly (a
   * huge JSON frame is worse for a slow link than several medium ones).
   * Counted in UTF-16 code units, like `delta.length`. */
  maxChars?: number;
  /** Timer seams (tests drive them without waiting). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** One connection's delta batcher. */
export interface FrameBatcher<K, R> {
  /** Buffer one delta toward its key's next batch (empty text is ignored). */
  delta(key: K, text: string, rev?: R): void;
  /** Emit what is buffered now, for every key. The caller must call this
   * before writing any other frame, so the stream's order is preserved; it
   * is a no-op when nothing is buffered. */
  flush(): void;
  /** Emit what is buffered (a socket is closing: the text was produced and
   * is not recoverable otherwise), then stop accepting deltas. */
  close(): void;
  /** True while any key has text buffered. */
  get pending(): boolean;
}

/** Frames per second the reader can perceive: 60 Hz, i.e. ~16 ms. Batching
 * finer than this cannot be seen, and coarser makes the flow visibly
 * stepped. */
export const WS_DELTA_FLUSH_MS = 16;

/** A batch this large is sent immediately instead of waiting for the
 * interval. 16 KiB collapses hundreds of tokens into one frame while staying
 * far below the size at which a single frame becomes a problem on a slow
 * link. */
export const WS_DELTA_MAX_CHARS = 16 * 1024;

/** One key's buffered text. */
interface Buffer<K, R> {
  key: K;
  text: string;
  rev: R | undefined;
  /** Deltas buffered since the last flush (the batch's share of the
   * revision count). */
  events: number;
}

/**
 * Create one connection's batcher.
 *
 * The batcher is per socket (never shared): two sockets have different
 * lifetimes and different frames, and a shared buffer would deliver one
 * client's text to the other.
 */
export function createFrameBatcher<K = string, R = number>(
  options: FrameBatcherOptions<K, R>,
): FrameBatcher<K, R> {
  const flushMs = options.flushMs ?? WS_DELTA_FLUSH_MS;
  const maxChars = options.maxChars ?? WS_DELTA_MAX_CHARS;
  const setTimer = options.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  /** Buffered text per key. Insertion order is the order the keys' first
   * deltas arrived; a flush walks it so a slow session cannot overtake a
   * fast one. A flushed key's buffer is removed, so an idle connection
   * holds nothing. */
  const buffers = new Map<K, Buffer<K, R>>();
  let timer: unknown;
  /** Set by close(): nothing is emitted after it. */
  let closed = false;

  const stopTimer = () => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };

  /** Emit every buffered key (the order they were first buffered in). */
  const flush = () => {
    stopTimer();
    if (buffers.size === 0) return;
    const frames = [...buffers.values()];
    buffers.clear();
    if (closed) return;
    for (const frame of frames) {
      options.flush({
        key: frame.key,
        delta: frame.text,
        rev: frame.rev,
        events: frame.events,
      });
    }
  };

  return {
    delta(key: K, text: string, rev?: R): void {
      if (closed || text.length === 0) return;
      let buffer = buffers.get(key);
      if (buffer === undefined) {
        buffer = { key, text: "", rev: undefined, events: 0 };
        buffers.set(key, buffer);
      }
      buffer.text += text;
      buffer.events++;
      // The revision is a running count of the events the server emitted, so
      // a batch that contains several deltas accounts for all of them: the
      // count to report is the last one's.
      if (rev !== undefined) buffer.rev = rev;
      if (timer === undefined) {
        timer = setTimer(() => {
          timer = undefined;
          flush();
        }, flushMs);
      }
      // Flushed on its own: the other keys keep waiting for the interval.
      if (buffer.text.length >= maxChars) {
        buffers.delete(key);
        if (!closed) {
          options.flush({
            key: buffer.key,
            delta: buffer.text,
            rev: buffer.rev,
            events: buffer.events,
          });
        }
        if (buffers.size === 0) stopTimer();
      }
    },
    flush,
    close(): void {
      flush();
      closed = true;
      stopTimer();
    },
    get pending(): boolean {
      return buffers.size > 0;
    },
  };
}
