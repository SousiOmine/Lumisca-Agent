import { toBase64Url } from "@lumisca/core/shared";
import { assert, assertEquals } from "@std/assert";
import { PushSubscriptions } from "../core/notify/subscriptions.ts";
import { createInMemorySettingsRepo } from "../core/settings/repo.ts";
import {
  buildPushNotification,
  createPushNotifier,
  isNotifiable,
  notificationName,
} from "./push.ts";

/** A fake core: the events it emits are the ones a test drives, and the
 * subscriptions are the real store's. "s1" is a code-mode session; "s2" is a
 * stella conversation whose session row carries a title generated from its
 * first message (the state a conversation opened by an older build is in). */
function harness() {
  const settings = createInMemorySettingsRepo();
  const store = new PushSubscriptions(settings);
  const listeners = new Set<(event: never) => void>();
  let language: "ja" | "en" = "ja";
  const sessions: Record<string, unknown> = {
    s1: { id: "s1", name: "リファクタ" },
    s2: {
      id: "s2",
      name: "最初のメッセージの題名",
      stella: true,
      agentId: "a1",
    },
  };
  const core = {
    subscribe(listener: (event: never) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSession: (id: string) => sessions[id] as never,
    getStellaAgent: (id: string) =>
      id === "a1" ? ({ name: "朝の番人" } as never) : undefined,
    getLanguage: () => language,
    listPushSubscriptions: () => store.list(),
    pushVapidKeys: () => store.vapidKeys(),
    forgetPushSubscriptions: (endpoints: readonly string[]) =>
      store.removeEndpoints(endpoints),
  };
  return {
    core,
    store,
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event as never);
    },
    setLanguage: (next: "ja" | "en") => {
      language = next;
    },
  };
}

async function subscriber(endpoint = "https://push.example/a") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return {
    endpoint,
    keys: {
      p256dh: toBase64Url(
        new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
      ),
      auth: toBase64Url(new Uint8Array(16).fill(2)),
    },
  };
}

/** Wait until a fire-and-forget delivery has reached the point the assertion
 * is about. Delivery encrypts (several WebCrypto awaits) before it fetches, so
 * a fixed sleep is a race under a parallel test run; polling for the observed
 * effect is not. */
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

Deno.test("a finished run notifies every subscription", async () => {
  const { core, store, emit } = harness();
  await store.add(await subscriber("https://push.example/a"));
  await store.add(await subscriber("https://push.example/b"));
  const sent: string[] = [];
  const notifier = createPushNotifier({
    core,
    fetch: (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push(String(headers["urgency"]));
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  });
  try {
    emit({ type: "agent_end", sessionId: "s1" });
    await waitUntil(() => sent.length >= 2);
    assertEquals(sent, ["normal", "normal"]);
  } finally {
    notifier.dispose();
  }
});

Deno.test("a question is urgent and replaces the completion toast", () => {
  // The same `tag` is what makes the OS replace rather than stack: an answer
  // prompt arriving after "finished" is the newer, more useful message.
  const { core } = harness();
  const question = buildPushNotification(
    {
      type: "question",
      sessionId: "s1",
      toolCallId: "t1",
      questions: [
        {
          id: "q",
          question: "どちらにしますか?",
          header: "選択",
          options: [],
        },
      ],
    },
    "リファクタ",
    "ja",
  );
  const finished = buildPushNotification(
    { type: "agent_end", sessionId: "s1" },
    "リファクタ",
    "ja",
  );
  assertEquals(question.urgency, "high");
  assertEquals(question.message.tag, finished.message.tag);
  // The phone shows the title in bold: the conversation is what the user
  // has to recognize first.
  assertEquals(question.message.title, "リファクタ");
  // The gist of the first question is what the toast shows.
  assert(question.message.body.includes("選択"), question.message.body);
  assertEquals(core, core);
});

Deno.test("a hand-over is urgent and carries the reason", () => {
  // The run is blocked AT THE SCREEN and only the user can release it. A
  // notification that says nothing about why is one the user cannot act
  // on, and one that is not urgent is a run that waits for the deadline.
  const event = {
    type: "handover" as const,
    sessionId: "s1",
    toolCallId: "t1",
    reason: "ログインフォームには本人しか知らないパスワードが必要です",
    instructions: null,
    expiresAt: Date.now() + 15 * 60_000,
  };
  const handover = buildPushNotification(event, "リファクタ", "ja");
  const finished = buildPushNotification(
    { type: "agent_end", sessionId: "s1" },
    "リファクタ",
    "ja",
  );
  assertEquals(handover.urgency, "high");
  // Same tag as the completion: the request replaces that toast instead of
  // stacking on it.
  assertEquals(handover.message.tag, finished.message.tag);
  assertEquals(handover.message.title, "リファクタ");
  assert(
    handover.message.body.includes("本人しか知らないパスワード"),
    handover.message.body,
  );

  const english = buildPushNotification(event, "Refactor", "en");
  assert(
    english.message.body.includes("waiting for you at the screen"),
    english.message.body,
  );
  assertEquals(isNotifiable(event), true);
});

Deno.test("an error notification is titled with the name", () => {
  const japanese = buildPushNotification(
    { type: "session_error", sessionId: "s1", message: "boom" },
    "リファクタ",
    "ja",
  );
  const english = buildPushNotification(
    { type: "session_error", sessionId: "s1", message: "boom" },
    "Refactor",
    "en",
  );
  assertEquals(japanese.message.title, "リファクタ");
  assertEquals(japanese.message.body, "エラーが発生しました");
  assertEquals(english.message.title, "Refactor");
  assertEquals(english.message.body, "Stopped with an error");
});

Deno.test("a finished run carries its reply", () => {
  // "Finished" alone does not say whether opening the app is worth it: the
  // answer is what the notification is for.
  const finished = buildPushNotification(
    {
      type: "agent_end",
      sessionId: "s2",
      reply: "## デプロイは緑\n\n問題はありません。",
    },
    "朝の番人",
    "ja",
  );
  assertEquals(finished.message.title, "朝の番人");
  // One line of the words: a toast has room for the first sentence, not for
  // markdown blocks, and no renderer to hide their marks.
  assertEquals(finished.message.body, "デプロイは緑 問題はありません。");
  assertEquals(finished.urgency, "normal");
});

Deno.test("a finished run with nothing to show says it finished", () => {
  // A silent turn, or a message that carried only a card or files: there are
  // no words to put in the body, so the wording says the run is done.
  for (const reply of [undefined, "", "   \n "]) {
    const finished = buildPushNotification(
      reply === undefined
        ? { type: "agent_end", sessionId: "s1" }
        : { type: "agent_end", sessionId: "s1", reply },
      "リファクタ",
      "ja",
    );
    assertEquals(finished.message.body, "処理が完了しました");
  }
});

Deno.test("a long reply is cut to one line of a toast", () => {
  const finished = buildPushNotification(
    { type: "agent_end", sessionId: "s1", reply: "あ".repeat(300) },
    "リファクタ",
    "ja",
  );
  assertEquals(Array.from(finished.message.body).length, 120);
});

Deno.test("a stella conversation is notified under its agent's name", () => {
  // The session row can hold a title generated from the first message (an
  // older conversation) or a name the agent no longer has; the agent is what
  // the user recognizes, and the header shows it too.
  const { core } = harness();
  assertEquals(
    notificationName(core.getSession("s2"), core.getStellaAgent("a1"), "ja"),
    "朝の番人",
  );
  // An agent that cannot be read (deleted, or a build that had no agents)
  // falls back to the row rather than losing the name.
  assertEquals(
    notificationName(core.getSession("s2"), undefined, "ja"),
    "最初のメッセージの題名",
  );
  // Code mode has no agent: the session's own name.
  assertEquals(
    notificationName(core.getSession("s1"), undefined, "ja"),
    "リファクタ",
  );
  // A session nobody can name is still named by the catalogue, not blank:
  // the title is the only thing a phone shows in bold.
  assertEquals(notificationName(undefined, undefined, "ja"), "セッション");
  assertEquals(notificationName(undefined, undefined, "en"), "Session");
});

Deno.test("a gone endpoint is forgotten after one failure", async () => {
  // 410 means the browser threw the subscription away. Keeping it would pay
  // for the same failure on every later event.
  const { core, store, emit } = harness();
  const alive = await subscriber("https://push.example/alive");
  const dead = await subscriber("https://push.example/dead");
  await store.add(alive);
  await store.add(dead);
  const notifier = createPushNotifier({
    core,
    fetch: (input) =>
      Promise.resolve(
        new Response(null, {
          status: String(input).endsWith("/dead") ? 410 : 201,
        }),
      ),
  });
  try {
    emit({ type: "agent_end", sessionId: "s1" });
    await waitUntil(() => store.list().length === 1);
    assertEquals(
      store.list().map((entry) => entry.endpoint),
      [alive.endpoint],
    );
  } finally {
    notifier.dispose();
  }
});

Deno.test("a transient failure keeps the subscription for the next try", async () => {
  const { core, store, emit } = harness();
  const endpoint = await subscriber();
  await store.add(endpoint);
  let attempts = 0;
  const notifier = createPushNotifier({
    core,
    fetch: () => {
      attempts++;
      return Promise.resolve(new Response("busy", { status: 429 }));
    },
  });
  try {
    emit({ type: "agent_end", sessionId: "s1" });
    await waitUntil(() => attempts === 1);
    assertEquals(store.list().length, 1);
  } finally {
    notifier.dispose();
  }
});

Deno.test("events nobody is notified about send nothing", async () => {
  const { core, store, emit } = harness();
  await store.add(await subscriber());
  let attempts = 0;
  const notifier = createPushNotifier({
    core,
    fetch: () => {
      attempts++;
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  });
  try {
    emit({ type: "message_delta", sessionId: "s1", delta: "x" });
    emit({
      type: "tool_start",
      sessionId: "s1",
      toolCallId: "t",
      toolName: "bash",
      args: {},
    });
    emit({ type: "session_created", session: { id: "s2" } });
    // Nothing is sent: give a delivery that would exist time to appear, then
    // assert that none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(attempts, 0);
  } finally {
    notifier.dispose();
  }
});

Deno.test("a disposed notifier stops sending", async () => {
  const { core, store, emit } = harness();
  await store.add(await subscriber());
  let attempts = 0;
  const notifier = createPushNotifier({
    core,
    fetch: () => {
      attempts++;
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  });
  notifier.dispose();
  emit({ type: "agent_end", sessionId: "s1" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(attempts, 0);
});

Deno.test("the test button reports how many were accepted", async () => {
  const { core, store } = harness();
  await store.add(await subscriber("https://push.example/a"));
  await store.add(await subscriber("https://push.example/b"));
  const notifier = createPushNotifier({
    core,
    fetch: (input) =>
      Promise.resolve(
        new Response(null, {
          status: String(input).endsWith("/b") ? 410 : 201,
        }),
      ),
  });
  try {
    assertEquals(await notifier.sendTest(), 1);
    // The dead one is gone, so a second test reaches only the live one.
    assertEquals(store.list().length, 1);
  } finally {
    notifier.dispose();
  }
});
