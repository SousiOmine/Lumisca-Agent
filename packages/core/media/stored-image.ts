/**
 * The copy of an image a conversation keeps.
 *
 * Every picture an agent reads lands in the transcript, and the transcript
 * is the database: a tool result's image blocks stay there as base64 for the
 * life of the conversation. That is harmless once and ruinous over a year —
 * a 4000px phone photo is ~12 MB of base64, a rendered PDF page 2-4 MB, and
 * one prompt may carry eight pictures at once. None of those pixels is read
 * back: every vision provider scales a large image down to its own budget
 * (1568px on the long edge is the tightest of them) before the model sees
 * it, so the bytes above that are stored, re-sent on every request and
 * never used.
 *
 * So the transcript keeps a bounded copy: the long edge within
 * {@link STORED_IMAGE_EDGE}, the bytes within {@link STORED_IMAGE_BYTES}.
 * The original file is not touched — `read` still reads what is on disk,
 * `read` and every other tool still name the file they were asked about, and
 * `chat_attach` still hands the user their own bytes. Only the copy that
 * travels with the conversation is normalized.
 *
 * The two screen tools (`computer_screenshot` / `vm_screenshot`) return a
 * coordinate system, but they are not exempt: the copy is scaled by a single
 * factor on both axes, so the aspect ratio is kept, and each result spells
 * out the screen size and the factor that turns a position read off the
 * picture into a screen pixel. A scaled picture is still a map — the one
 * thing it must not be is a map whose scale is left unsaid.
 *
 * An animated GIF is kept as its first frame: the model reads one frame of
 * it in any case, and this module decides what the transcript shows, never
 * what is on disk.
 */

/** Longest edge of the copy a transcript keeps, in pixels. 1568 is the
 * tightest of the vision providers' own limits, so a larger copy would be
 * scaled down again beyond Lumisca: stored, transferred and paid for on the
 * way to being discarded. */
export const STORED_IMAGE_EDGE = 1568;

/** Largest copy, in bytes. A 1568px screenshot of text is well inside it;
 * an image that is not (a photograph saved as PNG) is re-encoded, and one
 * that still is not is shrunk further. */
export const STORED_IMAGE_BYTES = 1024 * 1024;

/** JPEG quality for the re-encodes. The usual point where a photograph
 * stops being distinguishable at display size, at a fraction of the bytes
 * (the same value media/preview.ts uses for its previews). */
const JPEG_QUALITY = 85;

/** How many times an image that is still over the budget is shrunk. Three
 * steps of {@link SHRINK_FACTOR} take a 1568px side to ~800px, which no
 * ordinary picture needs: the loop exists so a pathological image cannot
 * keep the budget from binding at all. */
const SHRINK_STEPS = 3;

/** Each shrink step multiplies the long edge by this. */
const SHRINK_FACTOR = 0.8;

/** The types this module can decode. Raster only: an SVG is a document, not
 * pixels, and re-encoding one would mean deciding a script policy for it
 * (see shared/attachments.ts, which draws the same line for display). */
const DECODABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/** What the caller stores in place of the bytes it passed in. */
export interface StoredImage {
  bytes: Uint8Array;
  mimeType: string;
  /** Whether `bytes` differs from the input (false: store the input). */
  changed: boolean;
  /** Pixels of the copy, present when the image was decoded. */
  size?: { width: number; height: number };
  /** Pixels of the input, present only when the copy is smaller. */
  downscaledFrom?: { width: number; height: number };
}

type CanvasModule = typeof import("@napi-rs/canvas");
type DecodedImage = Awaited<ReturnType<CanvasModule["loadImage"]>>;

/**
 * The canvas module, loaded on first use and never twice.
 *
 * Lazy for the same reason `pdf/tools.ts` loads it lazily: Skia is a native
 * library whose Windows build aborts the process when `icudtl.dat` is
 * missing beside the binary. A module that imported it at the top would turn
 * that into "the server does not start". A failure here is not a failure
 * either: the caller keeps the image it already has, which is exactly what
 * happens when the budget is not exceeded.
 */
let canvasModule: Promise<CanvasModule | undefined> | undefined;

function loadCanvas(): Promise<CanvasModule | undefined> {
  canvasModule ??= import("@napi-rs/canvas").catch(() => undefined);
  return canvasModule;
}

/**
 * The copy of `bytes` to keep in a transcript.
 *
 * Never throws: an image this module cannot decode, a decoder that is not
 * available, and an encode that would only make the picture bigger all
 * answer with the input unchanged. Losing compression is a cost; losing the
 * picture (or failing a `read` because of it) is not acceptable.
 */
export async function prepareStoredImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<StoredImage> {
  const unchanged: StoredImage = { bytes, mimeType, changed: false };
  if (!DECODABLE.has(mimeType)) return unchanged;
  // The common case is the cheap one: an image already inside the budget is
  // not decoded at all, which is where both screen tools' 1280x800 captures
  // and every small attachment end.
  if (bytes.byteLength <= STORED_IMAGE_BYTES) return unchanged;
  const canvas = await loadCanvas();
  if (canvas === undefined) return unchanged;
  let source: DecodedImage;
  try {
    // `loadImage`, never `Image.src`: a synchronous decode leaves state that
    // segfaults a Deno process on shutdown (see media/preview.ts).
    source = await canvas.loadImage(bytes);
  } catch {
    return unchanged;
  }
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) return unchanged;

  // One factor for both axes: the copy is a smaller picture of the same
  // shape, which is what lets a coordinate read off it be converted back
  // with a single number (rounding can move the height by a pixel).
  const longest = Math.max(sourceWidth, sourceHeight);
  let scale = Math.min(1, STORED_IMAGE_EDGE / longest);

  let best: Encoded | undefined;
  for (let attempt = 0; attempt <= SHRINK_STEPS; attempt++) {
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const encoded = encode(canvas, source, width, height);
    if (
      best === undefined || encoded.bytes.byteLength < best.bytes.byteLength
    ) {
      best = encoded;
    }
    if (encoded.bytes.byteLength <= STORED_IMAGE_BYTES) break;
    scale *= SHRINK_FACTOR;
  }
  if (best === undefined || best.bytes.byteLength >= bytes.byteLength) {
    return unchanged;
  }
  const rescaled = best.width !== sourceWidth || best.height !== sourceHeight;
  return {
    bytes: best.bytes,
    mimeType: best.mimeType,
    changed: true,
    size: { width: best.width, height: best.height },
    ...(rescaled
      ? { downscaledFrom: { width: sourceWidth, height: sourceHeight } }
      : {}),
  };
}

interface Encoded {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Draw `source` at `width` x `height` and encode it.
 *
 * PNG while it fits: it is lossless, so text and UI edges survive exactly as
 * they were rendered. Only an image that still has to lose bytes becomes a
 * JPEG, and only when it has no transparency to lose (a JPEG has no alpha
 * channel, and the transparent parts of the picture would come back black).
 */
function encode(
  canvas: CanvasModule,
  source: DecodedImage,
  width: number,
  height: number,
): Encoded {
  const target = canvas.createCanvas(width, height);
  const context = target.getContext("2d");
  context.drawImage(source, 0, 0, width, height);
  const png = new Uint8Array(target.toBuffer("image/png"));
  if (png.byteLength <= STORED_IMAGE_BYTES) {
    return { bytes: png, mimeType: "image/png", width, height };
  }
  // The alpha bytes are scanned only on this path: the one that has to
  // choose between two formats.
  const { data } = context.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) {
      return { bytes: png, mimeType: "image/png", width, height };
    }
  }
  const jpeg = new Uint8Array(target.toBuffer("image/jpeg", JPEG_QUALITY));
  return jpeg.byteLength < png.byteLength
    ? { bytes: jpeg, mimeType: "image/jpeg", width, height }
    : { bytes: png, mimeType: "image/png", width, height };
}
