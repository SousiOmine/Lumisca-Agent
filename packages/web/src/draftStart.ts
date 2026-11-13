/** The transient state of one "start a session from the draft" request. */
export interface DraftStartState {
  /** True while the request runs, false once it has settled. */
  busy: (busy: boolean) => void;
  /** Why the last start failed; undefined while no failure is shown. */
  error: (message: string | undefined) => void;
}

/**
 * Run one start request and settle the state it sets.
 *
 * The new-session screen is kept mounted after the session starts (see
 * components/SessionPane), so a flag left set outlives the request: the
 * screen that comes back with the next "+" is the same component, and a
 * stale flag greys out its send button. `busy` therefore describes the
 * request only and is released when it settles — on success as well as on
 * failure, since a start that worked also ends.
 */
export async function startDraft(
  request: () => Promise<void>,
  state: DraftStartState,
  describe: (error: unknown) => string,
): Promise<void> {
  state.busy(true);
  state.error(undefined);
  try {
    await request();
  } catch (error) {
    state.error(describe(error));
  } finally {
    state.busy(false);
  }
}
