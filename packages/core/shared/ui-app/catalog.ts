/**
 * The components an app card may use, and the props each one accepts.
 *
 * This is the single vocabulary the parser, the renderer and the model's
 * guide share. A component that is not here cannot be drawn, and a prop that
 * is not here is refused rather than ignored: a typo must not become a
 * silently missing control. The renderer's registry is compared with this
 * list by a test, so the two cannot drift.
 *
 * Props are data, not code. A prop marked `expression` may be a `$…` value;
 * a prop marked `bind` is an input's value and must be `$bindState` or
 * `$bindItem`. Everything else is a literal of its kind.
 */

/** The literal kind of one prop. */
export type UiAppPropKind =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "array"
  | "object"
  | "any";

/** The shape of an array prop's items, for the parser's special cases. */
export type UiAppItemKind =
  | "string"
  | "option"
  | "row"
  | "flow-node"
  | "flow-edge"
  | "any";

/** One prop of one component. */
export type UiAppProp = {
  readonly kind: UiAppPropKind;
  readonly required?: boolean;
  /** The accepted strings of an enum. */
  readonly values?: readonly string[];
  /** Inclusive bounds of a number. */
  readonly min?: number;
  readonly max?: number;
  /** Whether the prop may be an expression, not only a literal. */
  readonly expression?: boolean;
  /** The prop is an input's value: `state` accepts `$bindState`, `item`
   * accepts `$bindItem`, `both` accepts either. */
  readonly bind?: "state" | "item" | "both";
  /** The shape of an array's items. */
  readonly items?: UiAppItemKind;
  readonly description: string;
};

/** One component of the catalog. */
export type UiAppComponent = {
  readonly name: string;
  readonly description: string;
  readonly props: Readonly<Record<string, UiAppProp>>;
  /** Child elements are allowed, up to `max`. Absent → a leaf. */
  readonly children?: { readonly max: number };
  /** Events the component can emit, and the `on` keys it accepts. */
  readonly events?: readonly string[];
};

/** The root every app card starts from. */
export const UI_APP_ROOT_TYPE = "Screen";

/** The catalog, in the order the guide lists it. */
export const UI_APP_COMPONENTS: readonly UiAppComponent[] = [
  {
    name: "Screen",
    description:
      "The root of an app card. Holds the whole surface; it has no frame " +
      "of its own beyond the card's.",
    props: {},
    children: { max: 50 },
  },
  {
    name: "Stack",
    description: "Blocks one above another.",
    props: {
      gap: {
        kind: "enum",
        values: ["s", "m", "l"],
        description: "Spacing between the children.",
      },
      align: {
        kind: "enum",
        values: ["start", "center", "end", "stretch"],
        description: "Cross-axis alignment of the children.",
      },
    },
    children: { max: 50 },
  },
  {
    name: "Row",
    description: "Blocks side by side. They wrap when the card is narrow.",
    props: {
      gap: {
        kind: "enum",
        values: ["s", "m", "l"],
        description: "Spacing between the children.",
      },
      align: {
        kind: "enum",
        values: ["start", "center", "end", "stretch"],
        description: "Cross-axis alignment of the children.",
      },
      wrap: {
        kind: "boolean",
        description: "Whether the children may wrap to the next line.",
      },
    },
    children: { max: 50 },
  },
  {
    name: "Grid",
    description: "Blocks in a fixed number of columns.",
    props: {
      columns: {
        kind: "number",
        required: true,
        min: 1,
        max: 4,
        description: "The number of columns.",
      },
      gap: {
        kind: "enum",
        values: ["s", "m", "l"],
        description: "Spacing between the cells.",
      },
    },
    children: { max: 50 },
  },
  {
    name: "Card",
    description: "A framed group with an optional title.",
    props: {
      title: {
        kind: "string",
        expression: true,
        description: "The group's title.",
      },
      description: {
        kind: "string",
        expression: true,
        description: "A line under the title.",
      },
    },
    children: { max: 50 },
  },
  {
    name: "Heading",
    description: "A heading inside the card.",
    props: {
      text: {
        kind: "string",
        required: true,
        expression: true,
        description: "The heading's text.",
      },
      level: {
        kind: "number",
        min: 1,
        max: 4,
        description: "The heading level, 1 to 4.",
      },
    },
  },
  {
    name: "Text",
    description: "A paragraph. Line breaks are kept as written.",
    props: {
      text: {
        kind: "string",
        required: true,
        expression: true,
        description: "The paragraph's text.",
      },
      tone: {
        kind: "enum",
        values: ["default", "muted", "danger", "success"],
        description: "The text's tone.",
      },
    },
  },
  {
    name: "Badge",
    description: "A short status label.",
    props: {
      text: {
        kind: "string",
        required: true,
        expression: true,
        description: "The badge's text.",
      },
      tone: {
        kind: "enum",
        values: ["default", "info", "success", "warning", "danger"],
        description: "The badge's tone.",
      },
    },
  },
  {
    name: "Divider",
    description: "A horizontal rule between blocks.",
    props: {},
  },
  {
    name: "Button",
    description: "A button. Its press runs the `on.press` action.",
    props: {
      label: {
        kind: "string",
        required: true,
        expression: true,
        description: "The button's label.",
      },
      variant: {
        kind: "enum",
        values: ["primary", "secondary", "ghost", "danger"],
        description: "The button's style.",
      },
      disabled: {
        kind: "boolean",
        expression: true,
        description: "Whether the button is disabled.",
      },
    },
    events: ["press"],
  },
  {
    name: "Input",
    description:
      "A one-line text field. Its `value` must be `$bindState` or " +
      "`$bindItem`; typing writes the bound state.",
    props: {
      label: {
        kind: "string",
        expression: true,
        description: "The field's label.",
      },
      placeholder: {
        kind: "string",
        expression: true,
        description: "The hint shown while the field is empty.",
      },
      type: {
        kind: "enum",
        values: ["text", "number", "password", "email"],
        description: "The input's type.",
      },
      value: {
        kind: "string",
        required: true,
        expression: true,
        bind: "both",
        description: "The bound value.",
      },
    },
    events: ["change"],
  },
  {
    name: "Textarea",
    description:
      "A multi-line text field. Its `value` must be `$bindState` or " +
      "`$bindItem`.",
    props: {
      label: {
        kind: "string",
        expression: true,
        description: "The field's label.",
      },
      placeholder: {
        kind: "string",
        expression: true,
        description: "The hint shown while the field is empty.",
      },
      rows: {
        kind: "number",
        min: 1,
        max: 20,
        description: "The visible number of lines.",
      },
      value: {
        kind: "string",
        required: true,
        expression: true,
        bind: "both",
        description: "The bound value.",
      },
    },
    events: ["change"],
  },
  {
    name: "Select",
    description:
      "A choice from a list. Its `value` must be `$bindState` or " +
      "`$bindItem`.",
    props: {
      label: {
        kind: "string",
        required: true,
        expression: true,
        description: "The field's label.",
      },
      options: {
        kind: "array",
        required: true,
        expression: true,
        items: "option",
        description: "The choices, each `{ label, value }`.",
      },
      value: {
        kind: "string",
        required: true,
        expression: true,
        bind: "both",
        description: "The bound value.",
      },
    },
    events: ["change"],
  },
  {
    name: "Checkbox",
    description:
      "A boolean field. Its `checked` must be `$bindState` or `$bindItem`.",
    props: {
      label: {
        kind: "string",
        required: true,
        expression: true,
        description: "The checkbox's label.",
      },
      checked: {
        kind: "boolean",
        required: true,
        expression: true,
        bind: "both",
        description: "The bound boolean.",
      },
    },
    events: ["change"],
  },
  {
    name: "Switch",
    description:
      "A boolean toggle. Its `checked` must be `$bindState` or `$bindItem`.",
    props: {
      label: {
        kind: "string",
        required: true,
        expression: true,
        description: "The switch's label.",
      },
      checked: {
        kind: "boolean",
        required: true,
        expression: true,
        bind: "both",
        description: "The bound boolean.",
      },
    },
    events: ["change"],
  },
  {
    name: "Progress",
    description: "A progress bar.",
    props: {
      label: {
        kind: "string",
        expression: true,
        description: "A label above the bar.",
      },
      value: {
        kind: "number",
        required: true,
        expression: true,
        description: "The current value.",
      },
      max: {
        kind: "number",
        expression: true,
        min: 1,
        description: "The value that fills the bar. Defaults to 100.",
      },
    },
  },
  {
    name: "List",
    description: "A bullet or numbered list.",
    props: {
      ordered: {
        kind: "boolean",
        description: "Whether the list is numbered.",
      },
      items: {
        kind: "array",
        required: true,
        expression: true,
        items: "string",
        description: "The list's items.",
      },
    },
  },
  {
    name: "Table",
    description:
      "A table. The first row is the header; every row has one cell per " +
      "column.",
    props: {
      columns: {
        kind: "array",
        required: true,
        expression: true,
        items: "string",
        description: "The header cells.",
      },
      rows: {
        kind: "array",
        required: true,
        expression: true,
        items: "row",
        description: "The body rows, each an array of cells.",
      },
    },
  },
  {
    name: "Metric",
    description: "One number with a label, an optional unit and a hint.",
    props: {
      label: {
        kind: "string",
        required: true,
        expression: true,
        description: "The metric's label.",
      },
      value: {
        kind: "text",
        required: true,
        expression: true,
        description: "The value as the reader should see it.",
      },
      unit: {
        kind: "string",
        expression: true,
        description: "The unit, for example `%` or `ms`.",
      },
      hint: {
        kind: "string",
        expression: true,
        description: "A line under the value.",
      },
    },
  },
  {
    name: "Tabs",
    description:
      "A tab bar. `value` is the active tab's label and must be bound to " +
      "state; the children are `Tab` elements.",
    props: {
      value: {
        kind: "string",
        required: true,
        expression: true,
        bind: "state",
        description: "The bound active tab label.",
      },
    },
    children: { max: 8 },
  },
  {
    name: "Tab",
    description: "One tab's content. Only inside `Tabs`.",
    props: {
      label: {
        kind: "string",
        required: true,
        description: "The tab's label, matched by `Tabs.value`.",
      },
    },
    children: { max: 50 },
  },
  {
    name: "Repeat",
    description:
      "Draws its children once per item of an array. Inside, `$item` and " +
      "`$index` read the current item; `$bindItem` writes a field when " +
      "`over` is a state path.",
    props: {
      over: {
        kind: "array",
        required: true,
        expression: true,
        items: "any",
        description: "The array to repeat.",
      },
    },
    children: { max: 50 },
  },
  {
    name: "Flow",
    description: "A flowchart. The screen places the nodes.",
    props: {
      nodes: {
        kind: "array",
        required: true,
        expression: true,
        items: "flow-node",
        description:
          "The nodes, each `{ id, label, shape }` with shape `box`, " +
          "`round`, `diamond` or `pill`.",
      },
      edges: {
        kind: "array",
        required: true,
        expression: true,
        items: "flow-edge",
        description:
          "The edges, each `{ from, to, label?, dashed? }` naming node ids.",
      },
    },
  },
];

/** The catalog by component name. */
export const UI_APP_COMPONENT_BY_NAME: ReadonlyMap<string, UiAppComponent> =
  new Map(UI_APP_COMPONENTS.map((component) => [component.name, component]));
