import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./ai/faux.ts";
import { LumiscaCore } from "./core.ts";
import type { AgentMessage } from "./domain/message.ts";
import { runProcess } from "./process.ts";
import { promptSession } from "./test-utils.ts";
import { createVmHost } from "./vm/container.ts";
import { VM_WORKDIR, vmAgentDir, vmContainerName } from "./vm/contract.ts";

/**
 * The stella conversation, end to end inside a real container.
 *
 * Unlike the other stella tests (which script the machine), this one builds
 * nothing: it runs only where the image already exists and podman answers, and
 * it SKIPS otherwise. When it does run, it is the check that cannot be faked —
 * a tool call from the model really does execute inside the machine, and the
 * file it writes is really there afterwards.
 *
 * It drives the SAME machines the application uses (one container per agent),
 * so it runs only when asked for by name: an ordinary `bun run test` used to
 * find the container running whenever the user had stella open — which is
 * exactly when it ran, and then stopped the user's machine when it finished.
 * The environment variable is the consent; without it not even a status query
 * touches podman. Every test makes its own agent, so its container is its own
 * and the user's conversations are never touched.
 *
 * Run explicitly:
 *   LUMISCA_STELLA_LIVE=1 bun test packages/core/stella_live_test.ts
 */

const containerDir = fileURLToPath(new URL("./vm/container/", import.meta.url));

const live = process.env["LUMISCA_STELLA_LIVE"] === "1";

/** Whether this host can run a machine at all (podman plus an image built from
 * the files on disk). Read without side effects: no container is created. */
async function machineReady(): Promise<boolean> {
  if (!live) return false;
  const host = createVmHost({ containerDir });
  const status = await host.status({ fresh: true });
  return status.state === "ready";
}

/** Close the test's core without ending the machines.
 *
 * `LumiscaCore.close()` stops the machines it was given, and the machines
 * here are the test's — a test that drives them must leave the user's own
 * alone. Detaching first makes `stopAll()` a no-op. */
async function closeTestCore(core: LumiscaCore): Promise<void> {
  core.setStellaVm(undefined);
  await core.close();
}

test.skipIf(!(await machineReady()))(
  "stella live: a tool call runs inside the machine",
  async () => {
    const host = createVmHost({ containerDir });
    const faux = fauxProvider();
    const core = LumiscaCore.forTesting([faux.provider]);
    try {
      await core.setProviderApiKey(faux.provider.id, "faux-key");
      core.setStellaVm(host);
      await core.getStellaAvailability();

      // A fresh core has no counterpart yet: stella has no default agent
      // (the first run asks the user to name one), so the test makes its own.
      const counterpart = await core.createStellaAgent({
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
      await fsp.rm(target).catch(() => {});

      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("write", {
              path: target,
              content: "written from inside the machine\n",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      // `agent.prompt` resolves once the run settles (tool calls included), so
      // the assertions below see the transcript the run produced.
      await promptSession(core, session.id, "write the file");

      const exists = await runInMachine(counterpart.id, ["cat", target]);
      assertEquals(exists, "written from inside the machine\n");

      // Nowhere on this host did it appear.
      let onHost = true;
      try {
        await fsp.stat(target);
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
      const results = messages.filter(
        (message) => message.role === "toolResult",
      );
      assertEquals(results.length > 0, true);
    } finally {
      await closeTestCore(core);
    }
  },
);

test.skipIf(!(await machineReady()))(
  "stella live: history_search reads a turn back from the machine's conversation",
  async () => {
    const host = createVmHost({ containerDir });
    const faux = fauxProvider();
    const core = LumiscaCore.forTesting([faux.provider]);
    try {
      await core.setProviderApiKey(faux.provider.id, "faux-key");
      core.setStellaVm(host);
      await core.getStellaAvailability();

      const counterpart = await core.createStellaAgent({
        name: "History Reader",
        role: "Looks back at earlier turns.",
      });
      const session = await core.getOrCreateStellaSession(counterpart.id);
      assert(core.getAgent(session.id) !== undefined, "the agent must be open");

      // The tool is in the agent's preloaded set, without going through
      // tool_search: a condensed conversation has to know it can look back.
      faux.setResponses([
        fauxAssistantMessage("Noted: the code word is pelican."),
        fauxAssistantMessage(
          [fauxToolCall("history_search", { query: "pelican" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("found it"),
      ]);
      await promptSession(core, session.id, "Remember the code word pelican.");
      await promptSession(core, session.id, "What was the code word?");

      // The result the model received carries the earlier turn, which is the
      // whole point: it came from the rows, not from the visible context.
      const result = core
        .getAgent(session.id)
        ?.messages.find(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "history_search",
        );
      assert(result !== undefined, "history_search must have run");
      const text =
        result.role === "toolResult"
          ? result.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("")
          : "";
      assert(text.includes("pelican"), text);
      assert(text.includes("Remember the code word"), text);
    } finally {
      await closeTestCore(core);
    }
  },
);

test.skipIf(!(await machineReady()))(
  "stella live: the working folder is per agent and the others stay reachable",
  async () => {
    const host = createVmHost({ containerDir });
    const faux = fauxProvider();
    const core = LumiscaCore.forTesting([faux.provider]);
    let created: string | undefined;
    try {
      await core.setProviderApiKey(faux.provider.id, "faux-key");
      core.setStellaVm(host);
      await core.getStellaAvailability();
      const agent = await core.createStellaAgent({
        name: "Live Worker",
        role: "Writes files where it is asked to.",
      });
      created = agent.id;
      const session = await core.getOrCreateStellaSession(agent.id);
      const open = core.getAgent(session.id);
      assert(open !== undefined, "the agent must be open");

      // A relative path lands in THIS agent's folder (the working folder),
      // and bash starts there without being told.
      const workdir = vmAgentDir(agent.id);
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("write", {
              path: "relative.txt",
              content: "from the working folder\n",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await promptSession(core, session.id, "write a relative file");

      const read = await runInMachine(agent.id, [
        "cat",
        `${workdir}/relative.txt`,
      ]);
      assertEquals(read, "from the working folder\n");

      const bashResult = open.messages.find(
        (message) =>
          message.role === "toolResult" && message.toolName === "bash",
      );
      assert(bashResult !== undefined, "bash must have run");
      const bashText =
        bashResult.role === "toolResult"
          ? bashResult.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("")
          : "";
      assert(bashText.includes(workdir), bashText);

      // The root is the machine's home, not the working folder: an absolute
      // path into another agent's folder is reachable inside this machine
      // (Terasuma's rule — the folder is a default place, not a wall). The
      // machines share the home volume, so that folder is the same one the
      // other agent sees.
      const other = `/home/agent/agents/live-other`;
      await runInMachine(agent.id, ["mkdir", "-p", other]);
      await runInMachine(agent.id, [
        "sh",
        "-c",
        `printf 'other' > ${other}/f.txt`,
      ]);
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("read", { path: `${other}/f.txt` })],
          {
            stopReason: "toolUse",
          },
        ),
        fauxAssistantMessage("read it"),
      ]);
      await promptSession(core, session.id, "read the other folder");
      const readResult = open.messages
        .filter(
          (message) =>
            message.role === "toolResult" && message.toolName === "read",
        )
        .at(-1);
      assert(readResult !== undefined, "read must have run");
      const readText =
        readResult.role === "toolResult"
          ? readResult.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("")
          : "";
      assert(readText.includes("other"), readText);
      assert(!readText.includes("outside the workspace"), readText);
    } finally {
      if (created !== undefined) {
        await runInMachine(created, [
          "rm",
          "-rf",
          "/home/agent/agents/live-other",
        ]).catch(() => {});
      }
      await closeTestCore(core);
    }
  },
);

test.skipIf(!(await machineReady()))(
  "stella live: MEMORY.md is prepared when the conversation opens and survives reopening",
  async () => {
    const host = createVmHost({ containerDir });
    const faux = fauxProvider();
    const core = LumiscaCore.forTesting([faux.provider]);
    try {
      await core.setProviderApiKey(faux.provider.id, "faux-key");
      core.setStellaVm(host);
      await core.getStellaAvailability();
      const agent = await core.createStellaAgent({
        name: "Live Memory",
        role: "Keeps notes for later runs.",
      });
      // Opening the conversation wakes the machine (nothing else has), and
      // the open prepares the folder and MEMORY.md with it.
      const session = await core.getOrCreateStellaSession(agent.id);
      const path = `${vmAgentDir(agent.id)}/MEMORY.md`;
      assertEquals(await runInMachine(agent.id, ["cat", path]), "");

      // The agent writes to it the way it is told to: the file tools.
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("write", {
              path: "MEMORY.md",
              content: "- the user writes in Japanese\n",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("noted"),
      ]);
      await promptSession(core, session.id, "remember that");
      assertEquals(
        await runInMachine(agent.id, ["cat", path]),
        "- the user writes in Japanese\n",
      );

      // Reopening the conversation prepares the folder again — this is the
      // regression that would cost the notes: `: >` without the guard.
      core.closeSession(session.id);
      await core.getOrCreateStellaSession(agent.id);
      assertEquals(
        await runInMachine(agent.id, ["cat", path]),
        "- the user writes in Japanese\n",
      );
    } finally {
      await closeTestCore(core);
    }
  },
);

/** Run a command in one agent's machine for an assertion outside the core. */
async function runInMachine(
  agentId: string,
  args: readonly string[],
): Promise<string> {
  const result = await runProcess([
    "podman",
    "exec",
    "--workdir",
    VM_WORKDIR,
    vmContainerName(agentId),
    ...args,
  ]);
  if (!result.success) {
    throw new Error(
      `podman exec failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}
