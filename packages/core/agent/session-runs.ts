/**
 * Starting a run from a prompt.
 *
 * Every prompt path of a session — the awaited `prompt`, a routine's run, a
 * fire-and-forget delivery from the web UI, an injected notification — goes
 * through the same sequence: wait for MCP discovery, wait out an in-flight
 * rewind, publish the context preamble, build and announce the message, start
 * the run, then let the turn policy resume a parked restart. The paths used to
 * repeat that sequence, so a change to any step (the context publish a
 * notification-driven run was missing) had to be made three times.
 */

import type { Agent } from "../ai/agent.ts";
import type { NotificationPayload } from "../ai/notification.ts";
import { notificationMessage } from "../ai/notification.ts";
import type { ClientEvent } from "../domain/event.ts";
import type {
  AgentMessage,
  ImageContent,
  TextContent,
} from "../domain/message.ts";
import type { ModePrompt } from "../domain/mode-message.ts";
import { buildModeMessage } from "../domain/mode-message.ts";
import { errorMessage } from "../errors.ts";
import { type PromptFileRef, textWithFileNotice } from "../shared/mod.ts";
import type { BackgroundCommandDone } from "../tools/background.ts";
import { formatBackgroundNotification } from "../tools/background.ts";
import type { McpAttachmentHost } from "./mcp-host.ts";
import type { RetryManager } from "./retry-manager.ts";
import type { Rewinder } from "./rewinder.ts";
import { ROUTINE_SILENCE_GUIDANCE } from "./routine-guidance.ts";
import { type RoutineDropHost, RoutineRun } from "./routine-run.ts";
import type { SessionTurn } from "./session-turn.ts";
import type { TitleScheduler } from "./title-scheduler.ts";
import type { TranscriptStore } from "./transcript.ts";

/** `text` with `part` after it, separated by a blank line; undefined when
 * there is nothing to append (so a message without a model-only part keeps
 * `modelContent` unset and its content is its identity). */
function withTrailingPart(
  text: string,
  part: string | undefined,
): string | undefined {
  if (part === undefined || part.length === 0) {
    return text.length === 0 ? undefined : text;
  }
  return text.length === 0 ? part : `${text}\n\n${part}`;
}

/** What starting a run needs from the session that owns it. Function-based
 * rather than a reference to the session agent: the runs read the live agent,
 * the store and the retry state, but own none of them. */
export interface SessionRunHost {
  readonly sessionId: string;
  readonly agent: Agent;
  readonly transcript: TranscriptStore;
  readonly rewinder: Rewinder;
  readonly retry: RetryManager;
  readonly titleScheduler: TitleScheduler;
  /** The session's MCP attachment: its discovery gates the first prompt. */
  readonly mcp: Pick<McpAttachmentHost, "done" | "waitReady">;
  /** The turn policy: the fresh-exchange reset, and the restart chain a dead
   * run waits for (see SessionTurn). */
  readonly turn: Pick<SessionTurn, "resetRetryState" | "resumeAfterErrorRun">;
  /** Publish the pending context updates before a run starts. */
  publishContexts(): void;
  /** Re-anchor the context publications to the model's view. */
  rebaseContexts(messages: AgentMessage[]): void;
  isClosed(): boolean;
  isStreaming(): boolean;
  /** Publish a client event (see SessionEvents.emit). */
  emit(event: ClientEvent): void;
  /** Announce a message to clients (see SessionEvents.announce). */
  announce(message: AgentMessage): void;
}

/**
 * The runs of one session: every prompt path, the delivery decision (a steer
 * into the active run or a run of its own), and the removal of a routine's
 * silent run. What happens at a turn boundary (the app-card take-back, the
 * retry classification, the restart chain) is SessionTurn; the run only calls
 * it.
 */
export class SessionRuns {
  /** The routine in flight and the removal of a silent one. */
  private readonly routineRuns = new RoutineRun();
  private readonly routineHost: RoutineDropHost;

  constructor(private readonly host: SessionRunHost) {
    this.routineHost = {
      messages: () => host.agent.state.messages,
      baseIndex: () => host.transcript.baseIndex,
      forgetFrom: (messages, from) =>
        host.transcript.forgetFrom(messages, from),
      truncateFrom: (position) => host.transcript.truncateFrom(position),
      rebaseContexts: (messages) => host.rebaseContexts(messages),
      emitTruncated: (removed) =>
        host.emit({
          type: "messages_truncated",
          sessionId: host.sessionId,
          removed,
        }),
    };
  }

  /** Run a prompt to completion. `images` are attached to the user message
   * (base64, passed through to vision-capable models; pi omits them for
   * text-only models). Waits for MCP tools to attach first (they spawn
   * server processes asynchronously). Failures are reported via the
   * `session_error` event, never through the returned promise — the
   * fire-and-forget HTTP path listens on events instead, so awaiting here
   * only means "the run finished". */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    await this.runPrompt(text, images, { firstMessageText: text });
  }

  /**
   * Run a routine's prompt to completion and report how it went.
   *
   * A routine's run is awaited by the scheduler (it needs the outcome to
   * record it) and it carries the routine's name on the message, which is how
   * the run is told apart from the same words typed. The conversation itself
   * does not draw the prompt — its text is the routine's standing
   * instruction — so the name reaches the user through the
   * agent list instead. The failure is ALSO returned, not only emitted:
   * the run's failure belongs on the routine's row (the settings list shows
   * it), while the transcript keeps its own error row from the normal path.
   *
   * The silence guidance goes in `modelOnly`: it tells the model that this
   * run may end without saying anything (see routine-guidance.ts), and it is
   * never drawn: neither that sentence nor the prompt it qualifies is part of
   * the conversation.
   */
  async runRoutine(
    text: string,
    routine: { id: string; name: string },
  ): Promise<{ failure: string | null }> {
    return await this.runPrompt(text, undefined, {
      routine,
      modelOnly: ROUTINE_SILENCE_GUIDANCE,
    });
  }

  /** The routine whose run is in flight, or null. */
  runningRoutineId(): string | null {
    return this.routineRuns.runningId();
  }

  /** Send a user prompt even while a run is active (fire-and-forget; the
   * web UI path). An active run steers the message in at the next turn
   * boundary — the same mechanism background-command notifications use —
   * so it is processed after the current turn (tool executions included)
   * completes; an idle agent starts a fresh run.
   *
   * Two states never take a steer, because the message would be dropped
   * instead of queued for a later turn (see deliverPrompt): a run that is
   * unwinding from an abort (the rewind button, the stop button) and an
   * in-flight rewind, whose truncation would delete the message again.
   *
   * The message is announced immediately (synthetic message_start/end
   * events) so clients render it right away. When the loop drains it, it
   * re-emits the same events for the same message (identical role +
   * timestamp), which the UI dedups, and the transcript store saves it
   * exactly once at that point.
   *
   * A message that joins the active run carries `steered`: the UI keeps it
   * inside that run's turn instead of starting one of its own, because a
   * turn that did not start a run must not end the running one (see web's
   * buildTurns — the same stamp a notification carries).
   *
   * When `mode` is provided, a ModeMessage is stored in the transcript
   * instead of a regular user message: the UI renders the short text +
   * mode badge, while the LLM receives the full prompt (via
   * toLlmMessages). Attached `images` ride along either way. */
  promptWhileRunning(
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
    routine?: string,
    files?: PromptFileRef[],
    modelOnly?: string,
  ): void {
    const host = this.host;
    // The first prompt of a session names it, whichever path delivered it.
    host.titleScheduler.maybeGenerate(mode ? mode.shortText : text);
    // Decided before the message is built: the stamp must describe the
    // delivery below, and the condition is the one deliverPrompt re-checks.
    const steered = this.joinsActiveRun();
    // Same order as runPrompt: the preamble, then the prompt it introduces.
    host.publishContexts();
    const message = mode
      ? buildModeMessage(
          mode,
          text,
          images ?? [],
          host.agent.nextTimestamp(),
          steered,
        )
      : this.buildUserMessage(text, images, steered, routine, files, modelOnly);
    host.announce(message);
    void this.deliverPrompt(message, mode);
  }

  /**
   * Start stella's setup turn: a prompt only the MODEL reads.
   *
   * The visible text is empty on purpose. The conversation must show the
   * agent's greeting and its questions, not the app's instruction to write
   * them (see stella/onboarding.ts); an empty prompt that attached nothing is
   * not a conversation entry (agent/stella-stream.ts drops it), while the
   * model is sent `modelContent` in its place. This is the only caller: a
   * user's prompt always carries text or an attachment.
   */
  startOnboarding(instruction: string): void {
    this.promptWhileRunning(
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      instruction,
    );
  }

  /** A background command finished: inject its completion notification
   * into the agent loop so the agent can react (see injectNotification).
   *
   * Commands killed via async_bash_kill are not notified: the tool's own
   * result already reports the kill, so a notification would be
   * redundant. Natural exits and timeouts are silent without a
   * notification, so they are always injected. */
  notifyBackgroundCommand(done: BackgroundCommandDone): void {
    if (done.reason === "killed") return;
    this.injectNotification(formatBackgroundNotification(done));
  }

  /** Whether the routine in flight has said nothing so far (see
   * RoutineRun.saidNothingSoFar): its end must not notify. */
  routineSaidNothing(messages: AgentMessage[]): boolean {
    return this.routineRuns.saidNothingSoFar(messages);
  }

  /**
   * The ONE way an exchange starts from a message the user (or a routine)
   * supplied. Every prompt path is a thin wrapper over this:
   *
   * - `prompt` (awaited, no title/routine extras),
   * - `runRoutine` (carries the routine's name and returns its failure),
   * - `deliverPrompt` (a fire-and-forget prompt, possibly a mode prompt).
   *
   * `message` is already built and announced by callers that had to decide
   * its shape before the wait (see promptWhileRunning); everything else is
   * done here.
   */
  private async runPrompt(
    text: string,
    images: ImageContent[] | undefined,
    options: {
      /** The routine whose run this is (stamped so its stop button only
       * interrupts its own run). */
      routine?: { id: string; name: string };
      /** A mode prompt: stored as a ModeMessage. */
      mode?: ModePrompt;
      /** Called before the first LLM request (title generation). */
      firstMessageText?: string;
      /** A message the caller already built AND announced (promptWhileRunning
       * had to decide its `steered` stamp before waiting on a rewind). The
       * run then does not rebuild or re-announce it. */
      announced?: AgentMessage;
      /** Files the user attached to this prompt (already in the machine). */
      files?: PromptFileRef[];
      /** Text only the MODEL reads, after the prompt (see
       * `buildUserMessage`'s `modelOnly`). */
      modelOnly?: string;
    } = {},
  ): Promise<{ failure: string | null }> {
    const host = this.host;
    if (!host.mcp.done) await host.mcp.waitReady();
    // Skipped entirely when no rewind runs, so a fire-and-forget delivery
    // reaches the agent in the caller's task (no microtask window in which
    // waitForIdle could report the run finished).
    if (host.rewinder.busy) await host.rewinder.settle();
    if (host.isClosed()) return { failure: null };
    if (options.firstMessageText !== undefined) {
      host.titleScheduler.maybeGenerate(options.firstMessageText);
    }
    // The delivery fact the announcement carries must describe the delivery
    // below: a prompt delivered while a run is active is queued into that
    // run by the agent loop instead of starting one of its own.
    const steered = this.joinsActiveRun();
    // The contexts are published FIRST: they are the run's preamble, so they
    // must precede the prompt in the transcript (and, with the timestamp,
    // in time — see Agent.nextTimestamp).
    host.publishContexts();
    const message =
      options.announced ??
      (options.mode !== undefined
        ? buildModeMessage(
            options.mode,
            text,
            images ?? [],
            host.agent.nextTimestamp(),
            steered,
          )
        : this.buildUserMessage(
            text,
            images,
            steered,
            options.routine?.name,
            options.files,
            options.modelOnly,
          ));
    if (options.announced === undefined) host.announce(message);
    host.turn.resetRetryState();
    // Where the routine's own prompt will sit: the view's length now, since
    // `prompt` appends it and everything the run produces follows it. A
    // silent routine's run is removed from there (see below), and its end
    // is what that removal is decided from (see RoutineRun).
    const promptIndex =
      options.routine === undefined
        ? undefined
        : host.agent.state.messages.length;
    if (options.routine !== undefined && promptIndex !== undefined) {
      this.routineRuns.begin(options.routine.id, promptIndex);
    }
    let failure: string | null = null;
    // The run stays "in flight" until its restart chain is done: a retried
    // turn emits an `agent_end` of its own, and only a run still in flight
    // can tell it to stay quiet (see RoutineRun).
    try {
      try {
        await host.agent.prompt(message);
      } catch (error) {
        failure = errorMessage(error);
        host.emit({
          type: "session_error",
          sessionId: host.sessionId,
          message: failure,
        });
      }
      await host.turn.resumeAfterErrorRun();
    } finally {
      this.routineRuns.end();
    }
    // A routine that found nothing to report must leave the conversation
    // exactly as it found it. The model says so with the silence sentinel
    // (silent-reply.ts), which the projection already refuses to draw — but
    // the ROW would still be there, and every later turn would pay for it:
    // the routine's prompt, and an assistant reply whose whole content is
    // "NO_RESPONSE". Silence is therefore spelled as an absence, not as a
    // hidden message. Nothing is removed when the run failed or wrote
    // anything else. Read AFTER the restart chain: a run that died empty is
    // retried before it can count as silent.
    if (
      options.routine !== undefined &&
      failure === null &&
      promptIndex !== undefined &&
      this.routineRuns.wasSilent(host.agent.state.messages, promptIndex)
    ) {
      this.routineRuns.drop(this.routineHost, promptIndex);
    }
    return { failure };
  }

  /** Whether a message delivered right now joins the run that is already
   * active (steer) instead of starting its own run. The condition lives
   * here so the delivery and the `steered` stamp a message carries
   * (notifications — see injectNotification — and prompts — see
   * promptWhileRunning) can never disagree: a run that is unwinding from an
   * abort drops its queues, and a rewind is about to abort the run, so
   * neither takes a steer (see deliverPrompt). */
  private joinsActiveRun(): boolean {
    const host = this.host;
    return !host.rewinder.busy && host.isStreaming() && !host.agent.isAborting;
  }

  /** Deliver an announced prompt to the agent loop: a healthy run takes it
   * as a steer (next turn boundary); otherwise it gets its own run — after
   * an in-flight rewind finished, so its messages are not truncated away
   * and the dying run cannot swallow the steer. Always resolves: the run
   * reports its own progress and failures through events. */
  private async deliverPrompt(
    message: AgentMessage,
    mode?: ModePrompt,
  ): Promise<void> {
    const host = this.host;
    try {
      // A rewind in flight is about to abort the run: wait for it (runPrompt
      // does the same before its own run), so this message is not truncated
      // away with the messages the rewind removes.
      if (host.rewinder.busy) await host.rewinder.settle();
      if (host.isClosed()) return;
      if (this.joinsActiveRun()) {
        host.agent.steer(message);
        return;
      }
      // The text is only used when runPrompt builds the message; here the
      // caller already did (its `steered` stamp had to be decided earlier).
      await this.runPrompt("", undefined, {
        announced: message,
        ...(mode !== undefined ? { mode } : {}),
      });
    } catch (error) {
      // runPrompt reports its own failures; this guard only exists so a
      // fire-and-forget delivery can never become an unhandled rejection.
      host.emit({
        type: "session_error",
        sessionId: host.sessionId,
        message: errorMessage(error),
      });
    }
  }

  /** Build a user message from text + optional images (single home for the
   * content assembly every prompt path shares). `steered` marks a prompt
   * delivered into the run that was already active (see
   * UserMessage.steered). */
  private buildUserMessage(
    text: string,
    images?: ImageContent[],
    steered?: boolean,
    routine?: string,
    files?: PromptFileRef[],
    /** Text only the MODEL reads, appended after the visible text (and after
     * the file notice). Undefined → nothing is added. See
     * `UserMessage.modelContent`. */
    modelOnly?: string,
  ): AgentMessage {
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
    if (images !== undefined && images.length > 0) content.push(...images);
    // The files already sit in the machine; this record is what the
    // conversation draws under the bubble. Their paths are addressed to the
    // MODEL, so they travel as `modelContent` and never reach the screen: the
    // user wrote a sentence, and the sentence is what they should see.
    //
    // A routine's silence guidance belongs there for the same reason: it is
    // addressed to the model, and a bubble that told the user "if there is
    // nothing to report, stay silent" is prose about the run rather than the
    // run's instruction.
    const modelContent = withTrailingPart(
      textWithFileNotice(text, files ?? []),
      modelOnly,
    );
    return {
      role: "user",
      content,
      ...(modelContent !== undefined ? { modelContent } : {}),
      ...(steered === true ? { steered } : {}),
      ...(routine !== undefined && routine !== "" ? { routine } : {}),
      ...(files !== undefined && files.length > 0 ? { files } : {}),
      timestamp: this.host.agent.nextTimestamp(),
    };
  }

  /** Inject a notification message into the agent loop (background
   * command completions, sub-agent task completions, agent messages).
   * While streaming, the message is steered in at the next turn boundary;
   * while idle, a new run starts. The system prompt teaches the agent that
   * notification prefixes ("[Background command ...]", "[Task ...]",
   * "[Message from ...]") mark system notifications, not user input.
   *
   * The delivery decision is stamped on the message (`steered`): the UI
   * keeps a steered notification inside the run's turn instead of starting
   * a new one, so a notification arriving mid-run never collapses the
   * running turn's work log (see web's buildTurns).
   *
   * Public because a producer outside the runs injects one: the background
   * manager on a command's exit and the task hub on a sub-agent's
   * completion or message. */
  injectNotification(payload: NotificationPayload): void {
    const host = this.host;
    if (host.isClosed()) return;
    // Re-stamped: a payload is built when the producer noticed it, but it is
    // appended to the transcript now, so it must follow the message before it
    // (see Agent.nextTimestamp). `steered` is this site's decision, not the
    // producer's.
    const message: AgentMessage = {
      ...notificationMessage(payload, this.joinsActiveRun()),
      timestamp: host.agent.nextTimestamp(),
    };
    // Announce the notification to clients (the agent appends it to the
    // transcript without re-emitting — see Agent.append).
    host.announce(message);
    // Same delivery contract as a user prompt: a notification that starts
    // its own run begins a fresh exchange and waits for MCP attachment
    // inside runPrompt; a steer joins the current run.
    void this.deliverPrompt(message);
  }
}
