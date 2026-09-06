import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { ClientEvent } from "../types/event.ts";
import type { GoalInfo } from "../shared/goal.ts";
import { DEFAULT_MAX_GOAL_ITERATIONS } from "../modes/goal.ts";
import { GoalJudge, lastAssistantOutput } from "./judge.ts";

/** Session-bound goal persistence (the sessions table, via the pool).
 * The session agent owns the loop; the pool binds these to one session. */
export interface GoalStore {
  loadGoal(): GoalInfo | undefined;
  saveGoal(text: string, maxIterations: number): GoalInfo;
  updateGoal(patch: {
    iteration?: number;
    status?: GoalInfo["status"];
    lastReason?: string | null;
  }): GoalInfo | undefined;
  clearGoal(): string | undefined;
}

/** Dependencies of one goal-loop run, injected by the session agent so the
 * loop stays testable without an agent. The store methods persist to the
 * sessions table (see session/repo.ts); the runner executes main-agent
 * turns. */
export interface GoalLoopDeps extends GoalStore {
  sessionId: string;
  getTranscript(): AgentMessage[];
  /** The judge model: fast model when configured, else the main model. */
  getJudgeModel(): Model<Api>;
  streamFn: StreamFn;
  /** Run one main-agent turn with the given instruction to completion. */
  runTurn(instruction: string): Promise<void>;
  emit(event: ClientEvent): void;
  /** True when the loop must stop (abort, rewind, or close). Checked
   * before every judge call and every injected turn. */
  isCancelled(): boolean;
}

/** Result of one loop run (for tests; the agent itself only needs the
 * side effects on the store and the event stream). */
export type GoalLoopOutcome =
  | { stopped: "achieved"; text: string; reason: string }
  | { stopped: "max"; text: string }
  | { stopped: "cancelled" }
  | { stopped: "error"; text: string; message: string }
  | { stopped: "none" };

/**
 * The autonomous goal loop: after each main-agent run, the fast model
 * judges achievement and, when unachieved, writes the next turn's prompt.
 * The loop injects that prompt as the next turn until the goal is done,
 * the iteration cap is hit, or the run is cancelled.
 *
 * Fail-closed on judge failures (timeout, stream error, unparseable
 * reply): the loop stops, clears the goal, and surfaces `session_error`
 * plus `goal_done` — burning iterations on an unjudged goal would waste
 * cost and risk damage.
 */
export async function runGoalLoop(
  deps: GoalLoopDeps,
): Promise<GoalLoopOutcome> {
  let goal = deps.loadGoal();
  if (!goal) return { stopped: "none" };

  while (true) {
    if (deps.isCancelled()) return { stopped: "cancelled" };
    goal = deps.loadGoal();
    if (!goal) return { stopped: "cancelled" };
    if (goal.iteration >= goal.maxIterations) {
      const text = deps.clearGoal() ?? goal.text;
      deps.emit({
        type: "goal_done",
        sessionId: deps.sessionId,
        text,
        achieved: false,
        reason: `最大反復回数（${goal.maxIterations}）に達したため停止しました`,
      });
      return { stopped: "max", text };
    }

    // Mark judging so the right-side panel can show progress.
    deps.updateGoal({ status: "judging" });
    const judging = deps.loadGoal();
    if (judging) {
      deps.emit({
        type: "goal_progress",
        sessionId: deps.sessionId,
        goal: judging,
      });
    }
    if (deps.isCancelled()) return { stopped: "cancelled" };

    let verdict;
    try {
      const judge = new GoalJudge(deps.getJudgeModel(), deps.streamFn);
      verdict = await judge.judge({
        goal: goal.text,
        transcript: lastAssistantOutput(deps.getTranscript()),
        iteration: goal.iteration,
        maxIterations: goal.maxIterations,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const text = deps.clearGoal() ?? goal.text;
      deps.emit({
        type: "session_error",
        sessionId: deps.sessionId,
        message: `ゴールの判定に失敗したため停止しました: ${message}`,
      });
      deps.emit({
        type: "goal_done",
        sessionId: deps.sessionId,
        text,
        achieved: false,
        reason: `判定エラー: ${message}`,
      });
      return { stopped: "error", text, message };
    }
    if (deps.isCancelled()) return { stopped: "cancelled" };
    if (verdict === null) {
      const text = deps.clearGoal() ?? goal.text;
      const message = "高速モデルの応答を解釈できませんでした";
      deps.emit({
        type: "session_error",
        sessionId: deps.sessionId,
        message: `ゴールの判定に失敗したため停止しました: ${message}`,
      });
      deps.emit({
        type: "goal_done",
        sessionId: deps.sessionId,
        text,
        achieved: false,
        reason: message,
      });
      return { stopped: "error", text, message };
    }

    if (verdict.achieved) {
      const text = deps.clearGoal() ?? goal.text;
      deps.emit({
        type: "goal_done",
        sessionId: deps.sessionId,
        text,
        achieved: true,
        reason: verdict.reason,
      });
      return { stopped: "achieved", text, reason: verdict.reason };
    }

    const next = deps.updateGoal({
      iteration: goal.iteration + 1,
      status: "active",
      lastReason: verdict.reason,
    }) ?? { ...goal, iteration: goal.iteration + 1 };
    deps.emit({
      type: "goal_progress",
      sessionId: deps.sessionId,
      goal: next,
    });
    if (deps.isCancelled()) return { stopped: "cancelled" };
    await deps.runTurn(verdict.nextPrompt);
  }
}

/** Resolve the loop's max iterations: explicit per-goal value or the mode
 * default. Exported for the session agent's goal-start path. */
export function resolveMaxGoalIterations(
  maxIterations?: number,
): number {
  if (
    maxIterations !== undefined && Number.isInteger(maxIterations) &&
    maxIterations > 0
  ) {
    return maxIterations;
  }
  return DEFAULT_MAX_GOAL_ITERATIONS;
}
