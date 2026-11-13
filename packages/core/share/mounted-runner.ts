/**
 * Where a command runs, for a session that can work in more than one place.
 *
 * `bash` resolves its `cwd` through the file namespace first, so by the time
 * a command reaches a {@link CommandRunner} the directory is a path the
 * namespace claims to have. This class is what answers "which machine owns
 * that directory": the session's own (this machine, or the stella VM), or a
 * computer that lent a folder. Commands always run there — a lent folder is
 * somewhere the agent may look around, and the write permission only governs
 * the file tools.
 *
 * The refusal matters as much as the routing: a cwd outside the namespace is
 * a bug in the caller, not a place to guess.
 */
import { CoreError } from "../errors.ts";
import type {
  CommandRunner,
  RunOptions,
  ShellRunResult,
} from "../tools/command-backend.ts";
import type { FolderGrant } from "./grant.ts";
import { grantOwning, relativeSegments, shareRootOf } from "./grant.ts";
import type { ShareTransport } from "./ops.ts";

export class MountedRunner implements CommandRunner {
  readonly #primary: CommandRunner;
  readonly #transport: ShareTransport;
  readonly #grants: () => readonly FolderGrant[];

  constructor(
    primary: CommandRunner,
    transport: ShareTransport,
    grants: () => readonly FolderGrant[],
  ) {
    this.#primary = primary;
    this.#transport = transport;
    this.#grants = grants;
  }

  async run(command: string, options: RunOptions): Promise<ShellRunResult> {
    const grant = grantOwning(this.#grants(), options.cwd);
    if (grant === undefined) return this.#primary.run(command, options);
    const root = shareRootOf(grant.name);
    const segments = relativeSegments(root, options.cwd);
    if (segments === undefined) {
      // The file namespace resolved a path the grant does not own: a wiring
      // bug, and running the command anywhere at all would hide it.
      throw new CoreError(
        `The working directory is not inside ${root}: ${options.cwd}`,
        "invalid",
      );
    }
    return this.#transport.call(
      grant.id,
      "exec",
      {
        path: segments,
        command,
        timeoutSec: options.timeoutSec,
        maxOutputChars: options.maxOutputChars,
        ...(options.baseEnv === undefined && options.env === undefined
          ? {}
          : { env: { ...options.baseEnv, ...options.env } }),
      },
      options.signal,
    );
  }
}
