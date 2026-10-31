/**
 * The bounded tail of one command stream.
 *
 * A pipe is drained completely — a command blocked on a full pipe never
 * finishes — but only its last bytes are kept, and the retained bytes are
 * decoded without joining them first. The host runner used to keep every
 * chunk and join them once the process exited, so a command that printed
 * gigabytes (a runaway loop, `cat` of a large file, a build log with the
 * verbosity turned up) exhausted the server's memory before the 4 MB cap was
 * ever applied: the process died under the OOM killer, taking every session
 * with it. The cap is what the caller asks for; keeping it is this type's
 * whole job.
 */

/** UTF-8 encodes one character in at most four bytes: the smallest byte
 * budget that can always produce a tail of N characters. */
export const MAX_UTF8_BYTES_PER_CHAR = 4;

/** Collects the tail of a byte stream, bounded at `limitBytes`. */
export class OutputTail {
  private readonly chunks: Uint8Array[] = [];
  private readonly decoder = new TextDecoder();
  private length = 0;
  private dropped = false;

  constructor(private readonly limitBytes: number) {
    if (!(limitBytes > 0)) {
      throw new Error("OutputTail needs a positive byte limit");
    }
  }

  /** True when bytes were discarded: the retained tail is not the whole
   * stream. */
  get truncated(): boolean {
    return this.dropped;
  }

  /** Retain the tail of one pipe chunk. Older bytes are dropped as the
   * buffer grows, so the retained size never exceeds the limit plus one
   * chunk. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (chunk.length >= this.limitBytes) {
      // One chunk larger than the whole budget: keep its tail and forget
      // everything before it (that is still a cut).
      const tail = chunk.subarray(chunk.length - this.limitBytes);
      this.dropped = true;
      this.chunks.length = 0;
      this.chunks.push(tail);
      this.length = tail.length;
      return;
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length > this.limitBytes) {
      const excess = this.length - this.limitBytes;
      const first = this.chunks[0]!;
      if (first.length <= excess) {
        this.chunks.shift();
        this.length -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.length -= excess;
      }
      this.dropped = true;
    }
  }

  /** Decode the retained tail. Call once, after the stream ended: the
   * incremental decode holds a character that straddles two chunks until
   * the next one arrives, and the final call flushes it. */
  finish(): string {
    let text = "";
    // A cut may land inside a character: skip the continuation bytes that
    // start the retained bytes, or the decoder would emit a replacement
    // character for the half character the caller never asked about.
    let skipping = this.dropped;
    for (const chunk of this.chunks) {
      let start = 0;
      if (skipping) {
        while (start < chunk.length && (chunk[start]! & 0xc0) === 0x80) start++;
        skipping = start === chunk.length;
      }
      const part = start === 0 ? chunk : chunk.subarray(start);
      if (part.length > 0) {
        text += this.decoder.decode(part, { stream: true });
      }
    }
    return text + this.decoder.decode();
  }
}
