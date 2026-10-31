/**
 * Byte-array primitives with no owner: joining runs of output and the CRC-32
 * the PNG container needs.
 *
 * Kept beside base64.ts for the same reason that module exists: several
 * unrelated subsystems (the VM's container plumbing, the computer-use image
 * pipeline, the web-search page fetcher, the updater's test fixtures) need
 * the same three lines, and a copy per call site is how the copies drift.
 */

/**
 * Join byte runs into one buffer. The result always owns a plain
 * `ArrayBuffer` (not a view into a possibly shared one), so it can be handed
 * to `crypto.subtle` as is.
 *
 * `length` lets a caller that already counted the bytes (a reader that
 * summed the chunks as they arrived) skip the first pass; when omitted the
 * total is measured here.
 */
export function concatBytes(
  parts: readonly Uint8Array[],
  length?: number,
): Uint8Array<ArrayBuffer> {
  let total = length ?? 0;
  if (length === undefined) {
    for (const part of parts) total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The CRC table, built once per process (256 entries). */
let crcTableCache: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (crcTableCache !== undefined) return crcTableCache;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTableCache = table;
  return table;
}

/**
 * CRC-32 (the reflected polynomial zlib, PNG and zip share) over `data`.
 *
 * PNG chunks put it after every chunk; the updater's fixtures put it in the
 * zip's central directory. One implementation so a chunk written by one and
 * read by the other cannot disagree.
 */
export function crc32(data: Uint8Array): number {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
