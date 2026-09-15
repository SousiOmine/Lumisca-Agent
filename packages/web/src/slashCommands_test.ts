import { assertEquals, assertNotEquals } from "@std/assert";
import {
  createTranslator,
  type Locale,
  type SavedPrompt,
} from "@lumisca/core/shared";
import { detectSlash } from "./hooks/useSlashMenu.ts";
import {
  buildSlashCommands,
  modeRewindText,
  skillPromptFromText,
  slashCompletion,
  slashPrompt,
  slashPromptFromText,
} from "./slashCommands.ts";
import type { SkillInfo } from "./types.ts";

/** The menu and the prompt builders take the translator explicitly (the
 * components pass the one from useT), so the tests pin a language each. */
function commandsFor(
  locale: Locale,
  isChat = false,
  skills: readonly SkillInfo[] = [],
  prompts: SavedPrompt[] = [],
) {
  return buildSlashCommands(prompts, isChat, skills, createTranslator(locale));
}

const ja = createTranslator("ja");
const en = createTranslator("en");

const jaCommands = commandsFor("ja");
const planCommand = jaCommands.find((c) => c.id === "plan");
const reviewCommand = jaCommands.find((c) => c.id === "review");
const goalCommand = jaCommands.find((c) => c.id === "goal");

/** A catalog like the server's `/api/skills` returns it. */
const SKILLS: SkillInfo[] = [
  { name: "canvas-design", description: "Posters and static art." },
  { name: "diagnosing-bugs", description: "Diagnosis loop for hard bugs." },
];

Deno.test("slashCommands: plan and goal are text-taking (complete) commands", () => {
  assertEquals(planCommand !== undefined, true);
  assertEquals(planCommand!.kind, "complete");
  assertEquals(planCommand!.items, undefined);
  // Review is a mode palette: it runs only from the start of the input.
  assertEquals(reviewCommand !== undefined, true);
  assertEquals(reviewCommand!.kind, "run");
  assertEquals(goalCommand !== undefined, true);
  assertEquals(goalCommand!.kind, "complete");
});

Deno.test("buildSlashCommands: the menu text follows the app language", () => {
  const jaPlan = commandsFor("ja").find((c) => c.id === "plan");
  const enPlan = commandsFor("en").find((c) => c.id === "plan");
  assertEquals(jaPlan?.label, "プラン");
  assertEquals(enPlan?.label, "Plan");
  assertNotEquals(jaPlan?.description, enPlan?.description);

  // The review target submenu too (its items are catalogue entries).
  const jaTargets = commandsFor("ja").find((c) => c.id === "review")?.items ??
    [];
  const enTargets = commandsFor("en").find((c) => c.id === "review")?.items ??
    [];
  assertEquals(jaTargets.map((i) => i.label), [
    "ベースブランチとの差分",
    "未コミットの変更",
  ]);
  assertEquals(enTargets.map((i) => i.label), [
    "Changes against the base branch",
    "Uncommitted changes",
  ]);
});

Deno.test("slashPrompt: text-taking mode wraps the trailing text", () => {
  const result = slashPrompt(
    planCommand!,
    undefined,
    "  履歴機能を追加して ",
    ja,
  );
  assertEquals(result !== null, true);
  assertEquals(result!.mode.modeId, "plan");
  assertEquals(result!.mode.optionId, "");
  // The badge is UI text: it follows the app language at send time.
  assertEquals(result!.mode.modeLabel, "プラン作成モード");
  assertEquals(result!.mode.shortText, "履歴機能を追加して");
  assertEquals(result!.text.includes("履歴機能を追加して"), true);
  // The prompt itself is English whatever the UI language is.
  assertEquals(result!.text.includes("implementation planner"), true);
});

Deno.test("slashPrompt: the badge and the review short text are localised", () => {
  const result = slashPrompt(reviewCommand!, reviewCommand!.items![1], "", en);
  assertEquals(result !== null, true);
  assertEquals(result!.mode.modeLabel, "Review mode");
  assertEquals(result!.mode.shortText, "Review the uncommitted changes");
});

Deno.test("slashPrompt: text-taking mode without text builds nothing", () => {
  assertEquals(slashPrompt(planCommand!, undefined, "", ja), null);
  assertEquals(slashPrompt(planCommand!, undefined, "", ja), null);
  assertEquals(slashPrompt(planCommand!, undefined, "   ", ja), null);
});

Deno.test("slashPromptFromText: /plan <request> wraps as a text line", () => {
  const line = slashPromptFromText("/plan 履歴機能を追加して", ja);
  if (line === null || line.kind !== "wrap") return;
  assertEquals(line.mode?.modeId, "plan");
  assertEquals(line.mode?.shortText, "履歴機能を追加して");
  assertEquals(line.text.includes("履歴機能を追加して"), true);
});

Deno.test("slashPromptFromText: bare command token needs the request", () => {
  // The token without a request resolves to "needs-text" (nothing sent).
  assertEquals(slashPromptFromText("/plan", ja)?.kind, "needs-text");
  assertEquals(slashPromptFromText("/plan ", ja)?.kind, "needs-text");
  assertEquals(slashPromptFromText("/plan\n", ja)?.kind, "needs-text");
  // Leading whitespace is trimmed like the composer does before wrapping.
  assertEquals(slashPromptFromText("  /plan なにか", ja)?.kind, "wrap");
  assertEquals(slashPromptFromText(" /plan", ja)?.kind, "needs-text");
});

Deno.test("slashPromptFromText: plain text and non-text commands pass through", () => {
  assertEquals(slashPromptFromText("普通のメッセージ", ja), null);
  assertEquals(slashPromptFromText("レビューして", ja), null);
  // review takes no text: the line is not a text-taking command.
  assertEquals(slashPromptFromText("/review 差分を", ja), null);
  // Unknown commands pass through too.
  assertEquals(slashPromptFromText("/nope なにか", ja), null);
});

Deno.test("slashPromptFromText: mid-text /plan wraps and keeps both sides", () => {
  // The command can sit anywhere a word starts; the text the user wrote
  // around it becomes the request (token removed, sides joined by a space).
  const line = slashPromptFromText("背景メモ /plan 履歴を追加して", ja);
  if (line === null || line.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(line.mode?.modeId, "plan");
  assertEquals(line.mode?.shortText, "背景メモ 履歴を追加して");
  assertEquals(line.text.includes("背景メモ 履歴を追加して"), true);

  // The first text-taking command wins; its query is not part of the
  // request.
  const multi = slashPromptFromText("メモ /plan 一つ目 /plan 二つ目", ja);
  if (multi === null || multi.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(multi.mode?.shortText, "メモ 一つ目 /plan 二つ目");

  // A command after the caret-agnostic token: the exact position does not
  // matter, only the word-start boundary.
  const mid = slashPromptFromText(
    "まず /plan を実行して、それから /goal 続行",
    ja,
  );
  if (mid === null || mid.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(mid.mode?.modeId, "plan");
  assertEquals(mid.mode?.shortText, "まず を実行して、それから /goal 続行");
});

Deno.test("slashPromptFromText: mid-text token keeps the other side as request", () => {
  // The request is the text the user wrote around the token — both sides
  // trimmed and joined. A completed token at the end of a memo keeps the
  // memo as the request (メモ /plan → 「メモ」); the menu only ever
  // transforms the input, it never sends.
  const head = slashPromptFromText("メモ /plan", ja);
  if (head === null || head.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(head.mode?.shortText, "メモ");
  const headSpace = slashPromptFromText("メモ /plan ", ja);
  if (headSpace === null || headSpace.kind !== "wrap") {
    throw new Error("expected wrap");
  }
  assertEquals(headSpace.mode?.shortText, "メモ");
  // An empty command at the input start still sends nothing.
  assertEquals(slashPromptFromText("/plan", ja)?.kind, "needs-text");
  assertEquals(slashPromptFromText("/plan ", ja)?.kind, "needs-text");
  // Both sides are joined.
  assertEquals(
    slashPromptFromText("メモ /plan 履歴", ja)?.kind,
    "wrap",
  );
});

Deno.test("slashPromptFromText: word-start boundary (no slash inside words)", () => {
  // A slash glued to a word is not a command (paths, URLs, prose).
  assertEquals(slashPromptFromText("src/plan なにか", ja), null);
  assertEquals(slashPromptFromText("https://example.com/plan", ja), null);
  assertEquals(slashPromptFromText("あれ/plan して", ja), null);
  // After punctuation the slash is literal prose.
  assertEquals(slashPromptFromText("（/plan なにか）", ja), null);
});

Deno.test("modeRewindText: text-taking modes restore as a command line", () => {
  // Plan mode: rewinding restores `/plan <依頼文>`, so a re-send
  // re-enters the mode instead of degrading to a plain message.
  assertEquals(
    modeRewindText("plan", "履歴機能を追加して"),
    "/plan 履歴機能を追加して",
  );
  // Goal mode behaves the same: `/goal <ゴール文>`.
  assertEquals(
    modeRewindText("goal", "全テストが通るまで実装して"),
    "/goal 全テストが通るまで実装して",
  );
  // Menu modes keep their self-contained short text.
  assertEquals(
    modeRewindText("review", "未コミットの変更をレビューしてください"),
    "未コミットの変更をレビューしてください",
  );
  // Unknown mode ids degrade to the short text.
  assertEquals(modeRewindText("nope", "なにか"), "なにか");
});

Deno.test("slashPrompt: goal mode wraps the trailing text", () => {
  const result = slashPrompt(
    goalCommand!,
    undefined,
    "  全テストが通るまで実装して ",
    ja,
  );
  assertEquals(result !== null, true);
  assertEquals(result!.mode.modeId, "goal");
  assertEquals(result!.mode.optionId, "");
  assertEquals(result!.mode.modeLabel, "ゴールモード");
  assertEquals(result!.mode.shortText, "全テストが通るまで実装して");
  assertEquals(result!.text.includes("全テストが通るまで実装して"), true);
  assertEquals(result!.text.includes("goal-achieving agent"), true);
});

Deno.test("slashPromptFromText: /goal <goal> wraps as a text line", () => {
  const line = slashPromptFromText("/goal 全テストが通るまで実装して", ja);
  if (line === null || line.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(line.mode?.modeId, "goal");
  assertEquals(line.mode?.shortText, "全テストが通るまで実装して");
  assertEquals(line.text.includes("全テストが通るまで実装して"), true);
});

// --- detectSlash: where the menu opens --------------------------------

Deno.test("detectSlash: captures the token under the caret", () => {
  // Caret at the end of `/`: query empty, token covers [0, 1).
  assertEquals(detectSlash("/", 1, false), {
    start: 0,
    end: 1,
    query: "",
    rest: "",
  });
  // Caret inside the name.
  assertEquals(detectSlash("/plan", 4, false), {
    start: 0,
    end: 5,
    query: "pla",
    rest: "",
  });
  // Caret right after the full name.
  assertEquals(detectSlash("/plan", 5, false), {
    start: 0,
    end: 5,
    query: "plan",
    rest: "",
  });
});

Deno.test("detectSlash: word-start only (no slash inside words)", () => {
  assertEquals(detectSlash("src/plan", 8, false), null);
  assertEquals(detectSlash("あれ/plan", 8, false), null);
  assertEquals(detectSlash("https://example.com/plan", 24, false), null);
  // Whitespace before the slash is fine (space, newline, full-width
  // space); punctuation is not.
  assertEquals(detectSlash("メモ /plan", 8, false)?.start, 3);
  assertEquals(detectSlash("一行目\n/plan", 9, false)?.start, 4);
  assertEquals(detectSlash("メモ\u3000/plan", 8, false)?.start, 3);
  assertEquals(detectSlash("メモ、/plan", 8, false), null);
  assertEquals(detectSlash("（/plan", 6, false), null);
});

Deno.test("detectSlash: caret must stay in the token (closes after space)", () => {
  // Space after the command → no menu (typing prose after a completed
  // command keeps it prose).
  assertEquals(detectSlash("/plan ", 6, false), null);
  assertEquals(detectSlash("/plan なにか", 6, false), null);
  // ...unless a submenu is open: the text between the token and the caret
  // is that submenu's filter.
  assertEquals(detectSlash("/plan なにか", 9, true)?.rest, " なにか");
});

Deno.test("detectSlash: the nearest token behind the caret wins", () => {
  assertEquals(detectSlash("メモ /plan あと /re", 18, false)?.query, "re");
  assertEquals(detectSlash("メモ /plan あと /re", 18, false)?.start, 12);
});

Deno.test("buildSlashCommands: /compact is offered as an action command", () => {
  const compactCommand = commandsFor("ja").find((c) => c.id === "compact");
  assertEquals(compactCommand !== undefined, true);
  assertEquals(compactCommand!.kind, "action");
  assertEquals(compactCommand!.items, undefined);
  assertEquals(compactCommand!.label, "履歴を圧縮");
  // Its text follows the app language like every other menu entry.
  assertEquals(
    commandsFor("en").find((c) => c.id === "compact")?.label,
    "Compact history",
  );

  // Chat sessions (no workspace) get it too: condensing history needs no
  // workspace, unlike the agent modes.
  const chat = commandsFor("ja", true);
  assertEquals(chat.map((c) => c.id), ["compact"]);
  assertEquals(chat[0]!.kind, "action");

  // Workspace sessions keep the agent modes and add the action command.
  const workspace = commandsFor("ja", false);
  assertEquals(workspace.some((c) => c.id === "compact"), true);
  assertEquals(workspace.some((c) => c.id === "plan"), true);

  // Saved prompts stay a separate submenu, after the action commands.
  const withPrompts = commandsFor("ja", true, [], [
    { id: "p1", label: "P", prompt: "text" },
  ]);
  assertEquals(withPrompts.map((c) => c.id), ["compact", "prompt"]);
  assertEquals(withPrompts[1]!.kind, "insert");
  assertEquals(withPrompts[1]!.label, "保存済みプロンプト");
});

// --- skill palette ------------------------------------------------------

Deno.test("buildSlashCommands: /skill lists the session catalog", () => {
  // Without a catalog the entry is hidden: a submenu that can never load a
  // skill would be a dead end.
  assertEquals(
    commandsFor("ja", false, []).some((c) => c.id === "skill"),
    false,
  );

  const workspace = commandsFor("ja", false, SKILLS);
  const skill = workspace.find((c) => c.id === "skill");
  assertEquals(skill !== undefined, true);
  // The command completes the input in place like the text-taking modes,
  // and its items are the catalog entries.
  assertEquals(skill!.kind, "complete");
  assertEquals(skill!.label, "スキル");
  const items = skill!.items ?? [];
  assertEquals(items.map((i) => i.id), [
    "canvas-design",
    "diagnosing-bugs",
  ]);
  assertEquals(items[0]?.label, "canvas-design");
  assertEquals(items[0]?.description, "Posters and static art.");
  // Skills sit right after the agent modes, before the action commands
  // (the no-skill workspace list is the modes + the action command).
  assertEquals(workspace.map((c) => c.id), [
    ...jaCommands.filter((c) => c.id !== "compact").map((c) => c.id),
    "skill",
    "compact",
  ]);

  // Chat sessions offer skills too (global and built-in ones), unlike the
  // agent modes.
  const chat = commandsFor("ja", true, SKILLS);
  assertEquals(chat.map((c) => c.id), ["skill", "compact"]);
});

Deno.test("skillMenu: long descriptions are capped for the menu", () => {
  const [command] = commandsFor("ja", true, [{
    name: "long",
    description: "x".repeat(500),
  }]);
  const description = (command?.items ?? [])[0]?.description ?? "";
  assertEquals(description.length, 81);
  assertEquals(description.endsWith("…"), true);
});

Deno.test("slashCompletion: a picked item becomes the command's argument", () => {
  const [skill] = commandsFor("ja", true, SKILLS);
  // The command itself completes with no argument (as before).
  assertEquals(slashCompletion(skill!), "/skill ");
  // An item of the submenu completes to `/skill <name> ` — the form
  // skillPromptFromText parses back out.
  assertEquals(
    slashCompletion(skill!, (skill?.items ?? [])[0]),
    "/skill canvas-design ",
  );
});

Deno.test("skillPromptFromText: /skill <name> invokes the skill (English prompt)", () => {
  const line = skillPromptFromText("/skill canvas-design", SKILLS);
  if (line === null || line.kind !== "wrap") throw new Error("expected wrap");
  // No mode metadata: the transcript shows a plain user message.
  assertEquals(line.mode, undefined);
  assertEquals(line.text.includes('Invoke the skill "canvas-design"'), true);
  assertEquals(
    line.text.includes("load it with the skill tool"),
    true,
  );
  // No request → no subject section.
  assertEquals(line.text.includes("# Request"), false);
});

Deno.test("skillPromptFromText: the request travels with the skill", () => {
  const line = skillPromptFromText(
    "/skill canvas-design ポスターを作って",
    SKILLS,
  );
  if (line === null || line.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(line.text.endsWith("# Request\nポスターを作って"), true);

  // The text around the command is the request too (like the modes): a
  // memo before the token is not dropped.
  const before = skillPromptFromText(
    "A4で /skill canvas-design",
    SKILLS,
  );
  if (before === null || before.kind !== "wrap") {
    throw new Error("expected wrap");
  }
  assertEquals(before.text.endsWith("# Request\nA4で"), true);

  // Both sides are joined by a single space.
  const both = skillPromptFromText("A4で /skill canvas-design 片面で", SKILLS);
  if (both === null || both.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(both.text.endsWith("# Request\nA4で 片面で"), true);
});

Deno.test("skillPromptFromText: incomplete and unknown names send as written", () => {
  // `/skill` without a name: nothing is sent (like a text-taking mode
  // without its request).
  assertEquals(skillPromptFromText("/skill", SKILLS)?.kind, "needs-text");
  assertEquals(skillPromptFromText("/skill ", SKILLS)?.kind, "needs-text");
  assertEquals(skillPromptFromText("メモ /skill", SKILLS)?.kind, "needs-text");
  // A name outside the catalog is hand-typed: the text passes through
  // unchanged (the same contract as an unknown mode token), as does a
  // missing catalog or a different command.
  assertEquals(skillPromptFromText("/skill nope なにか", SKILLS), null);
  assertEquals(skillPromptFromText("/skill canvas-design, して", SKILLS), null);
  assertEquals(skillPromptFromText("/skill canvas-design", []), null);
  assertEquals(skillPromptFromText("/plan なにか", SKILLS), null);
  assertEquals(skillPromptFromText("普通のメッセージ", SKILLS), null);
  // The word-start rule holds: a path is not a command.
  assertEquals(skillPromptFromText("src/skill canvas-design", SKILLS), null);
});

Deno.test("skillPromptFromText: the palette's completion round-trips", () => {
  // What the composer leaves in the input after picking a skill (see
  // slashCompletion) is exactly what the submit path parses.
  const [skill] = commandsFor("ja", true, SKILLS);
  const typed = slashCompletion(skill!, (skill?.items ?? [])[0]) +
    "ポスターを作って";
  assertEquals(typed, "/skill canvas-design ポスターを作って");
  const line = skillPromptFromText(typed, SKILLS);
  if (line === null || line.kind !== "wrap") throw new Error("expected wrap");
  assertEquals(line.text.includes('Invoke the skill "canvas-design"'), true);
  assertEquals(line.text.endsWith("# Request\nポスターを作って"), true);
});
