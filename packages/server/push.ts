import type { ClientEvent, SessionInfo } from "@lumisca/core";
import {
  createLogger,
  type PushMessage,
  type PushSubscriptionRecord,
  sendPush,
  type VapidKeys,
} from "@lumisca/core";
import { type Locale, type MessageKey, translate } from "@lumisca/core/shared";

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
  { type: "agent_end" | "question" | "session_error" }
>;

/** Whether the event is one the installed app is notified about. */
export function isNotifiable(
  event: ClientEvent,
): event is NotifiableEvent {
  return event.type === "agent_end" || event.type === "question" ||
    event.type === "session_error";
}

/** The notification one notifiable event produces. `name` is the session's
 * display name (already resolved and capped by the caller). Pure, so the
 * wording of every event is asserted without a push service. */
export function buildPushNotification(
  event: NotifiableEvent,
  name: string,
  language: Locale,
): PushNotification {
  const tr = (key: MessageKey, params?: { [name: string]: string }) =>
    translate(language, key, params);
  switch (event.type) {
    case "agent_end":
      return {
        message: {
          title: "Lumisca",
          body: tr("notify.agentFinished", { name }),
          tag: `session:${event.sessionId}`,
        },
        urgency: "normal",
      };
    case "question": {
      const first = event.questions[0];
      const gist = Array.from(
        first?.header?.trim() || first?.question.trim() || "",
      ).slice(0, MAX_QUESTION_CHARS).join("");
      return {
        message: {
          title: "Lumisca",
          body: tr("notify.question", {
            name,
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
          title: "Lumisca",
          body: tr("notify.sessionError", { name }),
          tag: `session:${event.sessionId}`,
        },
        urgency: "normal",
      };
  }
}

/** The slice of the core the notifier needs. Narrow rather than the whole
 * core, so a test can drive it with the events it emits. */
export interface PushNotifierCore {
  subscribe(listener: (event: ClientEvent) => void): () => void;
  getSession(id: string): SessionInfo | undefined;
  getLanguage(): Locale;
  listPushSubscriptions(): PushSubscriptionRecord[];
  pushVapidKeys(): Promise<VapidKeys>;
  forgetPushSubscriptions(endpoints: readonly string[]): void;
}

/** Notifications this server sends to installed PWAs.
 *
 * The events are the ones the desktop shell notifies on
 * (web/src/notify.ts): a run ended, the agent asked something, a run stopped
 * with an error. What differs is who decides whether to show them — the
 * service worker does, by looking for a visible client of this app — because
 * a server-side "is the page in front?" would have to model every device's
 * focus and would be wrong as soon as two are open.
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

  /** The display name of a session, capped. A stella agent's conversation
   * carries the agent's name already (the session is created with it), so one
   * read covers both modes. */
  const nameOf = (sessionId: string): string => {
    const name = core.getSession(sessionId)?.name.trim() ?? "";
    const label = name === ""
      ? translate(core.getLanguage(), "notify.sessionName")
      : name;
    return Array.from(label).slice(0, MAX_NAME_CHARS).join("");
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
    // Only the three events with a notification; everything else (deltas, tool
    // traffic, `session_created`, which carries no id at all) is the UI's.
    if (
      event.type !== "agent_end" && event.type !== "question" &&
      event.type !== "session_error"
    ) {
      return;
    }
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
