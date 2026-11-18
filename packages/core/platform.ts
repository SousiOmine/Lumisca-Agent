/**
 * The platform constants the app compares against. Computed from Bun's
 * process, in the names the app already uses ("windows", "x86_64", a Rust
 * target triple), so a call site never compares Node's "win32" with a
 * release manifest's "windows".
 */

/** Operating system, in the names the release manifests and the tools use. */
export const OS: "windows" | "darwin" | "linux" | (string & {}) =
  process.platform === "win32" ? "windows" : process.platform;

export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/** CPU architecture, in the names the release manifests use. */
export const ARCH: "x86_64" | "aarch64" | (string & {}) =
  process.arch === "x64"
    ? "x86_64"
    : process.arch === "arm64"
      ? "aarch64"
      : process.arch;

/** Rust target triple of this build, the key of the release manifest. */
export const TARGET =
  OS === "windows"
    ? `${ARCH}-pc-windows-msvc`
    : OS === "darwin"
      ? `${ARCH}-apple-darwin`
      : `${ARCH}-unknown-linux-gnu`;

/** True for a packaged server (`bun build --compile`), which owns its
 * installation; a `bun run` server does not. */
export const IS_STANDALONE = Bun.isStandaloneExecutable;

/** The launcher's own arguments (without the runtime and the entry). */
export function commandArgs(): string[] {
  return process.argv.slice(2);
}
