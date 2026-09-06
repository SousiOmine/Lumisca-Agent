/** Frontend-safe shared helpers (see shared/mod.ts): goal state shapes.
 * No runtime dependencies (no db / pi imports) — bundled into the browser
 * client like the todo/task snapshots. */

/** Lifecycle of the currently running goal, as shown in the right-side
 * panel. Only one goal runs per session at a time. */
export type GoalStatus = "active" | "judging";

/** Snapshot of the session's active goal (the `/goal` mode). Carried by
 * the goal events and the goal resync endpoint. Undefined/null when the
 * session has no active goal. */
export interface GoalInfo {
  /** The goal text the user declared (`/goal ○○`). */
  text: string;
  /** Completed main-agent runs for this goal (0-based display is +1). */
  iteration: number;
  /** Upper bound of the autonomous loop (see DEFAULT_MAX_GOAL_ITERATIONS). */
  maxIterations: number;
  /** `judging` while the fast model evaluates the last run. */
  status: GoalStatus;
  /** The judge's reason for the last evaluation (shown under the goal). */
  lastReason?: string;
}
