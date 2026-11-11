import type { ImageContent } from "../ai/types.ts";
import type { ModePrompt } from "../domain/mode-message.ts";
import type { AskAnswer, PromptFileRef } from "../shared/mod.ts";
import type { SessionServiceDeps } from "./session-deps.ts";

type Deps = Pick<SessionServiceDeps, "sessions" | "pool">;

/**
 * Steering a live session: sending a prompt, stopping the run, answering a
 * question, rewinding the transcript and condensing it.
 *
 * Every method requires an open agent (`pool.require`): these are operations
 * on a run, and a run exists only while the agent is open. Opening is the
 * caller's business (the prompt route opens first), which keeps the
 * fire-and-forget path fire-and-forget.
 */
export class SessionRuns {
  constructor(private readonly deps: Deps) {}

  /** Send a prompt into a session (fire-and-forget). */
  startPrompt(
    id: string,
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
    files?: PromptFileRef[],
  ): void {
    const agent = this.deps.pool.require(id);
    this.deps.sessions.touch(id);
    agent.promptWhileRunning(text, images, mode, undefined, files);
  }

  /** Start stella's setup turn (fire-and-forget): a prompt only the model
   * reads, so the conversation shows the agent's questions and not the
   * app's instruction to ask them (see SessionAgent.startOnboarding). */
  startOnboarding(id: string, instruction: string): void {
    const agent = this.deps.pool.require(id);
    this.deps.sessions.touch(id);
    agent.startOnboarding(instruction);
  }

  abort(id: string): void {
    this.deps.pool.require(id).abort();
  }

  answerQuestion(id: string, toolCallId: string, answers: AskAnswer[]): void {
    this.deps.pool.require(id).answerQuestion(toolCallId, answers);
  }

  /** Undo the transcript from a user message onward. */
  async rewind(id: string, timestamp: number): Promise<void> {
    const agent = this.deps.pool.require(id);
    this.deps.sessions.touch(id);
    await agent.rewind(timestamp);
  }

  /** Condense the session's older history into a checkpoint on demand. */
  async compactSession(
    id: string,
    instructions?: string,
  ): Promise<number | undefined> {
    const agent = this.deps.pool.require(id);
    this.deps.sessions.touch(id);
    const result = await agent.compactNow(instructions);
    return result?.summarized.length;
  }
}
