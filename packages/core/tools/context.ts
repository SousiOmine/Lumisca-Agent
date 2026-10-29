/**
 * The context every file and search tool receives: the backend its paths
 * resolve against.
 *
 * One field, because every tool in this family works the same way whatever
 * the backend is — the host's own disk (`HostFileBackend`, backed by a
 * workspace sandbox) or the stella session's virtual machine
 * (`VmFileBackend`, over `podman exec`). A tool never learns which.
 */
import type { FileBackend } from "./file-backend.ts";

export interface FsToolContext {
  files: FileBackend;
}
