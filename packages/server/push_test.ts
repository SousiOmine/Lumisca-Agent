import { assert, assertEquals } from "@std/assert";
import { createInMemorySettingsRepo } from "../core/settings/repo.ts";
import { PushSubscriptions } from "../core/notify/subscriptions.ts";
import { toBase64Url } from "@lumisca/core/shared";
import { buildPushNotification, createPushNotifier } from "./push.ts";

/** A fake core: the events it emits are the ones a test drives, and the
 * subscriptions are the real store's. */
function harness() {
  const settings = createInMemorySettingsRepo();
  const store = new PushSubscriptions(settings);
  const listeners = new Set<(event: never) => void>();
  let language: "ja" | "en" = "ja";
  const core = {
    subscribe(listener: (event: never) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSession: (id: string) =>
      id === "s1" ? { name: "リファクタ" } as never : undefined,
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
      sent.push(String((init?.headers as Record<string, string>)["urgency"]));
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
      questions: [{
        id: "q",
        question: "どちらにしますか?",
        header: "選択",
        options: [],
      }],
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
  assert(question.message.body.includes("リファクタ"));
  // The gist of the first question is what the toast shows.
  assert(question.message.body.includes("選択"), question.message.body);
  assertEquals(core, core);
});

Deno.test("an error notification names the session", () => {
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
  assertEquals(japanese.message.body, "「リファクタ」でエラーが発生しました");
  assertEquals(english.message.body, '"Refactor" stopped with an error');
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
    assertEquals(store.list().map((entry) => entry.endpoint), [alive.endpoint]);
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
