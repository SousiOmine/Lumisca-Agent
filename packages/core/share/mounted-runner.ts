/**
 * Where a command runs, for a session that can work in more than one place.
 *
 * `bash` resolves its `cwd` through the file namespace first, so by the time
 * a command reaches a {@link CommandRunner} the directory is a path the
 * namespace claims to have. This class is what answers "which machine owns
 * that directory": the session's own (this machine, or the stella VM), or a
 * computer that lent a folder WITH command access.
 *
 * The two refusals matter as much as the routing: a folder lent without
 * command access must fail loudly rather than quietly running the command
 * where the session normally works (a `rm` meant for the user's machine
 * running inside the VM is a wrong action that reports success), and a cwd
 * outside the namespace is a bug in the caller, not a place to guess.
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
    if (!grant.exec) {
      throw new CoreError(
        `${root} was lent without command access: the file tools can read ` +
          "and change it, but commands cannot run there. Ask the user to " +
          "lend it with commands if that is what the task needs.",
        "forbidden",
      );
    }
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
