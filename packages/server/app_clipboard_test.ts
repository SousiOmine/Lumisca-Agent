import { fauxAssistantMessage, fauxProvider, LumiscaCore } from "@lumisca/core";
import { assertEquals } from "@std/assert";
import { startServer } from "./app.ts";
import { json } from "./test-utils.ts";

/**
 * The machine's clipboard, as the chat's screen pane drives it.
 *
 * The exchange cannot go over the VNC connection (its cut text is ISO 8859-1,
 * so Japanese arrives as question marks), so it crosses the server as one
 * `xclip` call. These tests cover the two things the route decides: what may
 * read and write it, and that the text itself is carried as bytes (through
 * stdin), never as an argument.
 */

/** A machine with a clipboard. `xclip -i` stores what crossed in, `xclip -o`
 * answers with what is stored — the shape the real one has, without podman. */
function clipboardMachine() {
  const calls: { argv: string[]; stdin: Uint8Array | undefined }[] = [];
  let stored = "";
  return {
    calls,
    text: () => stored,
    run: (command: readonly string[], options: { stdin?: Uint8Array }) => {
      const argv = [...command];
      calls.push({ argv, stdin: options.stdin });
      if (argv.includes("-i") && options.stdin !== undefined) {
        stored = new TextDecoder().decode(options.stdin);
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: argv.includes("-o") ? stored : "",
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    },
    runBytes: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: "",
        truncated: false,
        timedOut: false,
      }),
  };
}

Deno.test("stella clipboard: the machine's text crosses the server, in UTF-8", async () => {
  const machine = clipboardMachine();
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider], () => ({}), machine);
  const server = startServer(core, 0);
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    core.setStellaVm({
      status: () =>
        Promise.resolve({ state: "running", vncPort: null, reason: "" }),
      start: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      stop: () => Promise.resolve(),
      vncPort: () => Promise.resolve(null),
    });
    const created = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Aide", role: "Help with the work." }),
    });
    const agent = (await created.json()) as { id: string };
    // Opening an agent starts the app's setup turn; a scripted reply keeps
    // that turn from reaching the log (the clipboard is the subject here).
    faux.setResponses([fauxAssistantMessage("Hello.")]);
    const opened = await json(base, `/api/stella/conversations/${agent.id}`);
    assertEquals(opened.status, 200);
    const session = (await opened.json()) as { sessionId: string };

    // Nothing has been copied in the machine yet. That is an empty clipboard,
    // not a failure: the pane shows "nothing yet" rather than an error.
    const empty = await json(
      base,
      `/api/stella/conversations/${agent.id}/clipboard`,
    );
    assertEquals(empty.status, 200);
    assertEquals(((await empty.json()) as { text: string }).text, "");

    // The agent is working, so the screen (and its clipboard) is still the
    // agent's: a write is refused until the agent asks for help.
    const refused = await json(
      base,
      `/api/stella/conversations/${agent.id}/clipboard`,
      { method: "POST", body: JSON.stringify({ text: "秘密" }) },
    );
    assertEquals(refused.status, 409);

    // What the pane does once the user is at the screen. The text keeps its
    // Japanese and loses the browser's Windows line endings on the way in.
    await core.writeStellaClipboard(session.sessionId, "日本語\r\n二行目");
    assertEquals(machine.text(), "日本語\n二行目");
    const read = await json(
      base,
      `/api/stella/conversations/${agent.id}/clipboard`,
    );
    assertEquals(
      ((await read.json()) as { text: string }).text,
      "日本語\n二行目",
    );

    // Through stdin, never argv: the text may be a password, and an argument
    // is readable by anything inside the machine that lists processes.
    const write = machine.calls.find((call) => call.argv.includes("-i"));
    assertEquals(write !== undefined, true);
    assertEquals(new TextDecoder().decode(write!.stdin), "日本語\n二行目");
    assertEquals(write!.argv.join(" ").includes("日本語"), false);
  } finally {
    server.shutdown();
    await core.close();
  }
});
