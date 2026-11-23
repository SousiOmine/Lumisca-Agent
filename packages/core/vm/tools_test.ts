import { test } from "bun:test";
import { loadImage } from "@napi-rs/canvas";
import { assert, assertEquals, assertRejects } from "@std/assert";
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

test("vm skills: a skill's frontmatter name must match its directory", async () => {
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

test("vm skills: reading a skill goes through the exec seam", async () => {
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

test("vm skills: a follow-up path escaping the skill directory is refused", async () => {
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

test("vm skills: a missing skills directory yields an empty catalog", async () => {
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
  const byteCalls: string[][] = [];
  const screen = createVmScreen({
    exec: scripted.run,
    execBytes: ((
      command: readonly string[],
      _options: VmExecOptions,
    ): Promise<VmCommandBytesResult> => {
      byteCalls.push([...command]);
      return Promise.resolve({
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
      });
    }) satisfies VmExecBytes,
  });
  return {
    tools: createVmTools({ screen }),
    screen,
    calls: scripted.calls,
    byteCalls,
  };
};

test("vm tools: the screenshot reports the 1:1 coordinate contract", async () => {
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

test("vm tools: the stored screenshot keeps its shape and names the screen", async () => {
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

test("vm tools: a shrunk copy states the screen-to-image factor", async () => {
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

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

test("vm tools: a region screenshot names its origin and 1:1 mapping", async () => {
  const { tools, byteCalls } = enclosing({ bytes: "\x89PNG" });
  const screenshot = tools[0];
  assert(screenshot !== undefined);
  const result = await screenshot.execute(
    "1",
    { region: { x: 100, y: 50, width: 80, height: 40 } },
    undefined,
  );
  const text = textOf(result);
  assert(text.includes("screen region 80x40 at (100, 50)"), text);
  assert(text.includes("after adding (100, 50)"), text);
  assertEquals(result.details["region"], {
    x: 100,
    y: 50,
    width: 80,
    height: 40,
  });
  const call = byteCalls[0]?.join(" ") ?? "";
  assert(call.includes("-a 100,50,80,40"), call);
});

test("vm tools: a region outside the screen is refused", async () => {
  const { tools } = enclosing({ bytes: "\x89PNG" });
  const screenshot = tools[0];
  assert(screenshot !== undefined);
  await assertRejects(
    () =>
      screenshot.execute(
        "1",
        { region: { x: 1200, y: 0, width: 200, height: 10 } },
        undefined,
      ),
    Error,
    "outside the screen",
  );
});

test("vm tools: a batch runs in order and returns one observed screenshot", async () => {
  const { tools, calls } = enclosing({ bytes: "\x89PNG" });
  const act = tools[1];
  assert(act !== undefined);
  const result = await act.execute(
    "1",
    {
      actions: [
        { action: "move", x: 10, y: 20 },
        { action: "key", key: "Return" },
        { action: "type", text: "hi there" },
      ],
    },
    undefined,
  );
  const text = textOf(result);
  assert(text.includes("1. moved to (10, 20)."), text);
  assert(text.includes("2. pressed Return."), text);
  assert(text.includes("3. typed 8 character(s)."), text);
  assert(text.includes("The screen is 1280x800 pixels"), text);
  assertEquals(
    result.content.filter((block) => block.type === "image").length,
    1,
  );
  assertEquals(result.details["completed"], 3);
  assertEquals((result.details["actions"] as unknown[]).length, 3);
  const joined = calls.map((call) => call.join(" "));
  assert(
    joined.some((call) => call.includes("mousemove 10 20")),
    joined.join("\n"),
  );
  assert(
    joined.some((call) => call.includes("key --clearmodifiers -- Return")),
    joined.join("\n"),
  );
  assert(
    joined.some((call) => call.includes("type --clearmodifiers")),
    joined.join("\n"),
  );
});

test("vm tools: observe false omits the screenshot", async () => {
  const { tools } = enclosing({ bytes: "\x89PNG" });
  const act = tools[1];
  assert(act !== undefined);
  const result = await act.execute(
    "1",
    { actions: [{ action: "key", key: "Tab" }], observe: false },
    undefined,
  );
  assertEquals(
    result.content.filter((block) => block.type === "image").length,
    0,
  );
  assertEquals(result.details["observe"], false);
  assert(textOf(result).includes("pressed Tab."), textOf(result));
});

test("vm tools: the batch stops at the first failure and still observes", async () => {
  const { tools, calls } = enclosing({ bytes: "\x89PNG" });
  const act = tools[1];
  assert(act !== undefined);
  const result = await act.execute(
    "1",
    {
      actions: [
        { action: "move", x: 10, y: 20 },
        { action: "click", x: VM_SCREEN_WIDTH + 5, y: 10 },
        { action: "type", text: "must not run" },
      ],
    },
    undefined,
  );
  const text = textOf(result);
  assert(text.includes("2. failed:"), text);
  assert(text.includes("outside the screen"), text);
  assert(text.includes("Stopped after 1 of 3 action(s)."), text);
  assertEquals(result.details["failed"], true);
  assertEquals(result.details["completed"], 1);
  assertEquals(
    result.content.filter((block) => block.type === "image").length,
    1,
  );
  assert(
    !calls.some((call) => call.join(" ").includes("must not run")),
    calls.map((call) => call.join(" ")).join("\n"),
  );
});

test("vm tools: the observation keeps the last screenshot's region", async () => {
  const { tools, byteCalls } = enclosing({ bytes: "\x89PNG" });
  const screenshot = tools[0];
  const act = tools[1];
  assert(screenshot !== undefined);
  assert(act !== undefined);
  await screenshot.execute(
    "1",
    { region: { x: 200, y: 100, width: 320, height: 200 } },
    undefined,
  );
  await act.execute(
    "1",
    { actions: [{ action: "key", key: "Return" }] },
    undefined,
  );
  assertEquals(byteCalls.length, 2);
  const second = byteCalls[1]?.join(" ") ?? "";
  assert(second.includes("-a 200,100,320,200"), second);
});

test("vm tools: an empty action array is refused", async () => {
  const { tools } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await assertRejects(
    () => act.execute("1", { actions: [] }, undefined),
    Error,
    "at least one",
  );
});

test("vm tools: too many actions are refused before any input", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  const actions = Array.from({ length: 21 }, () => ({
    action: "move",
    x: 1,
    y: 1,
  }));
  await assertRejects(
    () => act.execute("1", { actions }, undefined),
    Error,
    "too many actions",
  );
  assertEquals(calls.length, 0);
});

test("vm tools: act builds the xdotool call for each action", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);

  await act.execute(
    "1",
    { actions: [{ action: "move", x: 10, y: 20 }], observe: false },
    undefined,
  );
  await act.execute(
    "1",
    { actions: [{ action: "key", key: "Return" }], observe: false },
    undefined,
  );
  await act.execute(
    "1",
    { actions: [{ action: "type", text: "hi there" }], observe: false },
    undefined,
  );

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

test("vm tools: scroll needs an amount", async () => {
  const { tools } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  const result = await act.execute(
    "1",
    { actions: [{ action: "scroll", x: 1, y: 1 }], observe: false },
    undefined,
  );
  assert(textOf(result).includes("vertical or horizontal"), textOf(result));
  assertEquals(result.details["failed"], true);
});

test("vm tools: an unknown action names the valid ones", async () => {
  const { tools } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  const result = await act.execute(
    "1",
    { actions: [{ action: "teleport" }], observe: false },
    undefined,
  );
  assert(textOf(result).includes("move, click, drag"), textOf(result));
  assertEquals(result.details["failed"], true);
});

test("vm tools: click carries the button NUMBER and count", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await act.execute(
    "1",
    {
      actions: [
        { action: "click", x: 5, y: 6, button: "right", count: 2 },
        { action: "click", x: 7, y: 8, button: "left", count: 1 },
      ],
      observe: false,
    },
    undefined,
  );
  const sent = calls.map((call) => call.join(" "));
  assert(
    sent.some((call) => call === "xdotool mousemove 5 6 click --repeat 2 3"),
    sent.join("\n"),
  );
  assert(
    sent.some((call) => call === "xdotool mousemove 7 8 click --repeat 1 1"),
    sent.join("\n"),
  );
});

test("vm tools: drag presses and releases a button NUMBER", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await act.execute(
    "1",
    {
      actions: [
        { action: "drag", x: 10, y: 20, to_x: 30, to_y: 40, button: "middle" },
      ],
      observe: false,
    },
    undefined,
  );
  const sent = calls.map((call) => call.join(" ")).at(-1);
  assert(
    sent ===
      "xdotool mousemove 10 20 mousedown 2 mousemove --sync 30 40 mouseup 2",
    sent,
  );
});

test("vm tools: a positive scroll amount scrolls DOWN", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await act.execute(
    "1",
    {
      actions: [{ action: "scroll", x: 1, y: 1, vertical: 100 }],
      observe: false,
    },
    undefined,
  );
  await act.execute(
    "1",
    {
      actions: [{ action: "scroll", x: 1, y: 1, vertical: -100 }],
      observe: false,
    },
    undefined,
  );

  const joined = calls.map((call) => call.join(" "));
  const down = joined.find((call) => call.includes("click --repeat"));
  assert(down !== undefined, joined.join("\n"));
  assert(down.endsWith(" 5"), "positive vertical sent: " + down);
  const up = joined.filter((call) => call.includes("click --repeat")).at(-1);
  assert(
    up !== undefined && up.endsWith(" 4"),
    "negative vertical sent: " + up,
  );
});

test("vm tools: a positive horizontal amount scrolls RIGHT", async () => {
  const { tools, calls } = enclosing();
  const act = tools[1];
  assert(act !== undefined);
  await act.execute(
    "1",
    {
      actions: [{ action: "scroll", x: 1, y: 1, horizontal: 100 }],
      observe: false,
    },
    undefined,
  );
  await act.execute(
    "1",
    {
      actions: [{ action: "scroll", x: 1, y: 1, horizontal: -100 }],
      observe: false,
    },
    undefined,
  );
  const joined = calls.map((call) => call.join(" "));
  const right = joined.find((call) => call.includes("click --repeat"));
  assert(right !== undefined && right.endsWith(" 7"), "right sent: " + right);
  const left = joined.filter((call) => call.includes("click --repeat")).at(-1);
  assert(left !== undefined && left.endsWith(" 6"), "left sent: " + left);
});

test("vm tools: one scroll amount is one notch, capped at 20", async () => {
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
    {
      actions: [{ action: "scroll", x: 1, y: 1, vertical: 250 }],
      observe: false,
    },
    undefined,
  );
  const joined = calls.map((call) => call.join(" ")).join("\n");
  assert(joined.includes("click --repeat 3 5"), joined);
});
