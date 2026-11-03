/**
 * The output-language context: the app's language setting, published as a
 * transcript message instead of frozen into the system prompt.
 *
 * The reason it is a context at all: the language is a SETTING. In the prompt
 * it froze at session creation, so switching the app to English left every
 * open session answering in the old language.
 */
import { assertEquals } from "@std/assert";
import {
  createLanguageProvider,
  languageInstruction,
} from "./language-context.ts";

function providerWith(language: () => "ja" | "en") {
  return createLanguageProvider({ language });
}

Deno.test("language context: the first publication names the language", () => {
  const provider = providerWith(() => "ja");
  const updates = provider.next();
  assertEquals(updates.length, 1);
  assertEquals(updates[0]!.title, "Reply language: Japanese");
  assertEquals(updates[0]!.body, languageInstruction("ja"));
  assertEquals(updates[0]!.body.includes("Japanese"), true);
  // The rule says both halves: what to write, and the mistake to avoid.
  assertEquals(updates[0]!.body.includes("Do not switch"), true);
});

Deno.test("language context: unchanged language publishes nothing", () => {
  // A context is appended to the transcript, so an unchanged value must not
  // add a message on every run.
  const provider = providerWith(() => "ja");
  assertEquals(provider.next().length, 1);
  assertEquals(provider.next(), []);
  assertEquals(provider.next(), []);
});

Deno.test("language context: a changed setting replaces the rule", () => {
  // The point of the change: an open session follows the setting.
  let language: "ja" | "en" = "ja";
  const provider = providerWith(() => language);
  assertEquals(provider.next()[0]!.title, "Reply language: Japanese");
  language = "en";
  const updates = provider.next();
  assertEquals(updates.length, 1);
  assertEquals(updates[0]!.title, "Reply language: English");
  // The new publication says it supersedes the old one, so the agent does
  // not keep following a rule it remembers.
  assertEquals(
    updates[0]!.body.includes("This replaces the earlier language"),
    true,
  );
  assertEquals(updates[0]!.body.includes("English"), true);
});

Deno.test("language context: a reopened session does not repeat its rule", () => {
  // rebase() teaches the provider what the transcript already holds, so
  // reopening a session does not append the same line again.
  const published = providerWith(() => "ja").next()[0]!;
  const provider = providerWith(() => "ja");
  provider.rebase(published.state);
  assertEquals(provider.next(), []);
  // …and a different state still publishes.
  provider.rebase({ locale: "en" });
  assertEquals(provider.next()[0]!.title, "Reply language: Japanese");
});
