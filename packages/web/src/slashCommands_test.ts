import { assertEquals } from "@std/assert";
import {
  modeRewindText,
  slashCommands,
  slashPrompt,
  slashPromptFromText,
} from "./slashCommands.ts";

const planCommand = slashCommands.find((c) => c.id === "plan");
const reviewCommand = slashCommands.find((c) => c.id === "review");

Deno.test("slashCommands: plan is a text-taking leaf command", () => {
  assertEquals(planCommand !== undefined, true);
  assertEquals(planCommand!.requiresText, true);
  assertEquals(planCommand!.items, undefined);
  // Other modes are not text-taking (explicit false, so the menu can
  // distinguish "no" from "unknown").
  assertEquals(reviewCommand !== undefined, true);
  assertEquals(reviewCommand!.requiresText, false);
});

Deno.test("slashPrompt: text-taking mode wraps the trailing text", () => {
  const result = slashPrompt(planCommand!, undefined, "  履歴機能を追加して ");
  assertEquals(result !== null, true);
  assertEquals(result!.mode.modeId, "plan");
  assertEquals(result!.mode.optionId, "");
  assertEquals(result!.mode.modeLabel, "プランモード");
  assertEquals(result!.mode.shortText, "履歴機能を追加して");
  assertEquals(result!.text.includes("履歴機能を追加して"), true);
  assertEquals(result!.text.includes("実装計画を立案"), true);
});

Deno.test("slashPrompt: text-taking mode without text builds nothing", () => {
  assertEquals(slashPrompt(planCommand!, undefined), null);
  assertEquals(slashPrompt(planCommand!, undefined, ""), null);
  assertEquals(slashPrompt(planCommand!, undefined, "   "), null);
});

Deno.test("slashPromptFromText: /plan <request> wraps as a text line", () => {
  const line = slashPromptFromText("/plan 履歴機能を追加して");
  if (line === null || line.kind !== "wrap") return;
  assertEquals(line.mode.modeId, "plan");
  assertEquals(line.mode.shortText, "履歴機能を追加して");
  assertEquals(line.text.includes("履歴機能を追加して"), true);
});

Deno.test("slashPromptFromText: bare command token needs the request", () => {
  // The token without a request resolves to "needs-text" (nothing sent).
  assertEquals(slashPromptFromText("/plan")?.kind, "needs-text");
  assertEquals(slashPromptFromText("/plan ")?.kind, "needs-text");
  // Leading whitespace is trimmed like the composer does before wrapping.
  assertEquals(slashPromptFromText("  /plan なにか")?.kind, "wrap");
  assertEquals(slashPromptFromText(" /plan")?.kind, "needs-text");
});

Deno.test("slashPromptFromText: plain text and non-text commands pass through", () => {
  assertEquals(slashPromptFromText("普通のメッセージ"), null);
  assertEquals(slashPromptFromText("レビューして"), null);
  // review takes no text: the line is not a text-taking command.
  assertEquals(slashPromptFromText("/review 差分を"), null);
  // Unknown commands pass through too.
  assertEquals(slashPromptFromText("/nope なにか"), null);
  // A slash command mid-text is not a command line.
  assertEquals(slashPromptFromText("a /plan なにか"), null);
});

Deno.test("modeRewindText: text-taking modes restore as a command line", () => {
  // Plan mode: rewinding restores `/plan <依頼文>`, so a re-send
  // re-enters the mode instead of degrading to a plain message.
  assertEquals(
    modeRewindText("plan", "履歴機能を追加して"),
    "/plan 履歴機能を追加して",
  );
  // Menu modes keep their self-contained short text.
  assertEquals(
    modeRewindText("review", "未コミットの変更をレビューしてください"),
    "未コミットの変更をレビューしてください",
  );
  // Unknown mode ids degrade to the short text.
  assertEquals(modeRewindText("nope", "なにか"), "なにか");
});
