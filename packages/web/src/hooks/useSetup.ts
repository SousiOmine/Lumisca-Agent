import type { SetupState } from "@lumisca/core/shared";
import { useCallback, useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";

/** The first-run setup's state, and the one action it has.
 *
 * The state arrives with the page (InitialData.setup): the server reads the
 * marker file while it renders the page, so the wizard can be shown before
 * anything else is drawn and no client has to ask for it. `complete` writes
 * the marker and adopts the server's answer, which is what lets the App leave
 * the wizard (see App.tsx).
 *
 * A page without that field — one served by a server that predates it, or a
 * dev shell that never received initial data — owes no wizard: there is no
 * answer to show one for, and guessing "unfinished" would put a full-screen
 * wizard in front of an installation that is already in use. */
export function useSetup(initial?: SetupState): {
  /** Whether the wizard is owed. */
  pending: boolean;
  /** Record that the setup is done. Resolves either way: a failure is left in
   * `error` (the wizard stays where it is, with the reason on screen). */
  complete: () => Promise<void>;
  /** True while the marker is being written. */
  busy: boolean;
  /** Why the last completion attempt failed, as the server put it. */
  error: string | null;
} {
  const [state, setState] = useState<SetupState | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.completeSetup());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    pending: state !== undefined && !state.completed,
    complete,
    busy,
    error,
  };
}
