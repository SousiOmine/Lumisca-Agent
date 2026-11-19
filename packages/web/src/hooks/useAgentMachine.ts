import { errorMessage } from "@lumisca/core/shared";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import type { StellaMachineStatus } from "../types.ts";
import { NEVER, useVisibleInterval } from "./useVisibleInterval.ts";

/** How often the open conversation's machine is read. The machines sleep and
 * wake on their own schedule, and the pane's "asleep" state has to appear
 * within a few seconds of the stop. One cached `podman` inspect per 3
 * seconds is what the global status poll already cost. */
const POLL_MS = 3_000;

/** The least time between two activity reports while the user drives the
 * screen. A pointer move is not reported; the events that mean somebody is
 * there (a press, a key, a wheel, a touch) are, and one report per 10 seconds
 * keeps the idle clock fresh without a request per click. */
const TOUCH_MIN_MS = 10_000;

export interface AgentMachine {
  /** The machine's state, or null before the first read. */
  machine: StellaMachineStatus | null;
  /** A wake was asked for and has not finished. */
  waking: boolean;
  /** Why the wake failed, when it did. */
  error: string | null;
  /** Start the machine without sending a prompt. */
  wake: () => Promise<void>;
  /** The user did something on the screen: keep the machine awake. */
  touch: () => void;
}

/**
 * One agent's machine, as the conversation needs to draw it.
 *
 * The machines are separate containers that sleep when nobody uses them (see
 * api/stella/agents/:id/machine). The conversation polls its own machine
 * while it is open — no other agent's state is read — so the screen pane can
 * say "asleep" instead of failing to connect, and the user can wake it with a
 * button. Activity on the screen is reported through `touch`: an open pane
 * with nobody at it does not keep a machine alive.
 */
export function useAgentMachine(
  agentId: string | null,
  active: boolean,
): AgentMachine {
  const [machine, setMachine] = useState<StellaMachineStatus | null>(null);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a stale response: the state is polled and changed by the
  // user, and the slower answer must not overwrite the newer.
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (agentId === null) {
      setMachine(null);
      return;
    }
    const mine = ++generation.current;
    try {
      const next = await api.getStellaAgentStatus(agentId);
      if (generation.current !== mine) return;
      setMachine(next);
    } catch {
      // A failed read is not a sentence to show: the poll retries and the
      // last known state stays, which is what the pane is drawn from.
    }
  }, [agentId]);

  useEffect(() => {
    setMachine(null);
    setError(null);
    void load();
  }, [load]);

  useVisibleInterval(
    () => void load(),
    active && agentId !== null ? POLL_MS : NEVER,
  );

  const wake = useCallback(async () => {
    if (agentId === null) return;
    setWaking(true);
    setError(null);
    try {
      await api.wakeStellaAgent(agentId);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setWaking(false);
    }
    await load();
  }, [agentId, load]);

  const lastTouch = useRef(0);
  const touch = useCallback(() => {
    if (agentId === null) return;
    const now = Date.now();
    if (now - lastTouch.current < TOUCH_MIN_MS) return;
    lastTouch.current = now;
    void api.touchStellaAgent(agentId).catch(() => {
      // The machine may have gone to sleep between the event and the post;
      // the pane already shows that state.
    });
  }, [agentId]);

  return { machine, waking, error, wake, touch };
}
