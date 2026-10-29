import { IconCode, IconSparkles } from "@tabler/icons-preact";
import { useT } from "../i18n.ts";
import type { AppModeStatus } from "../types.ts";

interface ModeSelectViewProps {
  /** The status read at startup; `mode` is null until a choice is stored. */
  status: AppModeStatus;
  /** Why the last attempt to switch failed (e.g. stella refused). */
  error: string | null;
  /** True while the choice is being stored. */
  busy: boolean;
  onChoose: (mode: "code" | "stella") => void;
}

/**
 * The first screen of the app: which mode to work in.
 *
 * Shown while no mode is stored, and reachable later from the app menu.
 * stella is offered only where it can actually run — the card is disabled and
 * says why (podman missing, the machine cannot start), because a mode whose
 * whole premise is a virtual machine has no honest degraded form. There is
 * deliberately no "continue anyway": picking code mode is the alternative, and
 * it is right there.
 */
export function ModeSelectView(
  { status, error, busy, onChoose }: ModeSelectViewProps,
) {
  const t = useT();
  const stellaAvailable = status.availability.available;
  return (
    <div className="mode-select">
      <div className="mode-select-inner">
        <header className="mode-select-header">
          <h1>{t("chat.modeSelect.title")}</h1>
          <p>{t("chat.modeSelect.description")}</p>
        </header>
        <div className="mode-select-cards">
          <button
            type="button"
            className={`mode-card${status.mode === "code" ? " current" : ""}`}
            disabled={busy}
            onClick={() => onChoose("code")}
          >
            <span className="mode-card-icon">
              <IconCode size={26} stroke={1.6} />
            </span>
            <span className="mode-card-title">
              {t("chat.modeSelect.code.title")}
            </span>
            <span className="mode-card-description">
              {t("chat.modeSelect.code.description")}
            </span>
            <span className="mode-card-action">
              {status.mode === "code"
                ? t("chat.modeSelect.current")
                : t("chat.modeSelect.choose")}
            </span>
          </button>
          <button
            type="button"
            className={`mode-card${status.mode === "stella" ? " current" : ""}`}
            disabled={busy || !stellaAvailable}
            onClick={() => onChoose("stella")}
          >
            <span className="mode-card-icon">
              <IconSparkles size={26} stroke={1.6} />
            </span>
            <span className="mode-card-title">
              {t("chat.modeSelect.stella.title")}
            </span>
            <span className="mode-card-description">
              {t("chat.modeSelect.stella.description")}
            </span>
            {stellaAvailable
              ? (
                <span className="mode-card-action">
                  {status.mode === "stella"
                    ? t("chat.modeSelect.current")
                    : t("chat.modeSelect.choose")}
                </span>
              )
              : (
                <span className="mode-card-unavailable">
                  {t("chat.modeSelect.stella.unavailable", {
                    reason: status.availability.available
                      ? ""
                      : status.availability.reason,
                  })}
                </span>
              )}
          </button>
        </div>
        {error && (
          <p className="error-text mode-select-error" role="alert">{error}</p>
        )}
      </div>
    </div>
  );
}
