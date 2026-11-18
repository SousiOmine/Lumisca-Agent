import { useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import type { Locale, ThemeSetting } from "../../types.ts";
import { DoneStep } from "./DoneStep.tsx";
import { ModelStep } from "./ModelStep.tsx";
import { ProviderStep } from "./ProviderStep.tsx";
import { ServerStep } from "./ServerStep.tsx";
import {
  isLastStep,
  LOCAL_STEPS,
  nextStep,
  previousStep,
  type SetupStep,
  setupSteps,
  stepNumber,
} from "./steps.ts";
import { WelcomeStep } from "./WelcomeStep.tsx";

export interface SetupScreenProps {
  /** Whether this window is the desktop shell's, which can switch the
   * displayed server through its bridge. It decides the first screen: the
   * connection gate exists only where switching is possible. */
  desktop: boolean;
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
 * reader is), the screen's body and, on the local walk, the footer's two
 * moves.
 *
 * The screens themselves are in `steps.ts`; this file is the frame that
 * makes them a walk — one progress line, one place the buttons live, and the
 * forward move that is the same everywhere except on the last screen, where
 * it finishes the wizard.
 *
 * The connection gate has no footer. Its own form carries the primary move,
 * and the way into the local walk is written as the quiet line under it:
 * both belong to the form's question, not to a step of the walk.
 */
export function SetupScreen({
  desktop,
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
  const steps = setupSteps(desktop);
  const [step, setStep] = useState<SetupStep>(steps[0]);

  const next = nextStep(steps, step);
  const previous = previousStep(steps, step);
  const last = isLastStep(step);
  const number = stepNumber(step);

  const advance = () => {
    if (next !== null) setStep(next);
    // The last screen's button is the way in: recording the marker is what
    // takes the reader to the app (the App reacts to the new state).
    else void onComplete();
  };

  return (
    <div className="setup">
      <div className="setup-inner">
        <header className="setup-head">
          <h1>{t("setup.title")}</h1>
          {number !== null && (
            <span className="setup-progress">
              {t("setup.progress", {
                current: number,
                total: LOCAL_STEPS.length,
              })}
            </span>
          )}
        </header>
        <div className="setup-body">
          {step === "server" && (
            <ServerStep onUseLocal={() => setStep(LOCAL_STEPS[0])} />
          )}
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
        {step !== "server" && (
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
        )}
      </div>
    </div>
  );
}
