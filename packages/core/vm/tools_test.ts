import { loadImage } from "@napi-rs/canvas";
import { assert, assertEquals } from "@std/assert";
import { base64ToBytes } from "../base64.ts";
import { noisyPng } from "../test-utils.ts";
import type { VmCommandBytesResult, VmCommandResult } from "./command.ts";
import type { VmExec, VmExecBytes, VmExecOptions } from "./container.ts";
import {
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_SKILLS_DIR,
} from "./contract.ts";
import { createVmScreen, scrollNotches } from "./screen.ts";
import { scanVmSkillsDir } from "./skills.ts";
import { createVmTools } from "./tools.ts";

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
  const { run } = exec([
    {
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
    },
  ]);
  const skills = await scanVmSkillsDir(run, VM_SKILLS_DIR);
  assertEquals(
    skills.map((skill) => skill.name),
    ["alpha"],
  );
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

const enclosing = (
  overrides: {
    exec?: ReturnType<typeof exec>;
    bytes?: string | Uint8Array;
  } = {},
) => {
  const scripted = overrides.exec ?? exec([]);
  const screen = createVmScreen({
    exec: scripted.run,
    execBytes: ((
      _command: readonly string[],
      _options: VmExecOptions,
    ): Promise<VmCommandBytesResult> =>
      Promise.resolve({
        exitCode: 0,
        stdout:
          overrides.bytes === undefined
            ? new TextEncoder().encode("png")
            : typeof overrides.bytes === "string"
              ? new TextEncoder().encode(overrides.bytes)
              : overrides.bytes,
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
  assertEquals(
    result.content.some((item) => item.type === "image"),
    true,
  );
  const text = result.content[0];
  assert(text?.type === "text");
  assert(
    text.text.includes(`${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT}`),
    text.text,
  );
});

Deno.test("vm tools: the stored screenshot keeps its shape and names the screen", async () => {
  const png = await noisyPng(VM_SCREEN_WIDTH, VM_SCREEN_HEIGHT);
  const { tools } = enclosing({ bytes: png });
  const screenshot = tools[0];
  assert(screenshot !== undefined);
  const result = await screenshot.execute("1", {}, undefined);
  const images = result.content.filter((item) => item.type === "image");
  assertEquals(images.length, 1);
  const stored = await loadImage(base64ToBytes(images[0]!.data));
  // Bounded copy, same shape: a position read off it stays convertible with
  // one factor.
  assert(stored.width <= VM_SCREEN_WIDTH);
  assert(
    Math.abs(
      stored.width / stored.height - VM_SCREEN_WIDTH / VM_SCREEN_HEIGHT,
    ) < 0.01,
    `aspect ratio: ${stored.width}x${stored.height}`,
  );
  const text = result.content[0];
  assert(text?.type === "text");
  assert(
    text.text.includes(
      `The screen is ${VM_SCREEN_WIDTH}x${VM_SCREEN_HEIGHT} pixels`,
    ),
    text.text,
  );
  // The two sizes are named apart: the screen is always the contract size.
  assertEquals(result.details["screen"], {
    width: VM_SCREEN_WIDTH,
    height: VM_SCREEN_HEIGHT,
  });
  assertEquals(result.details["image"], {
    width: stored.width,
    height: stored.height,
  });
});

Deno.test("vm tools: a shrunk copy states the screen-to-image factor", async () => {
  // The store shrinks a capture over its byte budget. The VM screen is
  // 1280x800 today, so this hands the tool a bigger frame to exercise the
  // branch that has to explain the ratio.
  const png = await noisyPng(2000, 1250);
  const { tools } = enclosing({ bytes: png });
  const screenshot = tools[0]!;
  const result = await screenshot.execute("1", {}, undefined);
  const images = result.content.filter((item) => item.type === "image");
  const stored = await loadImage(base64ToBytes(images[0]!.data));
  assert(stored.width < 2000, `the copy must shrink: ${stored.width}`);
  assert(
    Math.abs(stored.width / stored.height - 2000 / 1250) < 0.01,
    `aspect ratio: ${stored.width}x${stored.height}`,
  );
  const text = result.content[0];
  assert(text?.type === "text");
  const factor = VM_SCREEN_WIDTH / stored.width;
  assert(
    text.text.includes(`by ${factor.toFixed(3)}`),
    `factor ${factor.toFixed(3)} missing: ${text.text}`,
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
  assert(
    joined.some((c) => c.includes("mousemove 10 20")),
    joined.join("\n"),
  );
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

Deno.test("vm tools: a positive scroll amount scrolls DOWN", async () => {
  // X11's wheel buttons name the direction the wheel rolls: 4 is up, 5 is
  // down. The tool's schema says "positive scrolls down", so a positive
  // amount must send button 5 — the opposite of the number, which is exactly
  // the mistake this test exists to catch.
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await act.execute(
    "1",
    { action: "scroll", x: 1, y: 1, vertical: 100 },
    undefined,
  );
  await act.execute(
    "1",
    { action: "scroll", x: 1, y: 1, vertical: -100 },
    undefined,
  );

  const joined = calls.map((call) => call.join(" "));
  const down = joined.find((call) => call.includes("click --repeat"));
  assert(down !== undefined, joined.join("\n"));
  assert(down.endsWith(" 5"), `positive vertical sent: ${down}`);
  const up = joined.filter((call) => call.includes("click --repeat")).at(-1);
  assert(
    up !== undefined && up.endsWith(" 4"),
    `negative vertical sent: ${up}`,
  );
});

Deno.test("vm tools: a positive horizontal amount scrolls RIGHT", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await act.execute(
    "1",
    { action: "scroll", x: 1, y: 1, horizontal: 100 },
    undefined,
  );
  await act.execute(
    "1",
    { action: "scroll", x: 1, y: 1, horizontal: -100 },
    undefined,
  );
  const joined = calls.map((call) => call.join(" "));
  const right = joined.find((call) => call.includes("click --repeat"));
  assert(right !== undefined && right.endsWith(" 7"), `right sent: ${right}`);
  const left = joined.filter((call) => call.includes("click --repeat")).at(-1);
  assert(left !== undefined && left.endsWith(" 6"), `left sent: ${left}`);
});

Deno.test("vm tools: one scroll amount is one notch, capped at 20", async () => {
  // The unit is documented (VM_SCROLL_NOTCH per notch) and the cap keeps a
  // stray large amount from spinning a list for minutes.
  assertEquals(scrollNotches({ vertical: 100, horizontal: 0 }), 1);
  assertEquals(scrollNotches({ vertical: 250, horizontal: 0 }), 3);
  assertEquals(scrollNotches({ vertical: -100, horizontal: 0 }), 1);
  assertEquals(scrollNotches({ vertical: 100_000, horizontal: 0 }), 20);
  assertEquals(scrollNotches({ vertical: 0, horizontal: 0 }), 1);

  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await act.execute(
    "1",
    { action: "scroll", x: 1, y: 1, vertical: 250 },
    undefined,
  );
  const joined = calls.map((call) => call.join(" ")).join("\n");
  assert(joined.includes("click --repeat 3 5"), joined);
});
