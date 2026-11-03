/**
 * The translation layer between this app's messages and the Vercel AI SDK's:
 * the transcript as the SDK expects it, and the tool set the SDK executes.
 *
 * Kept apart from stream.ts (the transport) because it is a pure translation
 * between two shapes: no stream, no provider, no state. The SDK's generics
 * are the awkward part of this module, and they are easier to follow without
 * the streaming machinery in the same file.
 */
import { jsonSchema, tool } from "ai";
import type { AssistantContent, ModelMessage, ToolSet, UserContent } from "ai";
import type { AgentTool, Api, LlmMessage, Model } from "./types.ts";
import { toolResultTakesImages } from "./lang-model.ts";
import {
  imageFilePart,
  readToolOutput,
  toolDetails,
  type ToolImage,
  toolImages,
  toolModelOutput,
  type ToolOutput,
  toolResultOutput,
} from "./tool-envelope.ts";

/** The SDK shapes the converters index into: the two content unions, and the
 * provider-options record the reasoning flag goes into. */
type VercelAssistantParts = Exclude<AssistantContent, string>;
type VercelUserParts = Exclude<UserContent, string>;
type VercelProviderOptions = NonNullable<
  Parameters<typeof import("ai").streamText>[0]["providerOptions"]
>;

/** Normalize model-generated tool arguments to a plain record. Anything
 * non-object (including undefined) becomes `{}` so the transcript and the
 * UI never see a missing args object. */
export function toArgsRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

/** Convert Lumisca LLM messages to Vercel CoreMessage[] (v7 format). */
export function toCoreMessages(
  model: Model<Api>,
  messages: LlmMessage[],
): ModelMessage[] {
  const out: ModelMessage[] = [];
  const requiresReasoningContent =
    model.compat?.requiresReasoningContentOnAssistantMessages === true;
  // Tool images the provider's tool message cannot carry (see
  // toolResultTakesImages): they are handed over in one user message after
  // the tool results they belong to. Buffered until the run of tool results
  // ends, so a turn that called several tools in parallel keeps its tool
  // messages contiguous — providers read them as the direct answer to the
  // assistant turn, not as a sequence a user message may interrupt.
  let queuedImages: Array<{ toolName: string; images: ToolImage[] }> = [];
  const flushImages = () => {
    if (queuedImages.length === 0) return;
    out.push({
      role: "user",
      content: [
        {
          type: "text",
          text: queuedImages.map((entry) => `[image from ${entry.toolName}]`)
            .join("\n"),
        },
        ...queuedImages.flatMap((entry) => entry.images.map(imageFilePart)),
      ],
    });
    queuedImages = [];
  };
  for (const message of messages) {
    if (message.role === "toolResult") {
      // Tool results: Vercel v7 expects role "tool" with ToolResultPart[]
      const m = message as unknown as Record<string, unknown>;
      const toolCallId = String(m.toolCallId ?? "");
      const toolName = String(m.toolName ?? "");
      const isError = m.isError === true;
      const blocks = typeof m.content === "object" && Array.isArray(m.content)
        ? m.content as Array<Record<string, unknown>>
        : [];
      const text = blocks.length > 0
        ? blocks
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("\n")
        : String(m.content ?? "");
      // The tool's images only travel to a model that can see them. For any
      // other model the image analysis already replaced them (see
      // agent/image-analysis.ts); a block that survived a failed analysis
      // must not be sent — the provider would reject the picture it cannot
      // accept instead of reading the text around it.
      const images = (model.input ?? []).includes("image")
        ? toolImages(blocks.filter((b) => b.type === "image"))
        : [];
      const takesImages = !isError && toolResultTakesImages(model);
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName,
          output: toolResultOutput(
            text || "Tool completed.",
            images,
            isError,
            takesImages,
          ),
        }],
      });
      if (images.length > 0 && !takesImages) {
        queuedImages.push({ toolName, images });
      }
      continue;
    }
    // A non-tool message ends the run of tool results: the images that
    // still have to follow go out now, still right behind them.
    flushImages();
    if (typeof message.content === "string") {
      out.push({
        role: message.role,
        content: message.content,
        ...(message.role === "assistant" && requiresReasoningContent
          ? { providerOptions: emptyReasoningContentOption() }
          : {}),
      });
      continue;
    }
    // Build content parts: text + images (user), reasoning + text + tool-calls
    // (assistant). Models whose metadata requires reasoning_content must get
    // every prior thinking block back unchanged so interleaved tool use can
    // continue on the next request.
    const parts: (VercelAssistantParts[number] | VercelUserParts[number])[] =
      [];
    let hasReasoningContent = false;
    for (const block of message.content) {
      if (block.type === "text") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && requiresReasoningContent) {
        parts.push({ type: "reasoning", text: block.thinking });
        hasReasoningContent ||= block.thinking.length > 0;
      } else if (block.type === "image") {
        parts.push(imageFilePart(block));
      }
    }
    for (const block of message.content as unknown[]) {
      const b = block as { type?: string };
      if (b.type === "toolCall") {
        const tc = block as Record<string, unknown>;
        parts.push({
          type: "tool-call",
          toolCallId: String(tc.id ?? ""),
          toolName: String(tc.name ?? ""),
          // Vercel v7 uses `input` (not `args`) for tool-call arguments
          input: (tc.arguments as Record<string, unknown>) ?? {},
        });
      }
    }
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: parts.length > 0 ? parts as VercelAssistantParts : "",
        ...(requiresReasoningContent && !hasReasoningContent
          ? { providerOptions: emptyReasoningContentOption() }
          : {}),
      });
    } else {
      // A user message's parts are text and images only (the reasoning and
      // tool-call branches above belong to assistant messages).
      out.push({ role: message.role, content: parts as VercelUserParts });
    }
  }
  // A transcript that ends on tool results (the regular shape of a turn
  // that is about to continue) still owes their images.
  flushImages();
  return out;
}

/** Provider metadata used when an interleaved-reasoning API requires the
 * field on every historical assistant message, including turns whose stored
 * response has no thinking block. The compatible provider merges this into
 * the assistant wire object as `reasoning_content: ""`. */
export function emptyReasoningContentOption(): VercelProviderOptions {
  return { openaiCompatible: { reasoning_content: "" } };
}

/** Convert Lumisca AgentTools to Vercel Tool objects WITH execute functions,
 * so the AI SDK executes tools instead of the Agent doing it manually.
 * Tools without `execute` (edge case) are passed as schema-only.
 * Uses `inputSchema` (Vercel v7 property name), not `parameters`. */
export function toExecutableToolSet(
  tools: AgentTool[],
  signal?: AbortSignal,
): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    const inputSchema = jsonSchema(
      (t.parameters ?? { type: "object", properties: {} }) as never,
    );
    if (typeof t.execute === "function") {
      const exec = t.execute;
      // Cast through `never`: Vercel v7's tool() generic inference rejects
      // unknown-input tools with execute. The actual types are determined at
      // call time by the SDK, so `never` is safe here.
      set[t.name] = tool({
        description: t.description,
        inputSchema,
        execute: async (
          input: Record<string, unknown>,
          options: { toolCallId: string; abortSignal?: AbortSignal },
        ): Promise<ToolOutput> => {
          const prepared = t.prepareArguments
            ? t.prepareArguments(input)
            : input;
          // Prefer the SDK's per-tool abort signal (covers tool timeouts);
          // fall back to the request signal when the SDK provides none.
          const toolSignal = options.abortSignal ?? signal;
          const result = await exec(
            options.toolCallId,
            prepared as never,
            toolSignal,
          );
          return {
            text: result.content
              .filter((c): c is { type: "text"; text: string } =>
                c.type === "text"
              )
              .map((c) => c.text)
              .join("\n"),
            details: toolDetails(result.details),
            // Image blocks stay in the envelope (base64) instead of being
            // flattened away here: the transcript keeps them for the UI and
            // the image analysis, and the model gets them back as image
            // parts (see toolModelOutput and toCoreMessages).
            images: result.content
              .filter((c): c is {
                type: "image";
                data: string;
                mimeType: string;
              } => c.type === "image" && c.data !== "" && c.mimeType !== "")
              .map((c) => ({ data: c.data, mimeType: c.mimeType })),
          };
        },
        // The two audiences of a tool result are separated here: the part
        // above carries the details for the UI, this conversion decides
        // what the model sees (the text, plus the tool's images — the
        // details would be noise in the prompt).
        toModelOutput: ({ output }: { output?: unknown }) =>
          toolModelOutput(readToolOutput(output)),
      } as never);
    } else {
      set[t.name] = tool({ description: t.description, inputSchema } as never);
    }
  }
  return set;
}
