/**
 * Reading the files a user hands the composer.
 *
 * The composer accepts three paths — the file picker, a paste and a drop —
 * and all three end in the same place: an image becomes a `PendingImage`
 * (drawn inline by the chat), anything else a `PendingFile` (written into the
 * machine and sent by name). The size check, the `FileReader` wiring and the
 * failure message were written twice inside Composer.tsx, once per kind, with
 * only the shape they push differing.
 *
 * Moved out because it is the one part of the composer that has nothing to do
 * with rendering: it reads bytes and enforces the API's limits.
 */
import { useEffect, useRef, useState } from "preact/compat";
import {
  MAX_PROMPT_FILE_BASE64_LENGTH,
  MAX_PROMPT_FILES,
  stripDataUrlHeader,
} from "@lumisca/core/shared";
import type { PendingFile, PendingImage } from "../types.ts";

export interface UseAttachmentsOptions {
  images: PendingImage[];
  files: PendingFile[];
  onImagesChange?: (images: PendingImage[]) => void;
  onFilesChange?: (files: PendingFile[]) => void;
  /** A catalogue-backed message builder, so the failure speaks the app's
   * language (and names the file). */
  t: (
    key: "chat.composer.attach.tooLarge" | "chat.composer.attach.readFailed",
    params: { name: string },
  ) => string;
}

export interface Attachments {
  /** The last failure, or null. Shown under the composer. */
  error: string | null;
  /** Read one file: an image goes to the image list, anything else to the
   * file list. The single entry point for the picker, paste and drop. */
  add(file: File): void;
  /** Read a whole batch (a drop, a multi-file pick). */
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
  const read = (
    file: File,
    accept: (dataUrl: string) => void,
  ): void => {
    if (tooLarge(file.size)) {
      setError(t("chat.composer.attach.tooLarge", { name: file.name }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setError(null);
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

  return {
    error,
    add(file: File): void {
      // An image is also a file: it is shown inline by the chat, so it takes
      // the image path. Everything else has no preview and is sent by name.
      if (file.type.startsWith("image/")) addImage(file);
      else addFile(file);
    },
    addAll(files: Iterable<File>): void {
      for (const file of files) this.add(file);
    },
  };
}
