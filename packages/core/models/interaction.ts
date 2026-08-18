/**
 * Login-flow helpers shared by the server bridge and the CLI.
 *
 * Lumisca runs on Deno, where only the device-code OAuth flows of the
 * pi-ai SDK work (browser-callback flows depend on Node's http/crypto).
 * When a login flow offers a device-code method through a `select` prompt,
 * we answer it automatically so the Node-only option is never shown.
 */

/** Matches option ids/labels for the portable device-code method (e.g. the
 * OpenAI Codex option "Device code login (headless)"). */
const DEVICE_METHOD_RE = /(device|headless)/i;

/** The option id to auto-select when a login `select` prompt offers a
 * device-code method, or undefined when the flow has no such option (the
 * prompt is then forwarded to the user). */
export function autoAnswerSelect(
  options: readonly { id: string; label: string }[],
): string | undefined {
  return options.find(
    (o) => DEVICE_METHOD_RE.test(o.id) || DEVICE_METHOD_RE.test(o.label),
  )?.id;
}
