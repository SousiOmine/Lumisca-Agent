/**
 * The `systemctl --user` / `loginctl` boundary: the only place the service
 * command reaches systemd.
 *
 * The tools are thin wrappers, not a reimplementation of supervision: the
 * unit owns the lifecycle (`Restart=always`), and these calls only write the
 * definition, hand it to systemd, and read its state back. A non-zero exit is
 * returned rather than thrown, because some callers ask with a command whose
 * exit code *is* the answer (`is-active`, `is-enabled`); a failure to start
 * the tool at all is thrown, since nothing can be inferred from it.
 */

/** Result of one external command, decoded and trimmed. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** systemd and logind, as the service command uses them. */
export interface ServiceRunner {
  /** `systemctl --user <args>`. */
  systemctl(args: readonly string[]): Promise<CommandResult>;
  /** `loginctl <args>`. */
  loginctl(args: readonly string[]): Promise<CommandResult>;
}

/** A systemd tool that could not be run at all. */
export class ServiceCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceCommandError";
  }
}

export function createSystemdRunner(): ServiceRunner {
  const run = async (
    program: string,
    args: readonly string[],
  ): Promise<CommandResult> => {
    const output = await new Deno.Command(program, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output().catch((error) => {
      throw new ServiceCommandError(
        `${program} を実行できません: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    const decode = (bytes: Uint8Array) =>
      new TextDecoder().decode(bytes).trim();
    return {
      code: output.code,
      stdout: decode(output.stdout),
      stderr: decode(output.stderr),
    };
  };
  return {
    systemctl: (args) => run("systemctl", ["--user", ...args]),
    loginctl: (args) => run("loginctl", args),
  };
}
