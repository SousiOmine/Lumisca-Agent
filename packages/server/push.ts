import type { ClientEvent, SessionInfo } from "@lumisca/core";
import {
  createLogger,
  type PushMessage,
  type PushSubscriptionRecord,
  sendPush,
  type VapidKeys,
} from "@lumisca/core";
import {
  type Locale,
  type MessageKey,
  notificationText,
  translate,
} from "@lumisca/core/shared";

const log = createLogger("push");

/** How long one message may take end to end (encryption plus the request).
 * A push service answers in well under a second; the limit is what keeps a
 * hung endpoint from holding the queue behind it. */
const SEND_TIMEOUT_MS = 10_000;

/** Longest session name a notification carries. The same cap the desktop
 * shell applies: a title the OS truncates mid-word reads as a broken app. */
const MAX_NAME_CHARS = 60;

/** Longest question text taken from the ask tool's first question. */
const MAX_QUESTION_CHARS = 80;

/** Longest hand-over reason taken from `vm_ask_user`. The agent explains
 * the request to the MODEL in up to 500 characters; a toast carries the
 * beginning of it, which is what says whether opening the app is urgent. */
const MAX_HANDOVER_CHARS = 120;

/** Longest reply a notification carries. One line of a toast: enough to
 * judge whether opening the app is worth it, short enough to read without
 * expanding it. The same cap the desktop notification applies (see
 * web/src/notify.ts), so the two describe one run the same way. */
const MAX_DETAIL_CHARS = 120;

/** What `push` events send: the message, and how the push service should
 * treat it (a blocked run wakes the device). */
export interface PushNotification {
  message: PushMessage;
  urgency: "high" | "normal";
}

/** The core events a notification is sent for. Everything else (text deltas,
 * tool traffic, `session_created`) is the UI's alone. */
export type NotifiableEvent = Extract<
  ClientEvent,
  {
    type:
      | "agent_end"
      | "question"
      | "session_error"
      | "handover"
      | "env_request";
  }
>;

/** Whether the event is one the installed app is notified about. A
 * hand-over is included: the run is blocked at the screen, and the user is
 * the only one who can release it — a message nobody sees is a run that
 * waits until the deadline. */
export function isNotifiable(
  event: ClientEvent,
): event is NotifiableEvent {
  return event.type === "agent_end" || event.type === "question" ||
    event.type === "session_error" || event.type === "handover" ||
    event.type === "env_request";
}

/** The notification one notifiable event produces. `name` is the display
 * name already resolved and capped by the caller. Pure, so the wording of
 * every event is asserted without a push service.
 *
 * The name is the TITLE and the message is the body: a phone shows the title
 * in bold, and the conversation it is about is what the user has to
 * recognize first. `notify.push.*` carries no name for that reason. */
export function buildPushNotification(
  event: NotifiableEvent,
  name: string,
  language: Locale,
): PushNotification {
  const tr = (key: MessageKey, params?: { [name: string]: string }) =>
    translate(language, key, params);
  switch (event.type) {
    case "agent_end": {
      // The reply is the body: "finished" alone does not say whether opening
      // the app is worth it, and a routine's result IS the answer. It is
      // markdown, and a phone's notification has no renderer, so it is read
      // as the words it decorates (the same conversion the desktop uses). A
      // run that said nothing the user can read (a silent turn, a card or
      // files without words) falls back to saying it finished.
      const reply = notificationText(event.reply, MAX_DETAIL_CHARS);
      return {
        message: {
          title: name,
          body: reply === "" ? tr("notify.push.finished") : reply,
          tag: `session:${event.sessionId}`,
        },
        urgency: "normal",
      };
    }
    case "question": {
      const first = event.questions[0];
      const gist = Array.from(
        first?.header?.trim() || first?.question.trim() || "",
      ).slice(0, MAX_QUESTION_CHARS).join("");
      return {
        message: {
          title: name,
          body: tr("notify.push.question", {
            detail: gist === "" ? "" : tr("notify.questionDetail", { gist }),
          }),
          // The same tag as the completion: the answer prompt replaces the
          // "finished" toast of the same session instead of stacking on it.
          tag: `session:${event.sessionId}`,
        },
        // The run is blocked until the user answers, so the device is woken.
        urgency: "high",
      };
    }
    case "session_error":
      return {
        message: {
          title: name,
          body: tr("notify.push.error"),
          tag: `session:${event.sessionId}`,
        },
        urgency: "normal",
      };
    case "handover": {
      const gist = Array.from(event.reason.trim()).slice(0, MAX_HANDOVER_CHARS)
        .join("");
      return {
        message: {
          title: name,
          body: tr("notify.push.handover", {
            detail: gist === "" ? "" : tr("notify.handoverDetail", { gist }),
          }),
          // The same tag as the completion: the request replaces the
          // "finished" toast of the same session instead of stacking on it.
          tag: `session:${event.sessionId}`,
        },
        // The run is blocked at the screen until the user acts (or the
        // deadline passes), so the device is woken.
        urgency: "high",
      };
    }
    case "env_request":
      return {
        message: {
          title: name,
          body: tr("notify.push.env", { variable: event.name }),
          // The same tag as the completion: the request replaces the
          // "finished" toast of the same session instead of stacking on it.
          tag: `session:${event.sessionId}`,
        },
        // The run is blocked on the dialog until the user types the value
        // (or declines), so the device is woken.
        urgency: "high",
      };
  }
}

/** The name a notification is titled with, capped.
 *
 * A stella conversation is an agent talking, so it is notified under the
 * AGENT's name: that is the name the user chose and the one the
 * conversation's header shows. The session row carries it too, but a
 * conversation opened before stella stopped generating titles still holds a
 * title made from its first message, and renaming the agent does not reach
 * the row — reading the agent is what cannot go stale. Code mode has no
 * agent, so its session's name is the answer there.
 *
 * Pure, so the rule is asserted without a push service. */
export function notificationName(
  session: SessionInfo | undefined,
  agent: { name: string } | undefined,
  language: Locale,
): string {
  const name = (agent?.name ?? session?.name ?? "").trim();
  const label = name === "" ? translate(language, "notify.sessionName") : name;
  return Array.from(label).slice(0, MAX_NAME_CHARS).join("");
}

/** The slice of the core the notifier needs. Narrow rather than the whole
 * core, so a test can drive it with the events it emits. */
export interface PushNotifierCore {
  subscribe(listener: (event: ClientEvent) => void): () => void;
  getSession(id: string): SessionInfo | undefined;
  /** A stella agent, for the name a conversation is notified under: the
   * user names the agent, and the conversation is that agent talking. */
  getStellaAgent(id: string): { name: string } | undefined;
  getLanguage(): Locale;
  listPushSubscriptions(): PushSubscriptionRecord[];
  pushVapidKeys(): Promise<VapidKeys>;
  forgetPushSubscriptions(endpoints: readonly string[]): void;
}

/** Notifications this server sends to installed PWAs.
 *
 * The events are the ones the desktop shell notifies on
 * (web/src/notify.ts): a run ended, the agent asked something, the screen
 * was handed over, a run stopped with an error. What differs is who decides
 * whether to show them — the service worker does, by looking for a visible
 * client of this app — because a server-side "is the page in front?" would
 * have to model every device's focus and would be wrong as soon as two are
 * open.
 *
 * Only this server's own events: a federated peer's arrive through
 * `fed.subscribe`, not `core.subscribe`, and the subscriptions stored here
 * belong to devices showing this origin.
 */
export interface PushNotifier {
  /** Send one notification to every stored subscription (the settings page's
   * test button). Answers how many the push service accepted. */
  sendTest(): Promise<number>;
  /** Stop listening for events and further deliveries. */
  dispose(): void;
}

export interface PushNotifierOptions {
  core: PushNotifierCore;
  /** Transport, so a test can answer without a push service. */
  fetch?: typeof fetch;
}

export function createPushNotifier(
  { core, fetch: fetchImpl = fetch }: PushNotifierOptions,
): PushNotifier {
  let disposed = false;

  /** The display name a notification is titled with (see
   * notificationName): the agent's for a stella conversation, the session's
   * name for everything else. */
  const nameOf = (sessionId: string): string => {
    const session = core.getSession(sessionId);
    const agent = session?.agentId === undefined
      ? undefined
      : core.getStellaAgent(session.agentId);
    return notificationName(session, agent, core.getLanguage());
  };

  const deliver = async (
    message: PushMessage,
    urgency: "high" | "normal",
  ): Promise<number> => {
    const subscriptions = core.listPushSubscriptions();
    if (subscriptions.length === 0) return 0;
    let keys: VapidKeys;
    try {
      keys = await core.pushVapidKeys();
    } catch (error) {
      // A corrupt stored pair must not take the server down with it: it is
      // logged, and the next send tries again.
      log.error(`VAPID keys are unusable: ${String(error)}`);
      return 0;
    }
    let accepted = 0;
    const gone: string[] = [];
    // Sequential: one installation's endpoints are few, and a burst of
    // parallel sends to one service is the shape that gets rate limited.
    for (const subscription of subscriptions) {
      if (disposed) break;
      const result = await sendPush(fetchImpl, keys, subscription, message, {
        urgency,
        timeoutMs: SEND_TIMEOUT_MS,
      });
      if (result.kind === "sent") {
        accepted++;
      } else if (result.kind === "gone") {
        gone.push(subscription.endpoint);
      } else {
        log.debug(`push send failed: ${result.status} ${result.detail}`);
      }
    }
    // Only after every send: rewriting the list while the loop reads it would
    // make the loop skip an entry.
    if (gone.length > 0) core.forgetPushSubscriptions(gone);
    return accepted;
  };

  const detach = core.subscribe((event) => {
    if (disposed) return;
    // Only the events with a notification; everything else (deltas, tool
    // traffic, `session_created`, which carries no id at all) is the UI's.
    if (!isNotifiable(event)) return;
    const built = buildPushNotification(
      event,
      nameOf(event.sessionId),
      core.getLanguage(),
    );
    // Fire and forget: a notification must never delay the event the UI is
    // already applying, and its failure is not the run's failure.
    void deliver(built.message, built.urgency).catch((error: unknown) => {
      log.debug(`push delivery failed: ${String(error)}`);
    });
  });

  return {
    sendTest: async () =>
      await deliver({
        title: "Lumisca",
        body: translate(core.getLanguage(), "settings.general.pushTestSent"),
        tag: "test",
      }, "normal"),
    dispose: () => {
      disposed = true;
      detach();
    },
  };
}
