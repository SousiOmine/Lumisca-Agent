import type { ProviderInfo } from "@lumisca/core/shared";
import { useState } from "preact/compat";
import { useT } from "../../i18n.ts";
import {
  reloadCatalog,
  useProviderModels,
  useUserProviders,
} from "../../providers.ts";
import { AddProviderFlow } from "../settings/AddProviderFlow.tsx";
import { AddUserProviderForm } from "../settings/AddUserProviderForm.tsx";
import { ProviderDetail } from "../settings/ProviderDetail.tsx";
import { ProviderRow } from "../settings/ProviderRow.tsx";

/** Providers offered first: the ones most installations start with. The
 * catalog is the answer to what exists, so an id it no longer has is dropped
 * instead of being shown as a name this app made up. */
const COMMON_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "xai",
  "openrouter",
  "groq",
  "mistral",
] as const;

/** Which screen of this step is showing. The step is one address (`/setup`),
 * so its own navigation is state, and "back" always names where the reader
 * came from (the common list or the full catalogue). */
type View =
  | { kind: "common" }
  | { kind: "catalog" }
  | { kind: "detail"; providerId: string; from: "common" | "catalog" }
  | { kind: "addUser" };

/**
 * Step 2: connect one AI provider.
 *
 * The three screens are the settings dialog's own (the searchable catalogue,
 * the provider detail with its key field and sign-in flows, and the custom
 * OpenAI-compatible form), so a key stored here is stored exactly as one
 * entered in Settings → プロバイダー: there is one implementation of each flow
 * and this step only decides the order they appear in.
 *
 * Nothing requires a provider: the footer's 次へ lets the reader continue, and
 * the note under the list says where to connect one later. The inner screens'
 * own 完了 returns to the list (as it does in the settings dialog) rather than
 * moving the wizard on: a step has one forward button, in the footer.
 */
export function ProviderStep() {
  const t = useT();
  const [view, setView] = useState<View>({ kind: "common" });
  const { providers, loading } = useProviderModels("");
  const { reload: reloadUserProviders } = useUserProviders();

  if (view.kind === "detail") {
    return (
      <ProviderDetail
        providerId={view.providerId}
        onBack={() => setView({ kind: view.from })}
        onDone={() => setView({ kind: view.from })}
      />
    );
  }
  if (view.kind === "addUser") {
    return (
      <AddUserProviderForm
        mode="create"
        onBack={() => setView({ kind: "catalog" })}
        onDone={() => {
          // Same reloads as the settings dialog's create flow: the new
          // provider has to reach the catalog store before the list (and the
          // model step after it) reads it.
          reloadUserProviders();
          reloadCatalog();
          setView({ kind: "common" });
        }}
      />
    );
  }
  if (view.kind === "catalog") {
    return (
      <AddProviderFlow
        onSelect={(providerId) =>
          setView({ kind: "detail", providerId, from: "catalog" })
        }
        onAddUser={() => setView({ kind: "addUser" })}
        onBack={() => setView({ kind: "common" })}
      />
    );
  }

  const known = new Map(providers.map((provider) => [provider.id, provider]));
  const common = COMMON_PROVIDERS.map((id) => known.get(id)).filter(
    (provider): provider is ProviderInfo => provider !== undefined,
  );

  return (
    <>
      <h2 className="setup-step-title">{t("setup.provider.title")}</h2>
      {common.length > 0 ? (
        <>
          <p className="settings-note">{t("setup.provider.popular")}</p>
          <div className="settings-list">
            {common.map((provider) => (
              <ProviderRow
                key={provider.id}
                name={provider.name}
                status={
                  provider.configured === true
                    ? t("setup.provider.connected")
                    : undefined
                }
                onOpen={() =>
                  setView({
                    kind: "detail",
                    providerId: provider.id,
                    from: "common",
                  })
                }
              />
            ))}
          </div>
        </>
      ) : (
        <p className="settings-note">
          {loading ? t("common.loading") : t("setup.provider.catalogFailed")}
        </p>
      )}
      <div className="setup-provider-more">
        <button
          type="button"
          className="btn"
          onClick={() => setView({ kind: "catalog" })}
        >
          {t("setup.provider.more")}
        </button>
      </div>
      <p className="settings-note">{t("setup.provider.note")}</p>
    </>
  );
}
