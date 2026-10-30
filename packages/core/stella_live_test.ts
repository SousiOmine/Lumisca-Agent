import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./ai/faux.ts";
import { LumiscaCore } from "./core.ts";
import { createVmManager } from "./vm/container.ts";

import { VM_WORKDIR, vmAgentDir } from "./vm/contract.ts";
import type { AgentMessage } from "./ai/types.ts";
import { promptSession } from "./test-utils.ts";

/**
 * The stella conversation, end to end inside a real container.
 *
 * Unlike the other stella tests (which script the machine), this one builds
 * nothing and starts nothing: it runs only where the image already exists and
 * podman answers, and it SKIPS otherwise. When it does run, it is the check
 * that cannot be faked — a tool call from the model really does execute inside
 * the machine, and the file it writes is really there afterwards.
 *
 * Run explicitly:
 *   deno test packages/core/stella_live_test.ts --allow-all
 */

const containerDir = new URL("./vm/container/", import.meta.url).pathname;

/** Whether this host can run the machine at all (podman plus a built image).
 * Read without side effects: a status query only. */
async function machineReady(): Promise<boolean> {
  const vm = createVmManager({ containerDir });
  const status = await vm.status({ fresh: true });
  return status.state === "running";
}

Deno.test("stella live: a tool call runs inside the machine", {
  ignore: !(await machineReady()),
}, async () => {
  const vm = createVmManager({ containerDir });
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    core.setStellaVm(vm);
    await core.getStellaAvailability();

    // A fresh core has no counterpart yet: stella has no default agent
    // (the first run asks the user to name one), so the test makes its own.
    const counterpart = core.createStellaAgent({
      name: "Live Check",
      role: "Verifies that tools run inside the machine.",
    });
    const session = await core.getOrCreateStellaSession(counterpart.id);
    // The agent is open; its tool set is the machine's (the VM tools are
    // preloaded and `eval` — the one host-process escape — is not).
    const agent = core.getAgent(session.id);
    assert(agent !== undefined, "the stella agent must be open");

    // A write through the file tool must land inside the machine.
    const target = `${VM_WORKDIR}/live-check.txt`;
    await Deno.remove(target).catch(() => {});

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write", {
          path: target,
          content: "written from inside the machine\n",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    // `agent.prompt` resolves once the run settles (tool calls included), so
    // the assertions below see the transcript the run produced.
    await promptSession(core, session.id, "write the file");

    const exists = await new Deno.Command("podman", {
      args: [
        "exec",
        "--workdir",
        VM_WORKDIR,
        "lumisca-stella",
        "cat",
        target,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      exists.success,
      `the file is not in the machine: ${
        new TextDecoder().decode(exists.stderr)
      }`,
    );
    assertEquals(
      new TextDecoder().decode(exists.stdout),
      "written from inside the machine\n",
    );

    // Nowhere on this host did it appear.
    let onHost = true;
    try {
      await Deno.stat(target);
    } catch {
      onHost = false;
    }
    assertEquals(
      onHost,
      false,
      `the file must not exist on the host: ${target}`,
    );

    // And nothing the agent wrote is reachable through the machine's own
    // transcript, either: the path was the machine's, not a workspace's.
    const messages: AgentMessage[] = agent.messages;
    const results = messages.filter((message) => message.role === "toolResult");
    assertEquals(results.length > 0, true);
  } finally {
    await core.close();
  }
});

Deno.test(
  "stella live: history_search reads a turn back from the machine's conversation",
  {
    ignore: !(await machineReady()),
  },
  async () => {
    const vm = createVmManager({ containerDir });
    const faux = fauxProvider();
    const core = LumiscaCore.forTesting([faux.provider]);
    try {
      await core.setProviderApiKey(faux.provider.id, "faux-key");
      core.setStellaVm(vm);
      await core.getStellaAvailability();

      const counterpart = core.createStellaAgent({
        name: "History Reader",
        role: "Looks back at earlier turns.",
      });
      const session = await core.getOrCreateStellaSession(counterpart.id);
      assert(core.getAgent(session.id) !== undefined, "the agent must be open");

      // The tool is in the agent's preloaded set, without going through
      // tool_search: a condensed conversation has to know it can look back.
      faux.setResponses([
        fauxAssistantMessage("Noted: the code word is pelican."),
        fauxAssistantMessage([
          fauxToolCall("history_search", { query: "pelican" }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("found it"),
      ]);
      await promptSession(core, session.id, "Remember the code word pelican.");
      await promptSession(core, session.id, "What was the code word?");

      // The result the model received carries the earlier turn, which is the
      // whole point: it came from the rows, not from the visible context.
      const result = core.getAgent(session.id)?.messages.find((message) =>
        message.role === "toolResult" && message.toolName === "history_search"
      );
      assert(result !== undefined, "history_search must have run");
      const text = result.role === "toolResult"
        ? result.content.map((block) => block.type === "text" ? block.text : "")
          .join("")
        : "";
      assert(text.includes("pelican"), text);
      assert(text.includes("Remember the code word"), text);
    } finally {
      await core.close();
    }
  },
);

Deno.test(
  "stella live: the working folder is per agent and the others stay reachable",
  {
    ignore: !(await machineReady()),
  },
  async () => {
    const vm = createVmManager({ containerDir });
    const faux = fauxProvider();
    const core = LumiscaCore.forTesting([faux.provider]);
    try {
      await core.setProviderApiKey(faux.provider.id, "faux-key");
      core.setStellaVm(vm);
      await core.getStellaAvailability();
      const agent = core.createStellaAgent({
        name: "Live Worker",
        role: "Writes files where it is asked to.",
      });
      const session = await core.getOrCreateStellaSession(agent.id);
      const open = core.getAgent(session.id);
      assert(open !== undefined, "the agent must be open");

      // A relative path lands in THIS agent's folder (the working folder),
      // and bash starts there without being told.
      const workdir = vmAgentDir(agent.id);
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("write", {
            path: "relative.txt",
            content: "from the working folder\n",
          }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage([
          fauxToolCall("bash", { command: "pwd" }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await promptSession(core, session.id, "write a relative file");

      const read = await runInMachine(["cat", `${workdir}/relative.txt`]);
      assertEquals(read, "from the working folder\n");

      const bashResult = open.messages.find((message) =>
        message.role === "toolResult" && message.toolName === "bash"
      );
      assert(bashResult !== undefined, "bash must have run");
      const bashText = bashResult.role === "toolResult"
        ? bashResult.content.map((block) =>
          block.type === "text" ? block.text : ""
        ).join("")
        : "";
      assert(bashText.includes(workdir), bashText);

      // The root is the machine's home, not the working folder: an absolute
      // path into another agent's folder is reachable (Terasuma's rule — the
      // folder is a default place, not a wall).
      const other = `/home/agent/agents/live-other`;
      await runInMachine(["mkdir", "-p", other]);
      await runInMachine(["sh", "-c", `printf 'other' > ${other}/f.txt`]);
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("read", { path: `${other}/f.txt` }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("read it"),
      ]);
      await promptSession(core, session.id, "read the other folder");
      const readResult = open.messages.filter((message) =>
        message.role === "toolResult" && message.toolName === "read"
      ).at(-1);
      assert(readResult !== undefined, "read must have run");
      const readText = readResult.role === "toolResult"
        ? readResult.content.map((block) =>
          block.type === "text" ? block.text : ""
        ).join("")
        : "";
      assert(readText.includes("other"), readText);
      assert(!readText.includes("outside the workspace"), readText);
    } finally {
      await runInMachine(["rm", "-rf", "/home/agent/agents/live-other"])
        .catch(() => {});
      await core.close();
    }
  },
);

/** Run a command in the machine for an assertion outside the core. */
async function runInMachine(args: string[]): Promise<string> {
  const result = await new Deno.Command("podman", {
    args: ["exec", "--workdir", VM_WORKDIR, "lumisca-stella", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `podman exec failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}
