/**
 * `vm_env`: ask the user for an environment variable's value.
 *
 * The tool is the only way a secret reaches the machine without passing
 * through the conversation. It takes a NAME and returns a sentence — never a
 * value — because the whole point is that the model does not learn it: the
 * user types it into a card in the conversation, the server writes it into the
 * machine, and every later command has it as `$NAME`.
 *
 * Discoverable rather than preloaded (see the built-in `vm-env` skill): most
 * conversations never need one, and a tool definition kept in the context of
 * every turn for that is a cost with no gain. Main-only as well — the saved
 * value belongs to the machine, not to one agent's run, and a sub-agent
 * cannot put a request in front of the user.
 */
import { CoreError } from "../errors.ts";
import { TOOL_VM_ENV } from "../shared/mod.ts";
import {
  object,
  type SchemaObject,
  type SchemaString,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import { ENV_REQUEST_TIMEOUT_MS, type EnvRequestHub } from "./env-request.ts";
import { requireEnvName, type VmEnvStore } from "./env-store.ts";

/** The deadline as the model is told it, in whole minutes. */
const TIMEOUT_MINUTES = Math.round(ENV_REQUEST_TIMEOUT_MS / 60_000);

const envSchema: SchemaObject<{ name: SchemaString }> = object({
  name: string(
    "The environment variable's name, e.g. `OPENAI_API_KEY` (letters, " +
      "digits and _, not starting with a digit). The variable's value is " +
      "chosen by the user and never shown to you.",
  ),
});

export interface VmEnvToolOptions {
  requests: EnvRequestHub;
  /** Read to tell the card whether the name already has a value. */
  store: VmEnvStore;
}

/** Build `vm_env` for one stella session. */
export function createVmEnvTool(
  options: VmEnvToolOptions,
): Tool<typeof envSchema> {
  return {
    name: TOOL_VM_ENV,
    label: "VM Environment Variable",
    description:
      "Ask the user to enter the value of an environment variable, for a " +
      "program that needs a secret (an API key, token or password). A " +
      "card appears in the conversation for the user and this tool waits " +
      "until they enter it or decline; the run is blocked meanwhile. The " +
      "value is saved in the machine and from then on every command " +
      "(bash, async_bash) has it as $NAME — its value is never returned to " +
      "you, so use the variable rather than printing it. If nobody answers " +
      `within ${TIMEOUT_MINUTES} minutes the card closes and the tool ` +
      "returns without a value.",
    parameters: envSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const name = requireEnvName(params.name);
      const requests = options.requests;
      if (requests.pendingEnvRequest() !== null) {
        throw new CoreError(
          "The user is already being asked for an environment variable",
          "conflict",
        );
      }
      const existing = await options.store.has(name);
      const outcome = await requests.ask(_id, name, existing, signal);
      switch (outcome.kind) {
        case "set":
          return text(
            `The user entered a value for ${name}. It is saved in the ` +
              "machine: every command you run from now on has it as " +
              `$${name}. The value itself is not returned to you — pass the ` +
              "variable to the program, and do not print it into the " +
              "conversation.",
          );
        case "declined":
          return text(
            `The user did not enter a value for ${name}. Continue without ` +
              "it: say what cannot be done without the variable, and do not " +
              "immediately ask again.",
          );
        case "timed_out":
          return text(
            `The user did not answer within ${TIMEOUT_MINUTES} minutes, so ` +
              `no value was saved and the card closed. ${name} is not ` +
              "available: do what you can without it, or stop and say what " +
              "you still need. Calling this tool again starts a new wait.",
          );
      }
    },
  };
}

/** One tool result: a sentence the model reads, no value in it. */
function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }], details: {} };
}
