/**
 * Reading the files a user hands the composer.
 *
 * The composer accepts three paths — the file picker, a paste and a drop —
 * and all three end in the same place: an image becomes a `PendingImage`
 * (drawn inline by the chat), anything else a `PendingFile` (uploaded in
 * chunks and named in the prompt by the id the server returned; a mode with
 * no machine refuses it and says why — see {@link canAttach}).
 *
 * The size check, the upload queue and the failure message were written
 * twice inside Composer.tsx, once per kind, with only the shape they push
 * differing. Moved out because it is the one part of the composer that has
 * nothing to do with rendering: it reads bytes and enforces the API's limits.
 */

import type { Translator } from "@lumisca/core/shared";
import {
  MAX_PROMPT_FILE_BYTES,
  MAX_PROMPT_FILES,
  MAX_PROMPT_IMAGE_BASE64_LENGTH,
} from "@lumisca/core/shared";
import { useEffect, useRef, useState } from "preact/hooks";
import { describeError } from "../i18n.ts";
import type { PendingFile, PendingImage, PromptUploader } from "../types.ts";

/** How many files one composer transfers at once. A phone on a weak link
 * gets a steady pair of streams instead of one file starving the others. */
const MAX_CONCURRENT_UPLOADS = 2;

/**
 * Whether the composer can hold this file at all.
 *
 * A picture rides in the message, so every mode takes one. Anything else has
 * to be written into a machine before it can be sent, so a mode whose tools
 * work on the user's own folders has nowhere to put it. `canSendFiles` says
 * whether this caller has such a machine: it is the presence of the parent's
 * `onFilesChange`, which only the caller can answer.
 */
export function canAttach(
  file: { type: string },
  canSendFiles: boolean,
): boolean {
  return canSendFiles || file.type.startsWith("image/");
}

/** Whether one more picture fits in the message: the committed images plus
 * the reads still in flight, which the committed list does not see yet. */
export function imageSlotAvailable(
  committed: number,
  inFlight: number,
): boolean {
  return committed + inFlight < MAX_PROMPT_FILES;
}

export interface UseAttachmentsOptions {
  images: PendingImage[];
  files: PendingFile[];
  onImagesChange?: (images: PendingImage[]) => void;
  /** Where the parent keeps the files. Omitting it says the mode has no
   * machine to put them in: a non-image file is then refused with the reason
   * instead of being dropped on the floor (see {@link canAttach}). */
  onFilesChange?: (files: PendingFile[]) => void;
  /** Starts one file's transfer. Required when `onFilesChange` is given. */
  uploadFile?: PromptUploader;
  /** Which agent the files are for. A change of agent cancels the transfers
   * and drops the chips: an upload id names files inside one conversation's
   * machine, so carrying it to another would be a prompt without them. */
  fileTarget?: string;
  /** A catalogue-backed message builder, so the failure speaks the app's
   * language (and names the file). */
  t: Translator;
}

export interface Attachments {
  /** The last batch's failure, or null. Shown under the composer. Every
   * batch replaces it: the previous reason no longer describes what the
   * reader just did. */
  error: string | null;
  /** More pictures are attached than one prompt may carry. The composer
   * disables send until one is removed; the error says why. */
  overflow: boolean;
  /** Read a batch of files (a drop, a multi-file pick): an image goes to the
   * image list, anything else to the file list. The single entry point for
   * the picker, the paste and the drop. */
  addAll(files: Iterable<File>): void;
  /** Forget one file, stopping its transfer when it is still running. */
  remove(file: PendingFile): void;
}

export function useAttachments(options: UseAttachmentsOptions): Attachments {
  const {
    images,
    files,
    onImagesChange,
    onFilesChange,
    uploadFile,
    fileTarget,
    t,
  } = options;
  const [error, setError] = useState<string | null>(null);
  /** Pictures whose bytes are still being read. They are not in the images
   * list yet, so a burst of drops would otherwise pass the limit check
   * together. */
  const reservedImagesRef = useRef(0);

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

  // The queue is not state: starting the next transfer must not wait for a
  // render, and a progress event from one file must not restart another.
  const queueRef = useRef<Array<{ id: string; file: File }>>([]);
  const activeRef = useRef(0);
  const handlesRef = useRef(new Map<string, { cancel(): void }>());
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      queueRef.current = [];
      for (const handle of handlesRef.current.values()) handle.cancel();
      handlesRef.current.clear();
    },
    [],
  );

  // A file that is still marked as moving when this composer mounts cannot
  // be moving: its transfer died with the previous mount and nothing resumes
  // it. Saying so is better than a chip that never finishes and a send button
  // that stays disabled.
  useEffect(() => {
    const interrupted = filesRef.current.some(
      (file) => file.status === "uploading" || file.status === "copying",
    );
    // A done file names a path inside one agent's machine. The draft is
    // shared, so a chip left from another conversation is dropped here rather
    // than sent to a machine that cannot resolve it.
    const foreign = filesRef.current.some(
      (file) =>
        fileTarget !== undefined &&
        file.agentId !== undefined &&
        file.agentId !== fileTarget,
    );
    if (!interrupted && !foreign) return;
    filesRef.current = filesRef.current.filter((file) => {
      if (file.status === "uploading" || file.status === "copying")
        return false;
      if (
        fileTarget !== undefined &&
        file.agentId !== undefined &&
        file.agentId !== fileTarget
      ) {
        return false;
      }
      return true;
    });
    onFilesChange?.(filesRef.current);
    if (interrupted) setError(t("chat.composer.attach.interrupted"));
  }, []);

  // Another agent means another machine: the transfer ids from the previous
  // one would not resolve here. Cancel them and clear the chips rather than
  // show files that the next prompt would have to refuse.
  const targetRef = useRef(fileTarget);
  useEffect(() => {
    if (targetRef.current === fileTarget) return;
    targetRef.current = fileTarget;
    queueRef.current = [];
    for (const handle of handlesRef.current.values()) handle.cancel();
    handlesRef.current.clear();
    activeRef.current = 0;
    if (filesRef.current.length > 0) {
      filesRef.current = [];
      onFilesChange?.([]);
    }
  }, [fileTarget]);

  const update = (id: string, patch: Partial<PendingFile>): void => {
    filesRef.current = filesRef.current.map((file) =>
      file.id === id ? { ...file, ...patch } : file,
    );
    onFilesChange?.(filesRef.current);
  };

  const drop = (id: string): void => {
    filesRef.current = filesRef.current.filter((file) => file.id !== id);
    onFilesChange?.(filesRef.current);
  };

  /** Start transfers until the concurrency bound is reached. */
  function startNext(): void {
    while (
      mountedRef.current &&
      activeRef.current < MAX_CONCURRENT_UPLOADS &&
      queueRef.current.length > 0
    ) {
      const next = queueRef.current.shift()!;
      if (!filesRef.current.some((file) => file.id === next.id)) continue;
      if (uploadFile === undefined) {
        update(next.id, {
          status: "failed",
          error: t("chat.composer.attach.uploadUnavailable"),
        });
        setError(t("chat.composer.attach.uploadUnavailable"));
        continue;
      }
      activeRef.current += 1;
      const handle = uploadFile(next.file, (progress) => {
        update(next.id, {
          uploaded: progress.uploaded,
          status: progress.status,
        });
      });
      handlesRef.current.set(next.id, handle);
      handle.done
        .then((uploadId) => {
          if (!mountedRef.current) return;
          handlesRef.current.delete(next.id);
          update(next.id, {
            status: "done",
            uploaded: next.file.size,
            uploadId,
          });
        })
        .catch((failure: unknown) => {
          if (!mountedRef.current) return;
          handlesRef.current.delete(next.id);
          // A cancel is the reader's own action or a move to another machine:
          // the chip goes away instead of turning into a failure they made.
          if (
            failure instanceof DOMException &&
            failure.name === "AbortError"
          ) {
            drop(next.id);
            return;
          }
          const message = describeError(failure, t);
          update(next.id, { status: "failed", error: message });
          setError(message);
        })
        .finally(() => {
          activeRef.current -= 1;
          startNext();
        });
    }
  }

  /** Read `file` and hand the result to `accept`, or explain why not. Only
   * pictures take this path now: their bytes ride in the prompt body. */
  const read = (
    file: File,
    accept: (dataUrl: string) => void,
    onSettled: () => void,
  ): void => {
    if (Math.ceil(file.size / 3) * 4 > MAX_PROMPT_IMAGE_BASE64_LENGTH) {
      onSettled();
      setError(t("chat.composer.attach.tooLarge", { name: file.name }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        onSettled();
        return;
      }
      // The failure message belongs to the batch, not to this read: clearing
      // it here would erase a refusal from a file beside this one (a drop of
      // a picture and a log), because the read finishes after the refusal
      // was made.
      accept(reader.result);
      onSettled();
    };
    // A read can fail (a folder, a file that moved, a revoked permission).
    // Staying silent left the reader with a button that did nothing.
    reader.onerror = () => {
      onSettled();
      setError(t("chat.composer.attach.readFailed", { name: file.name }));
    };
    reader.readAsDataURL(file);
  };

  /** Add a file that is not an image: the browser keeps the handle and the
   * transfer reads it one chunk at a time. */
  const addFile = (file: File): void => {
    if (filesRef.current.length >= MAX_PROMPT_FILES) {
      setError(
        t("chat.composer.attach.tooManyFiles", { count: MAX_PROMPT_FILES }),
      );
      return;
    }
    if (file.size > MAX_PROMPT_FILE_BYTES) {
      setError(t("chat.composer.attach.tooLarge", { name: file.name }));
      return;
    }
    const id = crypto.randomUUID();
    const pending: PendingFile = {
      id,
      name: file.name,
      size: file.size,
      file,
      status: "uploading",
      uploaded: 0,
      ...(fileTarget === undefined ? {} : { agentId: fileTarget }),
    };
    filesRef.current = [...filesRef.current, pending];
    onFilesChange?.(filesRef.current);
    queueRef.current.push({ id, file });
    startNext();
  };

  /** Add a pasted/dropped image to the attachments (inline in the chat). */
  const addImage = (file: File): void => {
    if (
      !imageSlotAvailable(imagesRef.current.length, reservedImagesRef.current)
    ) {
      setError(
        t("chat.composer.attach.tooManyImages", { count: MAX_PROMPT_FILES }),
      );
      return;
    }
    reservedImagesRef.current += 1;
    read(
      file,
      (dataUrl) => {
        imagesRef.current = [
          ...imagesRef.current,
          {
            data: dataUrl,
            mimeType: file.type || "image/png",
            name: file.name,
          },
        ];
        onImagesChange?.(imagesRef.current);
      },
      () => {
        reservedImagesRef.current = Math.max(0, reservedImagesRef.current - 1);
      },
    );
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

  const overflow = images.length > MAX_PROMPT_FILES;
  const wasOverflow = useRef(false);
  // A draft can carry more pictures than one prompt may send (it was built
  // before this check existed, or a read raced a removal). Say so as soon as
  // it is on screen, not after the server refuses the send. Removing one
  // clears the reason again.
  useEffect(() => {
    if (overflow) {
      setError(
        t("chat.composer.attach.tooManyImages", { count: MAX_PROMPT_FILES }),
      );
    } else if (wasOverflow.current) {
      setError(null);
    }
    wasOverflow.current = overflow;
  }, [overflow, t]);

  return {
    error,
    overflow,
    addAll(files: Iterable<File>): void {
      setError(null);
      for (const file of files) addOne(file);
    },
    remove(file: PendingFile): void {
      queueRef.current = queueRef.current.filter((item) => item.id !== file.id);
      const handle = handlesRef.current.get(file.id);
      if (handle !== undefined) {
        handlesRef.current.delete(file.id);
        handle.cancel();
      }
      drop(file.id);
      startNext();
    },
  };
}
