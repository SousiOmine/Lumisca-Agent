import { assert, assertEquals } from "@std/assert";
import {
  createModelProvider,
  MODEL_PROVIDER,
  modelLabelOf,
} from "./model-context.ts";

Deno.test("model context: publishes the model once, then only when it changes", () => {
  let model = { provider: "faux", modelId: "small", name: "Small" };
  const provider = createModelProvider({ model: () => model });
  assertEquals(provider.name, MODEL_PROVIDER);

  const first = provider.next();
  assertEquals(first.length, 1);
  const update = first[0]!;
  assertEquals(update.title, "Model: Small");
  assertEquals(update.body, "You are running on Small.");
  assertEquals(
    update.body.includes("replaces the earlier model"),
    false,
    "the first reading carries no replacement note",
  );
  assertEquals(update.state, { label: "Small" });

  // An unchanged model costs nothing more: the message is in the transcript.
  assertEquals(provider.next(), []);

  // A model switched mid-conversation (the point of the provider) publishes
  // the new one and says the earlier statement may no longer hold.
  model = { provider: "faux", modelId: "large", name: "Large" };
  const next = provider.next();
  assertEquals(next.length, 1);
  assertEquals(next[0]!.title, "Model: Large");
  assertEquals(next[0]!.body.includes("replaces the earlier model"), true);
  assertEquals(next[0]!.state, { label: "Large" });
});

Deno.test("model context: a model without a name falls back to its ids", () => {
  const provider = createModelProvider({
    model: () => ({ provider: "custom", modelId: "m1" }),
  });
  const update = provider.next()[0]!;
  assertEquals(update.title, "Model: custom/m1");
  assertEquals(
    modelLabelOf({ provider: "custom", modelId: "m1" }),
    "custom/m1",
  );
});

Deno.test("model context: an unknown model publishes nothing", () => {
  // A caller that cannot name the model must not publish an empty line: the
  // transcript would then say the session runs on nothing.
  const provider = createModelProvider({ model: () => undefined });
  assertEquals(provider.next(), []);
});

Deno.test("model context: rebase re-anchors to the last publication", () => {
  const model = { provider: "faux", modelId: "m", name: "M" };
  const provider = createModelProvider({ model: () => model });
  const published = provider.next()[0]!;

  // Reopening a conversation: the transcript already carries the line, so
  // the provider must stay silent.
  provider.rebase(published.state);
  assertEquals(provider.next(), []);

  // A rewind removed it: the next check republishes.
  provider.rebase(undefined);
  assertEquals(provider.next().length, 1);

  // An unreadable state republishes too (a fresh statement is harmless).
  provider.rebase("not a state");
  assertEquals(provider.next().length, 1);
});

Deno.test("model context: state is the label, never the body text", () => {
  const provider = createModelProvider({
    model: () => ({ provider: "faux", modelId: "m", name: "M" }),
  });
  const state = provider.next()[0]!.state as { label: string };
  // A long transcript must not pay for the same sentence twice: only what the
  // provider compares against is stored.
  assert(Object.keys(state).length === 1);
  assertEquals(state.label, "M");
});
