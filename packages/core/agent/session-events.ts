/**
 * Publishing one session's run to its clients.
 *
 * The agent loop emits `AgentEvent`s; a session turns them into `ClientEvent`s
 * (see run-events.ts for the translation itself), persists what a completed
 * message added, and runs the two policies a turn boundary triggers: the
 * app-card take-back and the retry classification. Everything that decides
 * WHAT the client sees lives here, and every publication goes through one
 * `emit` so a closed session can never speak.
 */

import type { Agent } from "../ai/agent.ts";
import type { AgentEvent } from "../ai/agent-types.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { AgentMessage, AssistantMessage } from "../domain/message.ts";
import { TextUi, translateRunEvent } from "./run-events.ts";
import { RunReply } from "./run-reply.ts";
import type { TranscriptStore } from "./transcript.ts";

/** The run-side decisions an event triggers, as the event publisher sees
 * them: a broken reply is taken back, a finished turn is classified, and a
 * routine that said nothing is marked quiet. */
export interface SessionEventRuns {
  /** Take back a completed reply whose app card does not parse; true when it
   * was consumed (the event then goes no further). */
  discardBrokenAppCard(message: AssistantMessage): boolean;
  /** Whether the routine in flight has said nothing so far (see RoutineRun):
   * read before the run is removed, so its end is not notified. */
  routineSaidNothing(messages: AgentMessage[]): boolean;
  /** Surface a model-stream failure to the user. */
  reportModelError(message: AgentMessage): void;
  /** Judge a completed exchange for the retry policy. */
  turnEnded(message: AgentMessage): void;
}

/** What publishing needs from the session that owns it. */
export interface SessionEventHost {
  readonly sessionId: string;
  readonly agent: Agent;
  readonly transcript: TranscriptStore;
  /** The idle timer's step around a run: a compaction must not land in a
   * run that is working, and the gap since the newest request starts when
   * the run ends (see CompactionController). */
  readonly compaction: { armIdle(): void; disarmIdle(): void };
  /** The waits a run held (ask, hand-over, env, share) are released when it
   * ends. */
  readonly interruptions: { endRun(): void };
  readonly runs: SessionEventRuns;
  isClosed(): boolean;
}

export class SessionEvents {
  /** The card being written into a reply, for a stream whose client never
   * receives the text (see SessionAgentOptions.uiFromText). */
  private readonly textUi = new TextUi();
  /** What this run last said to the user, for the `agent_end` notification
   * (see RunReply). */
  private readonly reply = new RunReply();

  constructor(
    private readonly host: SessionEventHost,
    private readonly onEvent: (event: ClientEvent) => void,
    /** Whether clients never receive the reply's text, so the card written
     * into it has to be cut out here (see SessionAgentOptions.uiFromText). */
    private readonly uiFromText: boolean,
  ) {}

  /** Follow the agent's events from now on. Called once the whole session is
   * wired: a listener that ran before the coordinators existed would read
   * them half-built. */
  listen(): void {
    this.host.agent.subscribe((event) => this.handleEvent(event));
  }

  /** Publish one event to the session's clients. */
  emit(event: ClientEvent): void {
    // A closed session has no surface: closing it aborts the run, and an
    // `agent_end` published from here would arrive after the tab that closed
    // it is gone — as a notification about a run nobody is watching.
    if (this.host.isClosed()) return;
    try {
      this.onEvent(event);
    } catch {
      // Event sink failures must not break the agent loop.
    }
  }

  /** Announce a message to clients (synthetic message_start/end so it renders
   * immediately). */
  announce(message: AgentMessage): void {
    this.emit({
      type: "message_start",
      sessionId: this.host.sessionId,
      message,
    });
    this.emit({ type: "message_end", sessionId: this.host.sessionId, message });
  }

  /** Forget the card and the reply of the message being taken back (see
   * SessionRuns.discardBrokenAppCard). */
  endTextUi(): void {
    if (this.uiFromText) this.textUi.end();
  }

  private handleEvent(event: AgentEvent): void {
    const host = this.host;
    // The two ends of a run have a step around the events: an idle
    // compaction must not splice a checkpoint into a run that is working,
    // and the gap since the newest LLM call starts when the run ends.
    if (event.type === "agent_start") {
      host.compaction.disarmIdle();
      // A reply belongs to the run that said it: `agent_end` carries what
      // this run last told the user, and a stale one would put an answer the
      // user already read in a notification. `agent_end` consumes it (at the
      // end of this method), so an end that closes no run — a session's abort
      // — says nothing.
      this.reply.reset();
    }
    if (event.type === "agent_end") host.interruptions.endRun();
    // A reply whose app card does not parse never becomes a message: it is
    // taken back before the reply is observed or persisted, and the model is
    // asked to write it again.
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      host.runs.discardBrokenAppCard(event.message)
    ) {
      return;
    }
    if (event.type === "message_end") this.reply.observe(event.message);
    // A routine's silent end is read from the view BEFORE runPrompt removes
    // the run (the removal happens after `prompt` resolves): the event says
    // so, and the notifiers skip it. A silent routine is the one run that is
    // entirely absent from the conversation, so a "finished" toast would be
    // the only thing it ever told the user.
    const quietRoutine =
      event.type === "agent_end" &&
      host.runs.routineSaidNothing(host.agent.state.messages);
    const translated = translateRunEvent(
      event,
      host.sessionId,
      this.uiFromText ? this.textUi : undefined,
      event.type === "agent_end" ? this.reply.gist() : undefined,
      quietRoutine,
    );
    for (const published of translated.events) this.emit(published);
    if (translated.modelError !== undefined) {
      host.runs.reportModelError(translated.modelError);
    }
    if (translated.persist === true) {
      host.transcript.persist(host.agent.state.messages);
    }
    if (translated.turnEnded !== undefined) {
      host.runs.turnEnded(translated.turnEnded);
    }
    if (event.type === "agent_end") {
      this.reply.reset();
      host.compaction.armIdle();
    }
  }
}
