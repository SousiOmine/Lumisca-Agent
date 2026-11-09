import { CoreError } from "../errors.ts";
import type { AskAnswer } from "../shared/mod.ts";
import type { AskHub, PendingQuestion } from "../tools/ask.ts";
import type { HandoverHub, PendingHandover } from "../vm/handover.ts";

/**
 * The two ways a run stops and waits for a person: the `ask` tool's questions
 * and the screen hand-over.
 *
 * Both live as long as the session's agent and are rejected or cancelled when
 * the run ends (a question nobody can answer any more, a hand-over nobody can
 * take). Grouping them here keeps that teardown rule in one place: the event
 * handler calls {@link endRun} once instead of remembering two hubs.
 */
export class InterruptionHub {
  constructor(
    private readonly ask: AskHub,
    private readonly handover: HandoverHub | null,
  ) {}

  /** The user answered a question (the answer resolves the blocked tool). */
  answerQuestion(toolCallId: string, answers: AskAnswer[]): void {
    this.ask.answer(toolCallId, answers);
  }

  /** The questions the run is blocked on (the resync snapshot). */
  pendingQuestions(): PendingQuestion[] {
    return this.ask.pendingQuestions();
  }

  /** The pending hand-over (the resync snapshot), or null. */
  pendingHandover(): PendingHandover | null {
    return this.handover?.pendingHandover() ?? null;
  }

  /** The user finished at the screen: let the blocked run continue. */
  finishHandover(note: string, toolCallId?: string): void {
    if (this.handover === null) {
      throw new CoreError(
        "This session has no screen hand-over",
        "unavailable",
      );
    }
    this.handover.finish(note, toolCallId);
  }

  /** The run ended (normally or aborted): nothing can answer the pending
   * questions, and a wait for a person has nothing left to wait for. */
  endRun(): void {
    this.ask.rejectAll();
    this.handover?.cancelAll();
  }
}
