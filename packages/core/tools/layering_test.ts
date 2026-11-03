/**
 * The tools layer does not build agents.
 *
 * `tools/` defines what a tool IS; `ai/` runs the model loop and `agent/`
 * assembles the things that hold it. The sub-agent hub needs an agent per
 * sub-agent, and for a while it built one itself (`new Agent({...})` inside
 * tools/task-hub.ts) — a second construction site beside agent/factory.ts,
 * in a layer that has no business owning one. The seam is
 * agent/subagent-runner.ts.
 *
 * Type-only references are fine (the hub holds `Subagent.agent`): what this
 * check forbids is a tools module importing a VALUE out of the ai runtime, or
 * naming `Agent` as a constructor.
 */
import { assert, assertEquals } from "@std/assert";

const TOOLS_DIR = new URL("./", import.meta.url);

interface Offender {
  file: string;
  line: number;
  text: string;
}

/** Every non-test module under tools/, read as text. */
async function toolsSources(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: URL, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const url = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, dir);
      if (entry.isDirectory) {
        await walk(url, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.includes("_test.")) {
        continue;
      }
      out.set(`${prefix}${entry.name}`, await Deno.readTextFile(url));
    }
  };
  await walk(TOOLS_DIR, "");
  return out;
}

Deno.test("no tools module imports a value from the ai runtime", async () => {
  const sources = await toolsSources();
  assert(sources.size > 20, `only ${sources.size} tools modules were read`);
  const offenders: Offender[] = [];
  for (const [file, text] of sources) {
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      // A value import of the agent runtime or its loop.
      if (
        /^import\s+(?!type\b)[^;]*from\s+"\.\.\/ai\/(agent|context-compaction)\.ts";/
          .test(line)
      ) {
        offenders.push({ file, line: index + 1, text: line.trim() });
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "tools/ must reach the agent layer through a seam, not import its runtime:\n" +
      offenders.map((o) => `  tools/${o.file}:${o.line}: ${o.text}`).join("\n"),
  );
});

Deno.test("no tools module constructs an Agent", async () => {
  const sources = await toolsSources();
  const offenders: Offender[] = [];
  for (const [file, text] of sources) {
    for (const [index, line] of text.split("\n").entries()) {
      if (/\bnew\s+Agent\s*\(/.test(line)) {
        offenders.push({ file, line: index + 1, text: line.trim() });
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "an agent is built by agent/ (see subagent-runner.ts):\n" +
      offenders.map((o) => `  tools/${o.file}:${o.line}: ${o.text}`).join("\n"),
  );
});
