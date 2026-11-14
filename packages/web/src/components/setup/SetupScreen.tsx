import { useState } from "preact/compat";
import { useT } from "../../i18n.ts";
import type { Locale, ThemeSetting } from "../../types.ts";
import { DoneStep } from "./DoneStep.tsx";
import { ModelStep } from "./ModelStep.tsx";
import { ProviderStep } from "./ProviderStep.tsx";
import {
  isLastStep,
  nextStep,
  previousStep,
  SETUP_STEPS,
  type SetupStep,
  stepNumber,
} from "./steps.ts";
import { WelcomeStep } from "./WelcomeStep.tsx";

export interface SetupScreenProps {
  theme: ThemeSetting;
  themeError: string | null;
  onThemeChange: (theme: ThemeSetting) => void;
  language: Locale;
  languageError: string | null;
  onLanguageChange: (language: Locale) => void;
  /** True while the setup's completion is being recorded. */
  busy: boolean;
  /** Why the last attempt to record it failed (the marker could not be
   * written). */
  error: string | null;
  /** Write the marker. The App leaves this screen once it lands (see
   * App.tsx); a failure keeps the wizard here with `error` set. */
  onComplete: () => Promise<void>;
}

/**
 * The first-run setup, as one screen: the header (its name and where the
 * reader is), the step's body, and the footer's two moves.
 *
 * The steps themselves are in `steps.ts`; this file is the frame that makes
 * them a walk — one progress line, one place the buttons live, and the
 * forward move that is the same everywhere except on the last step, where it
 * finishes the wizard.
 */
export function SetupScreen({
  theme,
  themeError,
  onThemeChange,
  language,
  languageError,
  onLanguageChange,
  busy,
  error,
  onComplete,
}: SetupScreenProps) {
  const t = useT();
  const [step, setStep] = useState<SetupStep>(SETUP_STEPS[0]);

  const next = nextStep(step);
  const previous = previousStep(step);
  const last = isLastStep(step);

  const advance = () => {
    if (next !== null) setStep(next);
    // The last step's button is the way in: recording the marker is what
    // takes the reader to the app (the App reacts to the new state).
    else void onComplete();
  };

  return (
    <div className="setup">
      <div className="setup-inner">
        <header className="setup-head">
          <h1>{t("setup.title")}</h1>
          <span className="setup-progress">
            {t("setup.progress", {
              current: stepNumber(step),
              total: SETUP_STEPS.length,
            })}
          </span>
        </header>
        <div className="setup-body">
          {step === "welcome" && (
            <WelcomeStep
              theme={theme}
              themeError={themeError}
              onThemeChange={onThemeChange}
              language={language}
              languageError={languageError}
              onLanguageChange={onLanguageChange}
            />
          )}
          {step === "provider" && <ProviderStep />}
          {step === "model" && <ModelStep />}
          {step === "done" && <DoneStep />}
        </div>
        {error !== null && (
          <p className="error-text setup-error" role="alert">
            {t("setup.completeFailed", { error })}
          </p>
        )}
        <div className="setup-actions">
          {previous !== null && (
            <button
              type="button"
              className="btn setup-back"
              disabled={busy}
              onClick={() => setStep(previous)}
            >
              {t("common.back")}
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={advance}
          >
            {last ? t("setup.start") : t("setup.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
