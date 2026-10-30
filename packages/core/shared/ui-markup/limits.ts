/**
 * Frontend-safe shared helpers (see shared/mod.ts): pure functions and
 * constants with no runtime dependencies, bundled into the browser client.
 *
 * The UI markup an agent sends into the chat.
 *
 * A card the screen shows is written with a small custom tag language that
 * resembles HTML. It reads like JSX but is never executed as HTML: only the
 * tags listed here are understood, and scripts, CSS, event attributes and
 * URLs are refused.
 *
 * The same reading is used by the server (validating the markup a model
 * sends) and by the client (drawing the card). So that both always agree, it
 * is plain string processing: no DOM, no Node.js APIs.
 */

/**
 * Limits of the markup.
 *
 * The model writes this markup, so nothing unbounded may reach the screen:
 * every limit here stops it. Each value is "the largest amount that still
 * reads as that part" (a table cell or a flow node past it is unreadable on
 * screen).
 */
export const UI_MARKUP_LIMITS = {
  /** Length of the whole markup, in characters. */
  chars: 20_000,
  /** Nesting depth of the elements. Card > Form > Field > Option is the
   * deepest. */
  depth: 4,
  /** Blocks one card may hold. */
  blocks: 20,
  /** Length of one card title. */
  titleChars: 200,
  /** Length of one paragraph. */
  textChars: 4_000,
  /** Items one list may hold. */
  listItems: 50,
  /** Length of one list item. */
  listItemChars: 500,
  /** Rows of one table (the first row is the header). */
  tableRows: 50,
  /** Columns of one table. */
  tableColumns: 8,
  /** Length of one table cell. */
  tableCellChars: 200,
  /** Nodes of one flowchart. */
  flowNodes: 40,
  /** Edges of one flowchart. */
  flowEdges: 80,
  /** Length of a node label. */
  flowLabelChars: 60,
  /** Length of an edge label. */
  flowEdgeLabelChars: 60,
  /** Length of a node id. */
  nodeIdChars: 40,
  /** Number of options. */
  options: 12,
  /** Length of an option label. */
  optionLabelChars: 200,
  /** Length of an option description. */
  optionDescriptionChars: 300,
  /** Number of form fields. */
  fields: 12,
  /** Length of a field label. */
  fieldLabelChars: 200,
  /** Length of a field placeholder. */
  placeholderChars: 200,
  /** Length of the submit button label. */
  submitChars: 40,
  /** Number of options in a select. */
  selectOptions: 30,
} as const;
