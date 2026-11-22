import type { SettingsRepo } from "../settings/repo.ts";
import { MODEL_ENABLED_PREFIX } from "../shared/settings-keys.ts";

/**
 * Whether a model is offered in the UI's pickers.
 *
 * Enabled is the default and is stored as the absence of a key, so a newly
 * added model appears without a write; only a disabled one has a row.
 */
export class ModelEnablement {
  constructor(private readonly settings: SettingsRepo) {}

  set(providerId: string, modelId: string, enabled: boolean): void {
    const key = keyOf(providerId, modelId);
    if (enabled) {
      this.settings.delete(key);
    } else {
      this.settings.set(key, "0");
    }
  }

  isEnabled(providerId: string, modelId: string): boolean {
    return this.settings.get(keyOf(providerId, modelId)) !== "0";
  }
}

function keyOf(providerId: string, modelId: string): string {
  return `${MODEL_ENABLED_PREFIX}${providerId}:${modelId}`;
}
