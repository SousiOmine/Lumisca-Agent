import type { CodeStoreRepo } from "../code-execution/store.ts";
import type {
  CodeRunOutcome,
  CodeRuntime,
  CodeToolCall,
  CodeToolImage,
} from "../code-execution/types.ts";
import { errorMessage } from "../errors.ts";
import {
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolContentBlock,
  type ToolResult,
} from "../ports/tool.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import {
  type AttachmentRef,
  attachmentsOfDetails,
  type ChatMessage,
  chatMessageOfDetails,
  TOOL_CHAT_ATTACH,
  TOOL_EXECUTE,
  TOOL_SEND_CHAT,
} from "../shared/mod.ts";
import type { ToolCatalog } from "./catalog.ts";
import { composeScriptResult } from "./js-sandbox.ts";
import { safetyBlockResult } from "./safety.ts";
import { truncate, truncatedNote } from "./truncate.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
/** Longest one program may run. A program holds the run it belongs to, and
 * it can wait on tools that ask the user (`ask`, `vm_ask_user`), so the cap
 * has to be generous — but a loop that never ends must end somewhere. */
const MAX_TIMEOUT_MS = 600_000;
/** Tool calls one program may make. A loop over a directory listing is
 * normal; a thousand calls is a runaway program, and each one costs a
 * safety check, a transcript entry in the store and time the model waited
 * for. */
const MAX_CALLS = 50;
/** Images forwarded from nested calls. A program cannot read an image, so
 * the only reason to carry one is for the model to look at it afterwards;
 * three is enough for a screenshot sequence and small enough that the
 * result stays a result. */
const MAX_FORWARDED_IMAGES = 3;
/** Text one program may collect from its tools. The outputs are already
 * capped per call; this bounds what a loop can accumulate in the sandbox's
 * memory before the program ends. */
const MAX_TOTAL_TEXT_CHARS = 4 * 1024 * 1024;

/** One nested call, as the outcome reports it to the model and the UI. */
interface CallRecord {
  name: string;
  ms: number;
  ok: boolean;
}

const executeSchema = object({
  code: string(
    "A JavaScript/TypeScript program. A top-level `return` gives the " +
      "result; `await tools.<name>(args)` runs a tool.",
  ),
  timeout: optional(
    integer("Timeout in milliseconds (default 120000)", {
      min: 1000,
      max: MAX_TIMEOUT_MS,
    }),
  ),
});

const DESCRIPTION =
  "Run one JavaScript/TypeScript program that uses this session's tools. " +
  "`tools.<name>(args)` runs a tool and resolves to its text result; a tool " +
  "that fails throws, so a `try` around it is how a program survives one " +
  "failure. The tools declared in the system prompt are available without a " +
  "search; `tools.tool_search({ query })` finds the rest and returns their " +
  "descriptions and argument schemas. No other tool is attached to this " +
  "conversation: files, shell, web, MCP and the rest are all reached from " +
  "here.\n\n" +
  "The program's return value and its console output are the result. " +
  "Everything else stays in the script, which is the point: a job that " +
  "takes twenty calls costs one turn's context. Return what the answer " +
  "needs, not the raw tool output.\n\n" +
  "Small JSON values survive between calls: `store(key, value)` writes one, " +
  "`load(key)` reads one, and `store(key, undefined)` deletes it. Writes are " +
  "kept only when the program succeeds. Each value is at most 256 KiB and the " +
  "whole store at most 1 MiB.\n\n" +
  `Limits: ${MAX_CALLS} tool calls per program; \`timeout\` in milliseconds ` +
  `(default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). Up to ` +
  `${MAX_FORWARDED_IMAGES} images a tool returns reach the conversation; a ` +
  "program cannot look at one.";

export interface ExecuteToolOptions {
  /** Every tool the session may run, preloaded and discoverable alike. */
  catalog: ToolCatalog;
  /** Where the program runs: this server, or a stella machine. */
  runtime: CodeRuntime;
  /** Working directory recorded with the safety verdict (the approval key);
   * the machine's folder for a stella session, the process cwd otherwise. */
  cwd: string;
  /** The fast-model check on the program before it runs. The tools a
   * program calls are checked by their own rules as usual. */
  safety?: CommandSafety;
  /** The session's store: small JSON values a program keeps between calls. */
  store: CodeStoreRepo;
  /** The session whose store the program uses. */
  sessionId: string;
}

/**
 * The one tool the scripting tool call attaches to the model.
 *
 * Everything the model can do to the session happens through a nested call,
 * so this tool owns the bookkeeping that must hold wherever the program
 * runs: the safety verdict, the call cap, the images forwarded, and the
 * text the transcript keeps.
 */
export function createExecuteTool(
  options: ExecuteToolOptions,
): Tool<typeof executeSchema> {
  return {
    name: TOOL_EXECUTE,
    label: "Execute",
    description: DESCRIPTION,
    parameters: executeSchema,
    async execute(toolCallId, params, signal): Promise<ToolResult> {
      // The program is judged as JavaScript in the same terms `eval` uses:
      // same permission level, so the approvals the user already gave apply
      // to it too. A blocked program is a result, not a tool failure.
      const blocked = await safetyBlockResult(
        options.safety,
        "eval",
        params.code,
        options.cwd,
        {
          prefix: "[error]\n",
          fallbackReason: "The program was judged unsafe.",
        },
      );
      if (blocked !== undefined) return blocked;

      const timeoutMs = Math.max(1000, params.timeout ?? DEFAULT_TIMEOUT_MS);
      const deadline = Date.now() + timeoutMs;
      const store = options.store.begin(options.sessionId);
      const calls: CallRecord[] = [];
      const images: CodeToolImage[] = [];
      let textChars = 0;
      // What the program sent the user, kept for the transcript: a nested
      // `send_chat` / `chat_attach` writes its words and files into its own
      // result's `details`, and this result is the only row the store keeps
      // of the program. Without carrying them here the message would reach
      // the user nowhere: the conversation projects a tool result's details
      // (agent/stella-stream.ts), and the code-mode transcript draws the
      // attachments of one (web's ConversationTurn).
      const sent: ChatMessage[] = [];
      const attached: AttachmentRef[] = [];

      const call: CodeToolCall = async (name, args) => {
        if (calls.length >= MAX_CALLS) {
          throw new Error(
            `This program already ran ${MAX_CALLS} tool calls, the limit ` +
              "for one program. Do the rest in another execute call.",
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `The program exceeded its ${timeoutMs}ms limit. Raise \`timeout\` ` +
              "or do the remaining work in another execute call.",
          );
        }
        signal?.throwIfAborted();
        const startedAt = Date.now();
        try {
          const result = await options.catalog.call(
            `${toolCallId}.${calls.length + 1}`,
            name,
            args,
            signal,
          );
          const text = textOf(result.content);
          textChars += text.length;
          if (textChars > MAX_TOTAL_TEXT_CHARS) {
            throw new Error(
              `This program collected more than ${MAX_TOTAL_TEXT_CHARS} ` +
                "characters of tool output. Keep only what you need in the " +
                "script, or split the work.",
            );
          }
          const returned = imagesOf(result.content);
          for (const image of returned) {
            if (images.length < MAX_FORWARDED_IMAGES) images.push(image);
          }
          if (name === TOOL_SEND_CHAT) {
            const message = chatMessageOfDetails(result.details);
            if (message !== undefined) sent.push(message);
          } else if (name === TOOL_CHAT_ATTACH) {
            attached.push(...attachmentsOfDetails(result.details));
          }
          calls.push({ name, ms: Date.now() - startedAt, ok: true });
          return { text, images: returned };
        } catch (error) {
          calls.push({ name, ms: Date.now() - startedAt, ok: false });
          // A tool failure is the script's exception: rethrown as an Error
          // so `try`/`catch` in the program sees a message, not a value.
          throw error instanceof Error ? error : new Error(errorMessage(error));
        }
      };

      let outcome: CodeRunOutcome | undefined;
      let failure: unknown;
      try {
        outcome = await options.runtime.run(params.code, {
          call,
          timeoutMs,
          store,
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (error) {
        failure = error;
      }

      let storeFailure: unknown;
      if (failure === undefined) {
        try {
          store.commit();
        } catch (error) {
          storeFailure = error;
        }
      }
      const text = composeResult(outcome, failure, calls, storeFailure);
      const content: ToolContentBlock[] = [{ type: "text", text }];
      for (const image of images) {
        content.push({
          type: "image",
          data: image.data,
          mimeType: image.mimeType,
        });
      }
      return {
        content,
        details: {
          timeoutMs,
          calls: calls.map((entry) => ({
            name: entry.name,
            ms: entry.ms,
            ok: entry.ok,
          })),
          ...(sent.length === 0 ? {} : { sent }),
          ...(attached.length === 0 ? {} : { attachments: attached }),
          ...(failure === undefined ? {} : { error: true }),
          ...(storeFailure === undefined ? {} : { storeError: true }),
        },
      };
    },
  };
}

/** The text blocks of a nested result, joined the way a tool result reads. */
function textOf(content: readonly ToolContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n\n");
}

function imagesOf(content: readonly ToolContentBlock[]): CodeToolImage[] {
  const images: CodeToolImage[] = [];
  for (const block of content) {
    if (block.type !== "image") continue;
    images.push({ data: block.data, mimeType: block.mimeType });
  }
  return images;
}

/** The transcript text: what the program printed and returned, a failure if
 * it ended in one, and which tools ran. The call list is what lets the
 * model (and the reader) tell a program that did nothing from one that did
 * everything. */
function composeResult(
  outcome: CodeRunOutcome | undefined,
  failure: unknown,
  calls: readonly CallRecord[],
  storeFailure?: unknown,
): string {
  const parts: string[] = [];
  if (outcome !== undefined) {
    const script = composeScriptResult(outcome.output, outcome.value);
    if (script.length > 0) parts.push(script);
  }
  if (failure !== undefined) parts.push(`[error]\n${errorMessage(failure)}`);
  if (storeFailure !== undefined) {
    parts.push(
      "[error]\nThe program finished, but its store writes were not saved: " +
        errorMessage(storeFailure),
    );
  }
  if (calls.length > 0) parts.push(`[calls]\n${callSummary(calls)}`);
  const joined = parts.length === 0 ? "(no output)" : parts.join("\n\n");
  const { text, truncated } = truncate(joined);
  return truncated ? text + truncatedNote("output") : joined;
}

/** `read ×2 (7ms), bash (240ms) failed` — one entry per tool, so a long
 * program stays one line. */
function callSummary(calls: readonly CallRecord[]): string {
  const byName = new Map<
    string,
    { count: number; ms: number; failed: boolean }
  >();
  for (const call of calls) {
    const entry = byName.get(call.name) ?? {
      count: 0,
      ms: 0,
      failed: false,
    };
    entry.count++;
    entry.ms += call.ms;
    entry.failed ||= !call.ok;
    byName.set(call.name, entry);
  }
  return [...byName]
    .map(
      ([name, entry]) =>
        `${name} ×${entry.count} (${entry.ms}ms)${
          entry.failed ? " failed" : ""
        }`,
    )
    .join(", ");
}
