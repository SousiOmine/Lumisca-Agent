/**
 * The context every sandboxed filesystem tool receives. One definition so a
 * change to the sandbox surface cannot land in one tool file and miss the
 * other.
 */
import type { Sandbox } from "../workspace/sandbox.ts";

export interface FsToolContext {
  sandbox: Sandbox;
}
