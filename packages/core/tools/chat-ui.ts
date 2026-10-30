/**
 * `chat_ui`: show a card in the chat.
 *
 * A card is the reply's presentation, not its data: a table of numbers, a
 * flow chart, or a question with buttons. The alternative — asking in
 * prose — loses the structure the answer already has, and a bare question
 * costs the user a typing round trip.
 *
 * The card is a small markup language rather than a JSON schema because the
 * markup is what the model writes most reliably: one `<Card>` with blocks
 * inside, validated server-side (a malformed card fails the call with the
 * line and column to fix) and parsed again in the browser to draw.
 *
 * A Choice or Form is answered by the user clicking, and the click arrives
 * as their next MESSAGE, not as this tool's result. That is why the tool
 * returns immediately: the card is shown, the turn ends, and the user's
 * answer starts the next one.
 */
import { CoreError } from "../errors.ts";
import { parseUiMarkup, TOOL_CHAT_UI } from "../shared/mod.ts";
import { object, string, type Tool, type ToolResult } from "./schema.ts";

const chatUiSchema = object({
  markup: string(
    "One <Card> of UI markup, built from the tags below",
  ),
});

/** What the tool's arguments look like once validated. */
export interface ChatUiParams {
  markup: string;
}

/**
 * The description is one fixed string: it is sent with every request, so it
 * must stay cache-friendly (no counts, no examples that change) and small.
 * It documents the whole language because the model has no other reference
 * for it.
 */
const DESCRIPTION = [
  "Show a card in the chat: text, a list, a table, a flow chart, or a question with choices.",
  'markup is one <Card title="..."> with Text, List, Table, Flow, Choice and Form blocks inside it.',
  "<Text>paragraph</Text>; <List ordered><Item>one</Item></List>; <Table><Row><Cell>head</Cell><Cell>head</Cell></Row></Table> (the first row is the header).",
  '<Flow><Node id="a" shape="box|round|diamond|pill">Start</Node><Edge from="a" to="b" label="yes" dashed /></Flow>.',
  '<Choice multiple><Option description="why">Label</Option></Choice>; <Form submit="Send"><Field label="Name" type="text|number|select|checkbox" required placeholder="..."><Option>a choice for select</Option></Field></Form>.',
  "Use at most one Choice or Form per card. Write boolean attributes without a value, and attribute values in double quotes.",
  "Escape <, > and & in text as &lt;, &gt; and &amp;.",
  "Clicking an option sends its label as the user's next message; the user can click only after your turn ends. Do not repeat the same question in your text.",
].join(" ");

/** Build `chat_ui`. Stateless: the card lives in the transcript as the
 * call's arguments, so a reload draws it again with no server state. */
export function createChatUiTool(): Tool<typeof chatUiSchema> {
  return {
    name: TOOL_CHAT_UI,
    label: "Chat UI",
    description: DESCRIPTION,
    parameters: chatUiSchema,
    execute: (_id, params): Promise<ToolResult> => {
      const parsed = parseUiMarkup(params.markup);
      if (!parsed.ok) {
        throw new CoreError(
          `Invalid UI markup: ${parsed.problem}`,
          "invalid",
        );
      }
      return Promise.resolve({
        content: [{
          type: "text",
          text:
            "The card is shown in the chat. When the user clicks an option, " +
            "its label arrives as a new user message.",
        }],
        details: { blocks: parsed.view.blocks.length },
      });
    },
  };
}
