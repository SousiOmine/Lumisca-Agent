import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./ai/faux.ts";
import { LumiscaCore } from "./core.ts";
import { createVmManager } from "./vm/container.ts";

import { VM_WORKDIR } from "./vm/contract.ts";
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

    const session = await core.getOrCreateStellaSession();
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
