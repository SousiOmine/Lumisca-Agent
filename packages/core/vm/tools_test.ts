import { assert, assertEquals } from "@std/assert";
import { scanVmSkillsDir } from "./skills.ts";
import { createVmTools } from "./tools.ts";
import { createVmScreen } from "./screen.ts";
import {
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_SKILLS_DIR,
} from "./contract.ts";
import type { VmExec, VmExecBytes, VmExecOptions } from "./container.ts";
import type { VmCommandBytesResult, VmCommandResult } from "./command.ts";

/** A scripted exec seam: each answer is matched against the joined argv. */
function exec(
  answers: Array<{
    match: RegExp;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>,
): { run: VmExec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (command) => {
      const argv = [...command];
      calls.push(argv);
      const joined = argv.join(" ");
      const answer = answers.find((entry) => entry.match.test(joined));
      return Promise.resolve<VmCommandResult>({
        exitCode: answer?.exitCode ?? 0,
        stdout: answer?.stdout ?? "",
        stderr: answer?.stderr ?? "",
        truncated: false,
        timedOut: false,
      });
    },
  };
}

// --- skills ----------------------------------------------------------------

Deno.test("vm skills: a skill's frontmatter name must match its directory", async () => {
  const { run } = exec([{
    match: /^sh -c cd/,
    stdout: [
      "",
      "__SKILL__alpha",
      "---",
      "name: alpha",
      "description: The alpha skill.",
      "---",
      "",
      "# Alpha",
      "",
      "__SKILL__beta",
      "---",
      "name: not-beta",
      "description: A mismatched name.",
      "---",
    ].join("\n"),
  }]);
  const skills = await scanVmSkillsDir(run, VM_SKILLS_DIR);
  assertEquals(skills.map((skill) => skill.name), ["alpha"]);
  const alpha = skills[0]!;
  assertEquals(alpha.description, "The alpha skill.");
  assertEquals(alpha.path, `${VM_SKILLS_DIR}/alpha/SKILL.md`);
  assertEquals(alpha.dir, `${VM_SKILLS_DIR}/alpha`);
});

Deno.test("vm skills: reading a skill goes through the exec seam", async () => {
  const { run, calls } = exec([
    {
      match: /^sh -c cd/,
      stdout: "\n__SKILL__alpha\n---\nname: alpha\ndescription: d\n---\nbody\n",
    },
    { match: /^sh -c cat/, stdout: "follow-up content" },
  ]);
  const [skill] = await scanVmSkillsDir(run, VM_SKILLS_DIR);
  assert(skill !== undefined);
  const text = await skill.read?.("reference.md");
  assertEquals(text, "follow-up content");
  const readCall = calls.find((call) => call.join(" ").includes("cat --"));
  assert(readCall !== undefined);
  assert(
    readCall.join(" ").includes(`${VM_SKILLS_DIR}/alpha/reference.md`),
    readCall.join(" "),
  );
});

Deno.test("vm skills: a follow-up path escaping the skill directory is refused", async () => {
  const { run } = exec([
    {
      match: /^sh -c cd/,
      stdout: "\n__SKILL__alpha\n---\nname: alpha\ndescription: d\n---\n",
    },
  ]);
  const [skill] = await scanVmSkillsDir(run, VM_SKILLS_DIR);
  assert(skill !== undefined);
  let message = "";
  try {
    await skill.read?.("../../secret");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("escapes"), message);
});

Deno.test("vm skills: a missing skills directory yields an empty catalog", async () => {
  const { run } = exec([{ match: /^sh -c cd/, exitCode: 0, stdout: "" }]);
  assertEquals(await scanVmSkillsDir(run, VM_SKILLS_DIR), []);
});

// --- screen tools ----------------------------------------------------------

const enclosing = (overrides: {
  exec?: ReturnType<typeof exec>;
  bytes?: string;
} = {}) => {
  const scripted = overrides.exec ?? exec([]);
  const screen = createVmScreen({
    exec: scripted.run,
    execBytes: ((
      _command: readonly string[],
      _options: VmExecOptions,
    ): Promise<VmCommandBytesResult> =>
      Promise.resolve({
        exitCode: 0,
        stdout: new TextEncoder().encode(overrides.bytes ?? "png"),
        stderr: "",
        truncated: false,
        timedOut: false,
      })) satisfies VmExecBytes,
  });
  return { tools: createVmTools({ screen }), screen, calls: scripted.calls };
};

Deno.test("vm tools: the screenshot reports the 1:1 coordinate contract", async () => {
  const { tools } = enclosing({ bytes: "\x89PNG" });
  const [screenshot] = tools;
  assert(screenshot !== undefined);
  assertEquals(screenshot.name, "vm_screenshot");
  const result = await screenshot.execute("1", {}, undefined);
  assertEquals(result.content.some((item) => item.type === "image"), true);
  const text = result.content[0];
  assert(text?.type === "text");
  assert(
    text.text.includes(`${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}`),
    text.text,
  );
});

Deno.test("vm tools: a position outside the screen fails instead of clamping", async () => {
  const { tools } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  let message = "";
  try {
    await act.execute(
      "1",
      { action: "click", x: VM_SCREEN_WIDTH + 5, y: 10 },
      undefined,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("outside the screen"), message);
});

Deno.test("vm tools: act builds the xdotool call for each action", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);

  await act.execute("1", { action: "move", x: 10, y: 20 }, undefined);
  await act.execute("1", { action: "key", key: "Return" }, undefined);
  await act.execute("1", { action: "type", text: "hi there" }, undefined);

  const joined = calls.map((call) => call.join(" "));
  assert(joined.some((c) => c.includes("mousemove 10 20")), joined.join("\n"));
  assert(
    joined.some((c) => c.includes("key --clearmodifiers -- Return")),
    joined.join("\n"),
  );
  assert(
    joined.some((c) => c.includes("type --clearmodifiers")),
    joined.join("\n"),
  );
});

Deno.test("vm tools: scroll needs an amount", async () => {
  const { tools } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  let message = "";
  try {
    await act.execute("1", { action: "scroll", x: 1, y: 1 }, undefined);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("vertical or horizontal"), message);
});

Deno.test("vm tools: an unknown action names the valid ones", async () => {
  const { tools } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  let message = "";
  try {
    await act.execute("1", { action: "teleport" }, undefined);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("move, click, drag"), message);
});

Deno.test("vm tools: click carries the button and count", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await act.execute(
    "1",
    { action: "click", x: 5, y: 6, button: "right", count: 2 },
    undefined,
  );
  const joined = calls.map((call) => call.join(" ")).join("\n");
  assert(joined.includes("click --repeat 2 right"), joined);
});
