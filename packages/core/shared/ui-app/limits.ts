/**
 * Limits of the JSON UI spec.
 *
 * The model writes the spec into a chat message, so nothing unbounded may
 * reach the screen or the transcript. Each value is the largest amount that
 * still reads as a card in a conversation; a spec past it is a page, and a
 * page in a message buries the reply around it.
 */
export const UI_APP_LIMITS = {
  /** Length of the whole JSON, in characters. JSON is more verbose than a
   * compact tag language, so an app card gets room for a useful amount of
   * visible content without becoming a document. */
  chars: 48_000,
  /** Elements in the flat map, before repeats are expanded. */
  elements: 200,
  /** Nesting depth of the element tree. Screen > Card > Tabs > Tab > Row >
   * Button is already deep; past this the layout is burying content. */
  depth: 8,
  /** Children of one container. */
  children: 50,
  /** Blocks one card may draw after repeats are expanded. A card the parser
   * accepted must not turn into a page's worth of DOM at the client, and the
   * model cannot tell how large its data is. */
  expandedElements: 400,
  /** Items one `<Repeat>` may expand. */
  repeatItems: 100,
  /** Keys of the initial state. */
  stateKeys: 100,
  /** Serialized length of the initial state, in characters. */
  stateChars: 16_000,
  /** Length of one state key or element id. */
  keyChars: 60,
  /** Length of a state path (`/form/name`). */
  pathChars: 200,
  /** Length of one card title. */
  titleChars: 200,
  /** Length of the card description. */
  descriptionChars: 500,
  /** Length of one text prop. */
  textChars: 4_000,
  /** Length of one label, placeholder, unit or hint. */
  labelChars: 200,
  /** Options of one select. */
  selectOptions: 50,
  /** Items of one list. */
  listItems: 100,
  /** Length of one list item. */
  listItemChars: 500,
  /** Rows of one table, header excluded. */
  tableRows: 50,
  /** Columns of one table. */
  tableColumns: 8,
  /** Length of one table cell. */
  tableCellChars: 200,
  /** Nodes of one flowchart. */
  flowNodes: 40,
  /** Edges of one flowchart. */
  flowEdges: 80,
  /** Length of a flowchart node label or edge label. */
  flowLabelChars: 60,
  /** Length of a flowchart node id. */
  flowNodeIdChars: 40,
  /** Tabs of one tab bar. */
  tabs: 8,
} as const;
