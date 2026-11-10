/**
 * The card markup as the MODEL reads it.
 *
 * A card is part of the reply, not a tool call: the model writes it inside a
 * fenced block tagged `card`, and the screen draws it in place (see
 * ./segments.ts). This text is sent in the system prompt of every session
 * that can draw one, so it states the grammar once, in the shape a model can
 * copy, and nothing that changes per card. The parser in ./build.ts is the
 * authority — a tag this text does not name is refused there, and a tag it
 * names is accepted — so the two are edited together
 * (ui-markup_test.ts fails when a tag is missing here).
 */
export const CARD_HELP: string = [
  "A card is written into your reply, not sent by a tool call: put it in a fenced code block whose info string is `card`, on its own lines, and the app draws the card where the block sits. The rest of the reply is ordinary markdown, so words may come before and after the card.",
  'The block holds one <Card title="..."> with Text, List, Table, Flow, Metric, Choice, Form, Stack, Columns, Grid, Repeat and If blocks inside it.',
  '<Text>paragraph</Text>; <List ordered><Item>one</Item></List>; <Table><Row><Cell>head</Cell><Cell>head</Cell></Row></Table> (the first row is the header); <Metric label="Open" value="12" unit="件" hint="+3 today" />.',
  '<Flow><Node id="a" shape="box|round|diamond|pill">Start</Node><Edge from="a" to="b" label="yes" dashed /></Flow>.',
  '<Choice multiple layout="list|row"><Option description="why">Label</Option></Choice>; <Form submit="Send"><Field label="Name" type="text|number|select|checkbox" required placeholder="..."><Option>a choice for select</Option></Field></Form>.',
  '<Stack gap="s|m|l">...</Stack> puts blocks one above another; <Columns gap="..."> side by side (they go one above another on a narrow screen); <Grid columns="1-4"> in a grid.',
  'A card may start with <Data>{"items":[{"name":"prod","load":81}]}</Data>: one JSON object whose fields are read as $data.items. <Repeat over="items"> draws its blocks once per item, where $item.name and $index are that item; <If test="$item.load" eq="81"> (or ne="0") draws only when the field matches what you name (it sits inside a repeat only, and repeats never nest).',
  "Read values with $data.field, $item.field and $index; write $$ for a dollar sign. Every reference must name a field that <Data> (or every item) really has, so a typo is refused instead of drawn as a blank.",
  "At most one Choice or Form per card. Write boolean attributes without a value, and attribute values in double quotes.",
  "Escape <, > and & in text as &lt;, &gt; and &amp;; inside <Data> write plain JSON, but no </Data>.",
  "Clicking an option sends its label as the user's next message; the user can click only after your turn ends, so end the turn after showing a question.",
].join(" ");
