import { Hono } from "hono";
import type { CommandApproval, SavedPrompt } from "@lumisca/core/shared";
import { AppError, parseBody } from "./util.ts";

/** The slice of the core these routes need (interface segregation).
 * Credential filtering/guarding lives in the core, not here. */
export interface SettingsApi {
  listSettings(): Map<string, string>;
  setSetting(key: string, value: string): void;
  getPersonalization(): { path: string; content: string };
  setPersonalization(content: string): void;
  /** The recorded approvals of the fast-model safety check. Entries carry a
   * redacted command for display and a hash for matching / deletion. */
  getCommandApprovals(): CommandApproval[];
  deleteCommandApproval(hash: string): void;
  clearCommandApprovals(): void;
  /** Saved prompts (user-defined prompt snippets). */
  getSavedPrompts(): SavedPrompt[];
  addSavedPrompt(
    input: { id: string; label: string; prompt: string },
  ): SavedPrompt;
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
    if (!body || typeof body.value !== "string") {
      throw new AppError("value (string) is required", 400);
    }
    core.setSetting(c.req.param("key"), body.value);
    return c.json({ ok: true });
  });

  app.get("/personalize", (c) => {
    return c.json(core.getPersonalization());
  });

  app.put("/personalize", async (c) => {
    const body = await parseBody<{ content?: unknown }>(c);
    if (!body || typeof body.content !== "string") {
      throw new AppError("content (string) is required", 400);
    }
    core.setPersonalization(body.content);
    return c.json(core.getPersonalization());
  });

  // --- saved prompts --------------------------------------------------------

  app.get("/settings/saved-prompts", (c) => {
    return c.json({ prompts: core.getSavedPrompts() });
  });

  app.post("/settings/saved-prompts", async (c) => {
    const body = await parseBody<
      { id?: unknown; label?: unknown; prompt?: unknown }
    >(c);
    if (!body || typeof body.id !== "string" || body.id.length === 0) {
      throw new AppError("id (string) is required", 400);
    }
    if (typeof body.label !== "string" || body.label.length === 0) {
      throw new AppError("label (string) is required", 400);
    }
    if (typeof body.prompt !== "string" || body.prompt.length === 0) {
      throw new AppError("prompt (string) is required", 400);
    }
    const prompt = core.addSavedPrompt({
      id: body.id,
      label: body.label,
      prompt: body.prompt,
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
    if (!body || typeof body.hash !== "string" || body.hash.length === 0) {
      throw new AppError("hash (string) is required", 400);
    }
    core.deleteCommandApproval(body.hash);
    return c.json({ ok: true });
  });

  return app;
}
