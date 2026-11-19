import {
  APP_UI_IN_SYSTEM_PROMPT_KEY,
  ASK_TOOL_ENABLED_KEY,
  CODE_EXECUTION_ENABLED_KEY,
  COMPUTER_USE_ENABLED_KEY,
  type CommandApproval,
  type SavedPrompt,
} from "@lumisca/core/shared";
import { Hono } from "hono";
import {
  AppError,
  parseBody,
  requireNonEmptyString,
  requireString,
} from "./util.ts";

/** The slice of the core these routes need (interface segregation).
 * Credential filtering/guarding lives in the core, not here. */
export interface SettingsApi {
  listSettings(): Map<string, string>;
  /** Write a preference on behalf of a client; refuses protected keys and
   * any key that is not a declared preference. */
  setUserSetting(key: string, value: string): void;
  /** Enable or disable computer use. Not a plain setting write: the flag
   * decides which tools every session is offered, so the core validates that
   * this machine has a host and brings the open sessions onto the new value
   * (an idle one is rebuilt; a running one keeps its run and has its
   * discoverable tools reseeded in place). */
  setComputerUseEnabled(enabled: boolean): Promise<void>;
  /** Enable or disable the scripting tool call. Not a plain setting write
   * either: it replaces the tool set every session is built with, so the core
   * rebuilds
   * the open sessions (a running one when its run ends). */
  setCodeExecutionEnabled(enabled: boolean): void;
  /** Enable or disable the ask tool. Not a plain setting write either: the
   * tool set every session is built with changes, so the core rebuilds the
   * open sessions (a running one when its run ends). */
  setAskToolEnabled(enabled: boolean): void;
  /** Put the app-card guide in every system prompt or back in the on-demand
   * skill. Also a rebuild: the prompt is fixed for the life of an agent, so
   * the open sessions follow (a running one when its run ends). */
  setAppUiInSystemPrompt(enabled: boolean): void;
  getPersonalization(): { path: string; content: string };
  setPersonalization(content: string): void;
  /** The recorded approvals of the fast-model safety check. Entries carry a
   * redacted command for display and a hash for matching / deletion. */
  getCommandApprovals(): CommandApproval[];
  deleteCommandApproval(hash: string): void;
  clearCommandApprovals(): void;
  /** Saved prompts (user-defined prompt snippets). */
  getSavedPrompts(): SavedPrompt[];
  addSavedPrompt(input: {
    id: string;
    label: string;
    prompt: string;
  }): SavedPrompt;
  updateSavedPrompt(
    id: string,
    input: { label?: string; prompt?: string },
  ): SavedPrompt;
  deleteSavedPrompt(id: string): void;
}

export function settingRoutes(core: SettingsApi): Hono {
  const app = new Hono();

  app.get("/settings", (c) => {
    return c.json(Object.fromEntries(core.listSettings()));
  });

  app.put("/settings/:key", async (c) => {
    // Core refuses credential keys (throws CoreError → 403); credentials
    // have their own endpoint (/providers/:id/api-key).
    const body = await parseBody<{ value?: unknown }>(c);
    const value = requireString(body?.value, "value (string)");
    const key = c.req.param("key");
    if (key === COMPUTER_USE_ENABLED_KEY) {
      // A capability toggle, not a plain value: the core asks the machine
      // again (503 with its reason when the desktop still cannot be driven)
      // and brings the open sessions onto it, so the tools appear or
      // disappear immediately — a running session included.
      await core.setComputerUseEnabled(value === "1");
      return c.json({ ok: true });
    }
    if (key === CODE_EXECUTION_ENABLED_KEY) {
      // A tool-set toggle: the open sessions follow it (see the method's
      // contract), so a plain write would leave every open conversation on
      // the old tool set until it was reopened.
      core.setCodeExecutionEnabled(value === "1");
      return c.json({ ok: true });
    }
    if (key === ASK_TOOL_ENABLED_KEY) {
      // The same rule as the scripting tool call: the tool set changes, so
      // the toggle goes through the core rather than the generic write.
      core.setAskToolEnabled(value === "1");
      return c.json({ ok: true });
    }
    if (key === APP_UI_IN_SYSTEM_PROMPT_KEY) {
      // The prompt changes, and a prompt is fixed for the life of an agent:
      // the core rebuilds the open sessions instead of only storing the flag.
      core.setAppUiInSystemPrompt(value === "1");
      return c.json({ ok: true });
    }
    core.setUserSetting(key, value);
    return c.json({ ok: true });
  });

  app.get("/personalize", (c) => {
    return c.json(core.getPersonalization());
  });

  app.put("/personalize", async (c) => {
    const body = await parseBody<{ content?: unknown }>(c);
    const content = requireString(body?.content, "content (string)");
    core.setPersonalization(content);
    return c.json(core.getPersonalization());
  });

  // --- saved prompts --------------------------------------------------------

  app.get("/settings/saved-prompts", (c) => {
    return c.json({ prompts: core.getSavedPrompts() });
  });

  app.post("/settings/saved-prompts", async (c) => {
    const body = await parseBody<{
      id?: unknown;
      label?: unknown;
      prompt?: unknown;
    }>(c);
    const prompt = core.addSavedPrompt({
      id: requireNonEmptyString(body?.id, "id (string)"),
      label: requireNonEmptyString(body?.label, "label (string)"),
      prompt: requireNonEmptyString(body?.prompt, "prompt (string)"),
    });
    return c.json(prompt, 201);
  });

  app.put("/settings/saved-prompts/:id", async (c) => {
    const body = await parseBody<{ label?: unknown; prompt?: unknown }>(c);
    const id = c.req.param("id");
    const input: { label?: string; prompt?: string } = {};
    if (body && typeof body.label === "string") input.label = body.label;
    if (body && typeof body.prompt === "string") input.prompt = body.prompt;
    if (input.label === undefined && input.prompt === undefined) {
      throw new AppError("label or prompt is required", 400);
    }
    const updated = core.updateSavedPrompt(id, input);
    return c.json(updated);
  });

  app.delete("/settings/saved-prompts/:id", (c) => {
    core.deleteSavedPrompt(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Command safety (the fast-model judgement of bash/eval). The enable
  // toggle is a plain setting (`command_safety_enabled`) and goes through
  // the generic /settings surface; only the approvals record needs these
  // list-style endpoints.
  app.get("/settings/command-safety", (c) => {
    return c.json({ approvals: core.getCommandApprovals() });
  });

  app.delete("/settings/command-safety/approvals/all", (c) => {
    core.clearCommandApprovals();
    return c.json({ ok: true });
  });

  app.delete("/settings/command-safety/approvals", async (c) => {
    const body = await parseBody<{ hash?: unknown }>(c);
    core.deleteCommandApproval(
      requireNonEmptyString(body?.hash, "hash (string)"),
    );
    return c.json({ ok: true });
  });

  return app;
}
