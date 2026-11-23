/**
 * Moving one prompt file from the browser into the server, in chunks.
 *
 * The file is never read whole. Each 8 MiB slice is hashed with SHA-256, sent
 * with its expected hash, and only then does the server append it. The XHR is
 * used for the one thing fetch still cannot report in every browser the app
 * runs in: how much of the body has left the machine (upload.onprogress).
 */

import { enc, type PromptFileRef, paths } from "@lumisca/core/shared";
import {
  ApiError,
  apiPathOf,
  apiUrl,
  httpError,
  pageToken,
  parseError,
  request,
} from "./api-client.ts";

export type PromptUploadStatus =
  | "uploading"
  | "copying"
  | "completed"
  | "failed";

export interface PromptUploadState {
  status: PromptUploadStatus;
  size: number;
  bytes: number;
  saved?: PromptFileRef;
  error?: string;
}

/** One transfer's path, from the shared templates (core/shared/api-paths.ts):
 * the server registers the same ones (routes/prompt-uploads.ts). */
function uploadPath(agentId: string, uploadId?: string): string {
  const template =
    uploadId === undefined ? paths.conversationUploads : paths.upload;
  return `/api${apiPathOf(template, {
    agentId: enc(agentId),
    ...(uploadId === undefined ? {} : { uploadId: enc(uploadId) }),
  })}`;
}

/** The lowercase hex SHA-256 of one chunk. Web Crypto digests the 8 MiB
 * slice without blocking the page for long, and the server compares the same
 * digest before it writes the bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The DOM types insist on an ArrayBuffer-backed view; a plain Uint8Array
  // from a Blob is one at runtime, and the cast keeps the 8 MiB chunk from
  // being copied again just to satisfy the signature.
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Ask the server for a transfer. */
export function createPromptUpload(
  agentId: string,
  name: string,
  size: number,
  signal?: AbortSignal,
): Promise<{ id: string; offset: number }> {
  return request<{ id: string; offset: number }>(uploadPath(agentId), {
    method: "POST",
    body: JSON.stringify({ name, size }),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Append one chunk. Resolves with the offset the server now has. */
export function putPromptUploadChunk(
  agentId: string,
  uploadId: string,
  offset: number,
  bytes: Uint8Array,
  chunkHash: string,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<{ offset: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "PUT",
      apiUrl(`${uploadPath(agentId, uploadId)}?offset=${offset}`),
    );
    xhr.setRequestHeader("content-type", "application/octet-stream");
    const token = pageToken();
    if (token !== undefined && token !== "") {
      xhr.setRequestHeader("x-lumisca-token", token);
    }
    xhr.setRequestHeader("x-chunk-sha256", chunkHash);
    xhr.responseType = "text";

    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });

    const settle = (run: () => void) => {
      signal.removeEventListener("abort", abort);
      run();
    };

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onerror = () =>
      settle(() => reject(new ApiError("Failed to fetch", "network")));
    xhr.onabort = () =>
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        settle(() => {
          try {
            resolve(JSON.parse(xhr.responseText) as { offset: number });
          } catch (error) {
            reject(parseError(error, xhr.status));
          }
        });
        return;
      }
      settle(() => reject(httpError(xhr.status, xhr.responseText)));
    };
    xhr.send(bytes as unknown as XMLHttpRequestBodyInit);
  });
}

/** Ask the server to copy the finished transfer into the machine. */
export function completePromptUpload(
  agentId: string,
  uploadId: string,
  signal?: AbortSignal,
): Promise<{ status: PromptUploadStatus }> {
  return request<{ status: PromptUploadStatus }>(
    `/api${apiPathOf(paths.uploadComplete, {
      agentId: enc(agentId),
      uploadId: enc(uploadId),
    })}`,
    { method: "POST", ...(signal === undefined ? {} : { signal }) },
  );
}

/** One read of the transfer's state, used while the machine copy runs. */
export function getPromptUpload(
  agentId: string,
  uploadId: string,
  signal?: AbortSignal,
): Promise<PromptUploadState> {
  return request<PromptUploadState>(uploadPath(agentId, uploadId), {
    method: "GET",
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Forget a transfer that will not be sent. Failure here is not the reader's
 * problem: the store's own retention removes what is left behind. */
export function cancelPromptUpload(
  agentId: string,
  uploadId: string,
): Promise<void> {
  return request<{ ok: true }>(uploadPath(agentId, uploadId), {
    method: "DELETE",
  }).then(() => undefined);
}
