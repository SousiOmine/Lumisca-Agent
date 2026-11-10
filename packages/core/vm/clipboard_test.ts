import { assertEquals, assertRejects } from "@std/assert";
import { createVmClipboard, VM_CLIPBOARD_MAX_CHARS } from "./clipboard.ts";
import type { VmExec, VmExecOptions } from "./container.ts";
import type { VmCommandResult } from "./command.ts";

const decoder = new TextDecoder();

interface Call {
  argv: string[];
  stdin: Uint8Array | undefined;
}

/** A scripted exec seam: every call is recorded (argv and stdin) and answered
 * by `answer`. */
function exec(
  answer: (call: Call) => Partial<VmCommandResult>,
): { run: VmExec; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: (command: readonly string[], options: VmExecOptions) => {
      const call = { argv: [...command], stdin: options.stdin };
      calls.push(call);
      return Promise.resolve<VmCommandResult>({
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        ...answer(call),
      });
    },
  };
}

/** The write call of a script (the read-back does not carry `-i`). */
function isWrite(call: Call): boolean {
  return call.argv.includes("-i");
}

Deno.test("vm clipboard: a read returns the machine's text as UTF-8", async () => {
  const { run, calls } = exec(() => ({
    stdout: "日本語テキスト\n二行目",
  }));
  const clipboard = createVmClipboard({ exec: run });
  assertEquals(await clipboard.read(), "日本語テキスト\n二行目");
  // CLIPBOARD, not PRIMARY: the user's Ctrl+C puts the text there, and that is
  // what an application pastes.
  assertEquals(calls[0]!.argv, ["xclip", "-o", "-selection", "clipboard"]);
});

Deno.test("vm clipboard: an unowned selection is an empty clipboard", async () => {
  // Measured on the machine: `xclip -o` answers exit 1 and this line when
  // nothing has been copied yet. That is not a broken machine.
  const { run } = exec(() => ({
    exitCode: 1,
    stderr: "Error: target STRING not available\n",
  }));
  const clipboard = createVmClipboard({ exec: run });
  assertEquals(await clipboard.read(), "");
});

Deno.test("vm clipboard: a machine without xclip is a failure, not an empty clipboard", async () => {
  // An image built before this code has no xclip. Reading that as "nothing
  // was copied" would make the pane look like it worked.
  const { run } = exec(() => ({ exitCode: 127, stderr: "xclip: not found" }));
  const clipboard = createVmClipboard({ exec: run });
  await assertRejects(() => clipboard.read(), Error, "not found");
});

Deno.test("vm clipboard: a selection too large to carry is refused", async () => {
  const { run } = exec(() => ({ truncated: true }));
  const clipboard = createVmClipboard({ exec: run });
  await assertRejects(() => clipboard.read(), Error, "larger than");
});

Deno.test("vm clipboard: a write goes in through stdin, in one shape", async () => {
  // Windows line endings are what a browser copies; an application inside the
  // machine would insert the `\r` literally, so the text is normalized on the
  // way in. The text itself never appears in argv: it may be a password.
  const { run, calls } = exec((call) =>
    isWrite(call) ? {} : { stdout: "パスワード\n二行目" }
  );
  const clipboard = createVmClipboard({ exec: run });
  await clipboard.write("パスワード\r\n二行目");
  assertEquals(calls.length, 2);
  assertEquals(calls[0]!.argv, ["xclip", "-i", "-selection", "clipboard"]);
  assertEquals(decoder.decode(calls[0]!.stdin), "パスワード\n二行目");
});

Deno.test("vm clipboard: a write the machine did not keep fails", async () => {
  // The selection is served by the xclip the write started, from the
  // background. If it did not survive, the paste that follows would be empty,
  // so the write must not answer "ok" here.
  const { run } = exec((call) =>
    isWrite(call) ? {} : { stdout: "something else" }
  );
  const clipboard = createVmClipboard({ exec: run });
  await assertRejects(() => clipboard.write("テキスト"), Error, "did not keep");
});

Deno.test("vm clipboard: empty text leaves the machine alone", async () => {
  const { run, calls } = exec(() => ({}));
  const clipboard = createVmClipboard({ exec: run });
  await clipboard.write("");
  assertEquals(calls.length, 0);
});

Deno.test("vm clipboard: text past the bound is refused before the machine is touched", async () => {
  const { run, calls } = exec(() => ({}));
  const clipboard = createVmClipboard({ exec: run });
  await assertRejects(
    () => clipboard.write("a".repeat(VM_CLIPBOARD_MAX_CHARS + 1)),
    Error,
    "longer than",
  );
  assertEquals(calls.length, 0);
});

Deno.test("vm clipboard: a wedged machine ends the call with its reason", async () => {
  const { run } = exec(() => ({ exitCode: -1, timedOut: true }));
  const clipboard = createVmClipboard({ exec: run });
  await assertRejects(() => clipboard.read(), Error, "did not answer");
});
