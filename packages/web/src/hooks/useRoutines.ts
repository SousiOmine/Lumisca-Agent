import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import type { RoutineView } from "../types.ts";

/**
 * The routines of one agent, for the settings list.
 *
 * The list is small and the mutations all answer with the new list, so the
 * state is "the server's answer, newest wins": a toggle, a delete or a run
 * replaces the whole array instead of patching an entry. That is why a
 * mutation and a refresh cannot disagree about `running` (which lives in the
 * server's scheduler, not the database).
 *
 * Nothing here creates a routine: the request and the name are things the
 * agent writes from what the user said (see routine/tools.ts).
 */
export function useRoutines(agentId: string | null): {
  routines: RoutineView[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  run: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
} {
  const [routines, setRoutines] = useState<RoutineView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refresh that resolves after a newer one must not overwrite it.
  const generation = useRef(0);

  const load = useCallback((id: string) => {
    const seq = ++generation.current;
    setLoading(true);
    void (async () => {
      try {
        const { routines: list } = await api.listRoutines(id);
        if (generation.current !== seq) return;
        setRoutines(list);
        setError(null);
      } catch (failure) {
        if (generation.current !== seq) return;
        setError(errorText(failure));
      } finally {
        if (generation.current === seq) setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (agentId === null) {
      setRoutines([]);
      setError(null);
      setLoading(false);
      return;
    }
    load(agentId);
  }, [agentId, load]);

  const refresh = useCallback(() => {
    if (agentId !== null) load(agentId);
  }, [agentId, load]);

  /** Apply one mutation's answer (the server returns the new list). */
  const apply = useCallback((list: RoutineView[]) => {
    // A mutation is newer than any list read in flight.
    generation.current++;
    setRoutines(list);
    setError(null);
  }, []);

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    const { routines: list } = await api.setRoutineEnabled(id, enabled);
    apply(list);
  }, [apply]);

  const run = useCallback(async (id: string) => {
    const { routines: list } = await api.runRoutine(id);
    apply(list);
  }, [apply]);

  const stop = useCallback(async (id: string) => {
    const { routines: list } = await api.stopRoutine(id);
    apply(list);
  }, [apply]);

  const remove = useCallback(async (id: string) => {
    const { routines: list } = await api.deleteRoutine(id);
    apply(list);
  }, [apply]);

  return {
    routines,
    loading,
    error,
    refresh,
    setEnabled,
    run,
    stop,
    remove,
  };
}
