/**
 * Reading the files a user hands the composer.
 *
 * The composer accepts three paths — the file picker, a paste and a drop —
 * and all three end in the same place: an image becomes a `PendingImage`
 * (drawn inline by the chat), anything else a `PendingFile` (written into the
 * machine and sent by name; a mode with no machine refuses it and says why —
 * see {@link canAttach}). The size check, the `FileReader` wiring and the
 * failure message were written twice inside Composer.tsx, once per kind, with
 * only the shape they push differing.
 *
 * Moved out because it is the one part of the composer that has nothing to do
 * with rendering: it reads bytes and enforces the API's limits.
 */

import {
  MAX_PROMPT_FILE_BASE64_LENGTH,
  MAX_PROMPT_FILES,
  stripDataUrlHeader,
} from "@lumisca/core/shared";
import { useEffect, useRef, useState } from "preact/compat";
import type { PendingFile, PendingImage } from "../types.ts";

/**
 * Whether the composer can hold this file at all.
 *
 * A picture rides in the message, so every mode takes one. Anything else has
 * to be written into a machine before it can be sent (`savePromptUploads` in
 * core/services/sessions.ts), so a mode whose tools work on the user's own
 * folders has nowhere to put it. `canSendFiles` says whether this caller has
 * such a machine: it is the presence of the parent's `onFilesChange`, which
 * only the caller can answer.
 */
export function canAttach(
  file: { type: string },
  canSendFiles: boolean,
): boolean {
  return canSendFiles || file.type.startsWith("image/");
}

export interface UseAttachmentsOptions {
  images: PendingImage[];
  files: PendingFile[];
  onImagesChange?: (images: PendingImage[]) => void;
  /** Where the parent keeps the files. Omitting it says the mode has no
   * machine to put them in: a non-image file is then refused with the reason
   * instead of being dropped on the floor (see {@link canAttach}). */
  onFilesChange?: (files: PendingFile[]) => void;
  /** A catalogue-backed message builder, so the failure speaks the app's
   * language (and names the file). */
  t: (
    key:
      | "chat.composer.attach.tooLarge"
      | "chat.composer.attach.readFailed"
      | "chat.composer.attach.imageOnly",
    params: { name: string },
  ) => string;
}

export interface Attachments {
  /** The last batch's failure, or null. Shown under the composer. Every
   * batch replaces it: the previous reason no longer describes what the
   * reader just did. */
  error: string | null;
  /** Read a batch of files (a drop, a multi-file pick): an image goes to the
   * image list, anything else to the file list. The single entry point for
   * the picker, the paste and the drop. */
  addAll(files: Iterable<File>): void;
}

export function useAttachments(options: UseAttachmentsOptions): Attachments {
  const { images, files, onImagesChange, onFilesChange, t } = options;
  const [error, setError] = useState<string | null>(null);

  // Bursts (a drop of ten files) must not each append from the closure's
  // copy of the list: the ref follows the latest props within the same tick.
  const imagesRef = useRef(images);
  const filesRef = useRef(files);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  /** Whether `size` bytes turn into more base64 characters than the API
   * accepts. The server compares the encoded length, so the check is made on
   * the encoded length too (`ceil(n / 3) * 4`, without padding): a file at
   * exactly the binary limit must pass here as well. */
  const tooLarge = (size: number): boolean =>
    Math.ceil(size / 3) * 4 > MAX_PROMPT_FILE_BASE64_LENGTH;

  /** Read `file` and hand the result to `accept`, or explain why not. */
  const read = (file: File, accept: (dataUrl: string) => void): void => {
    if (tooLarge(file.size)) {
      setError(t("chat.composer.attach.tooLarge", { name: file.name }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      // The failure message belongs to the batch, not to this read: clearing
      // it here would erase a refusal from a file beside this one (a drop of
      // a picture and a log), because the read finishes after the refusal
      // was made.
      accept(reader.result);
    };
    // A read can fail (a folder, a file that moved, a revoked permission).
    // Staying silent left the reader with a button that did nothing.
    reader.onerror = () => {
      setError(t("chat.composer.attach.readFailed", { name: file.name }));
    };
    reader.readAsDataURL(file);
  };

  /** Add a file that is not an image: it goes to the machine, so the browser
   * only has to read the bytes (no preview, no data URL header). */
  const addFile = (file: File): void => {
    if (filesRef.current.length >= MAX_PROMPT_FILES) return;
    read(file, (dataUrl) => {
      filesRef.current = [
        ...filesRef.current,
        { name: file.name, size: file.size, data: stripDataUrlHeader(dataUrl) },
      ];
      onFilesChange?.(filesRef.current);
    });
  };

  /** Add a pasted/dropped image to the attachments (inline in the chat). */
  const addImage = (file: File): void => {
    if (imagesRef.current.length >= MAX_PROMPT_FILES) return;
    read(file, (dataUrl) => {
      imagesRef.current = [
        ...imagesRef.current,
        { data: dataUrl, mimeType: file.type || "image/png", name: file.name },
      ];
      onImagesChange?.(imagesRef.current);
    });
  };

  /** Read one file into the list it belongs to, or explain why not. */
  const addOne = (file: File): void => {
    if (!canAttach(file, onFilesChange !== undefined)) {
      setError(t("chat.composer.attach.imageOnly", { name: file.name }));
      return;
    }
    // An image is also a file: it is shown inline by the chat, so it takes
    // the image path. Everything else has no preview and is sent by name.
    if (file.type.startsWith("image/")) addImage(file);
    else addFile(file);
  };

  return {
    error,
    addAll(files: Iterable<File>): void {
      setError(null);
      for (const file of files) addOne(file);
    },
  };
}
