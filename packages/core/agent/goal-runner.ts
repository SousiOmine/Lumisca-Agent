import type { AgentMessage, Api, Model, StreamFn } from "../ai/types.ts";
import type { ClientEvent } from "../types/event.ts";
import type { GoalInfo } from "../shared/goal.ts";
import type { GoalStore } from "../goal/loop.ts";
import {
  finishGoal,
  resolveMaxGoalIterations,
  runGoalLoop,
} from "../goal/loop.ts";
import { DEFAULT_MAX_GOAL_ITERATIONS } from "../modes/goal.ts";
import type { ModePrompt } from "../types/mode-message.ts";

/** Collaborators the goal runner needs from the session agent. */
export interface GoalRunnerDeps {
  sessionId: string;
  goalStore: GoalStore;
  getTranscript: () => AgentMessage[];
  getJudgeModel: () => Model<Api>;
  streamFn: StreamFn;
  runTurn: (instruction: string) => Promise<void>;
  emit: (event: ClientEvent) => void;
  isClosed: () => boolean;
}

/** Owns the autonomous goal loop of one session agent. Extracted from
 * SessionAgent so goal start/cancel/rewind-cancel and the loop guard live
 * in one testable unit; the agent keeps only the turn wiring (its loop is
 * driven from maybeRunGoalLoop after every completed run). */
export class GoalRunner {
  /** Bumped to cancel a running goal loop (abort / rewind / explicit
   * cancel). Compared by epoch so a stop between two iterations stands
   * the next judge/turn down. */
  private goalEpoch = 0;
  /** True while the goal loop runs; re-entrant prompts join instead of
   * starting a second loop. */
  private loopRunning = false;

  constructor(private readonly deps: GoalRunnerDeps) {}

  /** The session's active goal, if any (for the right-side panel resync). */
  getGoal(): GoalInfo | undefined {
    return this.deps.goalStore.loadGoal();
  }

  /** Whether a goal is active. */
  hasGoal(): boolean {
    return this.deps.goalStore.loadGoal() !== undefined;
  }

  /** Bump the epoch to stop a running loop without clearing the persisted
   * goal (session close: reopening shows the goal again via resync but
   * does not auto-resume the loop). */
  stopLoop(): void {
    this.goalEpoch++;
  }

  /** Cancel the active goal (the panel's cancel button, the abort fast
   * path). Clears the persisted goal and emits `goal_done`; no-op when no
   * goal runs. */
  cancel(reason: string): void {
    this.goalEpoch++;
    const goal = this.deps.goalStore.loadGoal();
    if (goal === undefined) return;
    finishGoal(
      this.deps.goalStore,
      (event) => this.deps.emit(event),
      this.deps.sessionId,
      goal.text,
      false,
      reason,
    );
  }

  /** Cancel the goal when a rewind removed its declaration. Only a removed
   * timestamp matching a goal mode message cancels; rewinding plan/review
   * or plain user turns leaves the goal intact. */
  cancelWhenRewound(
    goalTimestamps: Set<number>,
    removed: Array<{ role: string; timestamp: number }>,
  ): void {
    if (goalTimestamps.size === 0) return;
    if (this.deps.goalStore.loadGoal() === undefined) return;
    const removedGoal = removed.some((m) => goalTimestamps.has(m.timestamp));
    if (!removedGoal) return;
    const goal = this.deps.goalStore.loadGoal();
    if (goal === undefined) return;
    this.goalEpoch++;
    finishGoal(
      this.deps.goalStore,
      (event) => this.deps.emit(event),
      this.deps.sessionId,
      goal.text,
      false,
      "操作の取り消し（巻き戻し）が行われたため、処理を中断しました",
    );
  }

  /** Start the autonomous goal when a `/goal` mode prompt arrives. The
   * goal text is the mode's short text; the full prompt already runs as
   * this turn. Emits `goal_start` for the panel. */
  startIfNeeded(mode: ModePrompt): void {
    if (mode.modeId !== "goal") return;
    const text = mode.shortText.trim();
    if (text.length === 0) return;
    const maxIterations = resolveMaxGoalIterations(
      DEFAULT_MAX_GOAL_ITERATIONS,
    );
    const goal = this.deps.goalStore.saveGoal(text, maxIterations);
    this.deps.emit({
      type: "goal_start",
      sessionId: this.deps.sessionId,
      goal,
    });
  }

  /** Run the goal loop when a goal is active (after every completed run).
   * Re-entrant prompts join the running loop instead of starting another.
   * Each iteration judges with the fast model (main-model fallback) and
   * injects the next prompt until done, capped, or cancelled. */
  async maybeRun(): Promise<void> {
    if (this.loopRunning || this.deps.isClosed()) return;
    if (this.deps.goalStore.loadGoal() === undefined) return;
    this.loopRunning = true;
    const epoch = this.goalEpoch;
    try {
      await runGoalLoop({
        sessionId: this.deps.sessionId,
        loadGoal: () => this.deps.goalStore.loadGoal(),
        saveGoal: (text, max) => this.deps.goalStore.saveGoal(text, max),
        updateGoal: (patch) => this.deps.goalStore.updateGoal(patch),
        clearGoal: () => this.deps.goalStore.clearGoal(),
        getTranscript: () => this.deps.getTranscript(),
        getJudgeModel: () => this.deps.getJudgeModel(),
        streamFn: this.deps.streamFn,
        runTurn: (instruction) => this.deps.runTurn(instruction),
        emit: (event) => this.deps.emit(event),
        isCancelled: () => this.deps.isClosed() || this.goalEpoch !== epoch,
      });
    } finally {
      this.loopRunning = false;
    }
  }
}
