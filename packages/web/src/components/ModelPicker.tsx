import { useMemo, useState } from "preact/compat";
import { IconBrain, IconCheck, IconSettings } from "@tabler/icons-preact";
import { formatModelMeta, type Translator } from "@lumisca/core/shared";
import type { ModelInfo } from "../types.ts";
import { useProviderModels } from "../providers.ts";
import {
  buildModelList,
  type ModelPickerList,
  type ModelPickerRow,
} from "../model-groups.ts";
import { recentModels, rememberRecentModel } from "../recentModels.ts";
import { useT } from "../i18n.ts";

export interface ModelPickerProps {
  /** The model in effect, or null when the caller's subject has none (the
   * picker then opens on the providers' sections with no row marked). */
  value: { provider: string; modelId: string } | null;
  /** Only show models the user enabled in settings. Default true. */
  enabledOnly?: boolean;
  /** Only show models that accept image input. Used by the image-analysis
   * model picker, where a text-only model would be useless. */
  imageOnly?: boolean;
  /** Peer owning the session ("" = this server). When set, the provider
   * and model lists come from that peer, so remote sessions switch models
   * against the machine that runs the agent. */
  peerId?: string;
  /** Called with the selected model; the ModelInfo lets the caller know
   * the model's thinking levels without another fetch. */
  onSelect: (
    provider: string,
    modelId: string,
    info?: ModelInfo,
  ) => void;
  /** Open the provider settings (the row at the panel's foot). Omitted → no
   * row: a caller with no settings screen to reach from where it is (the
   * agent edit dialog) must not offer one that does nothing. */
  onOpenSettings?: () => void;
  /** Close the panel. Called after a pick: a choice answers the question the
   * panel was opened for, and the panel is small enough that leaving it up
   * would only show the choice again. */
  onClose: () => void;
}

/**
 * The model picker: one column of sections — the recently used models, then
 * one section per provider — with a search field on top.
 *
 * One layout for every screen and every window. The cascading panes it
 * replaced needed three widths at once, so the same picker had to become a
 * different UI on a phone and in a short window (providers on one screen,
 * that provider's models on the next), and a reader who learned one of them
 * did not know the other. A single scrolled column with a search field and
 * sticky provider headings finds a model in a catalogue of dozens without
 * any of that.
 *
 * Thinking strength is not here: it is a separate control beside this panel's
 * trigger (components/ThinkingLevelSelect.tsx), because the level belongs to
 * the model and is changed far more often than the model itself.
 */
export function ModelPicker({
  value,
  enabledOnly = true,
  imageOnly = false,
  peerId = "",
  onSelect,
  onOpenSettings,
  onClose,
}: ModelPickerProps) {
  const t = useT();
  const { providers: fetchedProviders, modelsByProvider, loading, error } =
    useProviderModels(peerId);
  const [search, setSearch] = useState("");
  // Read once per opening: a pick records itself and closes the panel, so
  // nothing else can change the list while it is open.
  const [recent] = useState(() => recentModels(peerId));

  // Providers the user can actually pick: configured ones only, plus the
  // current provider (even when its credentials were removed, the selected
  // model must stay visible/selectable).
  const providers = useMemo(() => {
    const configured = fetchedProviders.filter((p) => p.configured !== false);
    const current = value?.provider;
    if (current && !configured.some((p) => p.id === current)) {
      return [...configured, {
        id: current,
        name: fetchedProviders.find((p) => p.id === current)?.name ?? current,
      }];
    }
    return configured;
  }, [fetchedProviders, value?.provider]);

  const list = useMemo(
    () =>
      buildModelList({
        providers,
        modelsByProvider,
        current: value,
        recent,
        query: search,
        enabledOnly,
        imageOnly,
      }),
    [
      providers,
      modelsByProvider,
      value,
      recent,
      search,
      enabledOnly,
      imageOnly,
    ],
  );

  const choose = (row: ModelPickerRow) => {
    rememberRecentModel(peerId, row.provider, row.model.id);
    onSelect(row.provider, row.model.id, row.model);
    onClose();
  };

  const isCurrent = (row: ModelPickerRow): boolean =>
    value?.provider === row.provider && value.modelId === row.model.id;

  // The two dead ends (no catalog, nothing configured) still need a way out:
  // the panel covers the control that opened it.
  if (error !== null) {
    return (
      <div className="mp-notice">
        <div className="error-text">
          {error.phase === "providers"
            ? t("chrome.modelPicker.providersError")
            : t("chrome.modelPicker.modelsError")}
        </div>
      </div>
    );
  }
  if (providers.length === 0) {
    return (
      <div className="mp-notice">
        <div className="settings-note">
          {t("chrome.modelPicker.noProviders")}
        </div>
        <ManageRow onOpenSettings={onOpenSettings} />
      </div>
    );
  }

  return (
    <div className="model-picker">
      <input
        className="mp-model-search"
        placeholder={t("chrome.modelPicker.search")}
        aria-label={t("chrome.modelPicker.search")}
        value={search}
        onInput={(e) => setSearch(e.currentTarget.value)}
      />
      {loading && <div className="mp-loading">{t("common.loading")}</div>}
      <div className="mp-model-list">
        {list.groups.map((group) => (
          <div className="mp-group" key={group.key}>
            <div className="mp-group-head">
              {group.kind === "recent"
                ? t("chrome.modelPicker.recent")
                : group.title}
            </div>
            {group.rows.map((row) => (
              <button
                key={`${row.provider}/${row.model.id}`}
                type="button"
                className={`mp-model${isCurrent(row) ? " selected" : ""}`}
                title={row.model.name || row.model.id}
                onClick={() => choose(row)}
              >
                <span className="mp-model-id">
                  {group.kind === "recent"
                    ? `${row.provider}/${row.model.id}`
                    : row.model.id}
                </span>
                <span className="mp-model-meta">
                  {formatModelMeta(row.model.contextWindow)}
                  {row.model.reasoning && (
                    <IconBrain
                      size={12}
                      title={t("chrome.modelPicker.reasoning")}
                      aria-label={t("chrome.modelPicker.reasoning")}
                    />
                  )}
                </span>
                {isCurrent(row) && <IconCheck size={14} className="mp-check" />}
              </button>
            ))}
          </div>
        ))}
        {list.empty && !loading && (
          <div className="mp-empty">
            {emptyText(list, search, { imageOnly, enabledOnly, t })}
          </div>
        )}
      </div>
      <ManageRow onOpenSettings={onOpenSettings} />
    </div>
  );
}

/** The foot of the panel: the way to the provider settings. */
function ManageRow(
  { onOpenSettings }: { onOpenSettings?: (() => void) | undefined },
) {
  const t = useT();
  if (onOpenSettings === undefined) return null;
  return (
    <button type="button" className="mp-manage" onClick={onOpenSettings}>
      <IconSettings size={14} />
      <span>{t("chrome.modelPicker.settingsLink")}</span>
    </button>
  );
}

/** Why the list is empty. A search that matched nothing, a model the
 * settings disabled and a model that cannot take images are three different
 * answers, and the reader can act on only the ones that are theirs. */
function emptyText(
  list: ModelPickerList,
  search: string,
  options: {
    imageOnly: boolean;
    enabledOnly: boolean;
    t: Translator;
  },
): string {
  const { imageOnly, enabledOnly, t } = options;
  if (search.trim() !== "") return t("chrome.modelPicker.noMatch");
  if (list.total === 0) return t("chrome.modelPicker.noMatch");
  if (imageOnly) return t("chrome.modelPicker.noImageModels");
  if (enabledOnly) return t("chrome.modelPicker.noEnabledModels");
  return t("chrome.modelPicker.noMatch");
}
