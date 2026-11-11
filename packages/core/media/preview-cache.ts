/**
 * The preview a published image is drawn from, and where its file lives.
 *
 * A conversation fills up with pictures: a `vm_screenshot` is 1280x800, a
 * phone photo is 4000px wide, and an agent that pastes several makes a
 * conversation heavy. Each is drawn a few hundred pixels wide — every byte
 * above that is decoded, laid out and thrown away on every scroll. The
 * original is kept exactly as it was (a click opens it, and the model reads
 * it); this is the small copy the list draws.
 *
 * A preview is a pure function of the source file and {@link PREVIEW_EDGE}
 * (see media/preview.ts), so it is stored beside that source under a name
 * derived from it — {@link previewName}. Nothing has to be recorded to know
 * whether a preview exists: look for the name, and produce it when it is
 * missing. A source whose name never changes therefore cannot serve a stale
 * preview, and the byte cache needs no invalidation at all.
 */

import { join } from "node:path";
import { renderPreview } from "../media/preview.ts";
import { runtime } from "../runtime/runtime.ts";

/** Suffix appended to a source name to name its preview. `.preview` cannot
 * collide with a real asset extension (an extension starts with the media
 * type's own letters), and it is what the asset route strips to find the
 * source again. */
const PREVIEW_SUFFIX = ".preview";

/** The preview's file name for a source name. */
export function previewName(name: string): string {
  return `${name}${PREVIEW_SUFFIX}`;
}

/**
 * The preview `name` refers to, producing it on first use.
 *
 * Returns `undefined` when this file cannot have one — a name without the
 * suffix, an image the encoder cannot read, or one already within
 * {@link PREVIEW_EDGE} (re-encoding it would only make it bigger). The caller
 * then serves the original, which is exactly what a preview would be.
 *
 * A write that fails is not an error for the caller: the original is still a
 * correct answer, so a full disk costs sharpness, not the picture.
 */
export async function ensurePreview(
  sourcePath: string,
  previewPath: string,
  mimeType: string,
): Promise<Uint8Array | undefined> {
  // The cache hits on every draw after the first, so it is asked first.
  try {
    return await runtime.readFile(previewPath);
  } catch (error) {
    if (!(error instanceof runtime.errors.NotFound)) throw error;
  }
  let source: Uint8Array;
  try {
    source = await runtime.readFile(sourcePath);
  } catch {
    // The asset went away between the resolve and this read: the caller
    // answers 404 from its own resolve, so nothing to add here.
    return undefined;
  }
  const preview = await renderPreview(source, mimeType);
  if (preview === undefined) return undefined;
  try {
    // Written to a temporary name and renamed: a concurrent request must
    // never read a half-written preview.
    const temporary = `${previewPath}.${crypto.randomUUID()}.tmp`;
    await runtime.writeFile(temporary, preview);
    await runtime.rename(temporary, previewPath);
  } catch {
    // A preview is an optimisation: keep serving the original.
  }
  return preview;
}

/** Where the preview of `sourcePath` goes (its source's own directory). */
export function previewPathOf(sourcePath: string, sourceName: string): string {
  return join(sourcePath.slice(0, -sourceName.length), previewName(sourceName));
}
