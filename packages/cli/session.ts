import type { LumiscaCore } from "@lumisca/core";
import { pickModel } from "./select.ts";
import { success } from "./ui.ts";

/** Create a session in a workspace via the interactive model picker.
 * Returns the new session id, or null when the picker is cancelled.
 * Shared by the startup flow, /new and /workspace. */
export async function createSession(
  core: LumiscaCore,
  workspaceId: string,
): Promise<string | null> {
  const model = await pickModel(core);
  if (!model) return null;
  const session = core.createSession({
    workspaceId,
    modelProvider: model.providerId,
    modelId: model.modelId,
  });
  success(
    `セッション作成: ${session.id} (${model.providerId}/${model.modelId})`,
  );
  return session.id;
}
