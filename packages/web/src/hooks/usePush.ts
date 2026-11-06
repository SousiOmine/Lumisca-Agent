import { useCallback, useEffect, useState } from "preact/compat";
import { errorMessage } from "@lumisca/core/shared";
import {
  disablePush,
  enablePush,
  postSubscription,
  type PushState,
  readPushState,
  readSubscription,
  sendTestPush,
} from "../push.ts";

/** The settings row's model: which state this device is in, and the two
 * actions it offers (toggle, test).
 *
 * `busy` is its own value rather than a flag beside `state`: the toggle is
 * disabled while it runs, and a row that still says "on" halfway through a
 * failing subscribe would invite a second click. */
export interface PushControls {
  state: PushState | "busy";
  /** Why the last action failed, as the row shows it (null when it worked). */
  error: string | null;
  /** Whether a test notification was sent since the page opened. */
  tested: boolean;
  toggle: () => void;
  sendTest: () => void;
}

export function usePush(active: boolean): PushControls {
  const [state, setState] = useState<PushState | "busy">("busy");
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void (async () => {
      const next = await readPushState();
      if (disposed) return;
      setState(next);
      // A subscription the browser holds but the server may not know about is
      // re-posted here: Safari never fires `pushsubscriptionchange`, and a
      // server whose settings file was reset loses the list while the browser
      // keeps its end. The write is idempotent, so a needless post costs one
      // request per page load and fixes both cases.
      if (next === "on") {
        const subscription = await readSubscription();
        if (subscription !== null) {
          await postSubscription(subscription).catch(() => {});
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [active]);

  const toggle = useCallback(() => {
    setError(null);
    setState("busy");
    void (async () => {
      try {
        const current = await readPushState();
        const next = current === "on"
          ? await disablePush()
          : await enablePush();
        setState(next);
      } catch (failure) {
        // The state is re-read rather than assumed: a subscribe that failed
        // halfway may still have left the browser subscribed.
        setState(await readPushState());
        setError(errorMessage(failure));
      }
    })();
  }, []);

  const sendTest = useCallback(() => {
    setError(null);
    void (async () => {
      try {
        await sendTestPush();
        setTested(true);
      } catch (failure) {
        setError(errorMessage(failure));
      }
    })();
  }, []);

  return { state, error, tested, toggle, sendTest };
}
