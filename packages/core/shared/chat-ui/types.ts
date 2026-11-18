/**
 * The shapes a chat message is split into: its prose and the app cards
 * written into it.
 *
 * An app card is a fenced block whose info string is `ui` and whose body is
 * the JSON spec (see `../ui-app/`). It is part of the message, so a reply
 * can say something, show an app, and say more after it. The flowchart
 * types live here too: the screen's `Flow` component draws the same block
 * the `Flow` component uses, and its layout is a pure function of these
 * shapes.
 */

/** A paragraph of the reply. */
export type UiTextSegment = {
  readonly type: "text";
  readonly text: string;
};

/** One app card, as the JSON between its fence's delimiters. */
export type UiAppSegment = {
  readonly type: "app";
  readonly json: string;
};

/** One piece of a message, in the order the agent wrote it. */
export type UiSegment = UiTextSegment | UiAppSegment;

/** Shape of a flowchart node. */
export type FlowShape = "box" | "round" | "diamond" | "pill";

/** One flowchart node. The id is how the edges name it. */
export type FlowNode = {
  readonly id: string;
  readonly label: string;
  readonly shape: FlowShape;
};

/** One flowchart edge. */
export type FlowEdge = {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  readonly dashed: boolean;
};

/** A flowchart. The screen places the nodes. */
export type FlowBlock = {
  readonly type: "flow";
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
};
