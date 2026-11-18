/**
 * The JSON UI spec an agent writes into a reply's `ui` fence.
 *
 * A spec is data, never code: the screen parses it, checks every reference
 * against the catalog and the initial state, and draws it with the
 * components in `catalog.ts`. The state a card keeps is the client's, not
 * the server's: the message text is the only stored form, so a reload
 * starts the card again from `state`.
 */

/** A JSON value the spec can hold outside an expression. */
export type UiAppPrimitive = string | number | boolean | null;

/**
 * One written value.
 *
 * An object with exactly one of the `$…` keys is an expression; every other
 * object is a plain object whose entries are values. The parser refuses an
 * object that mixes an expression key with another key, because the two
 * readings would disagree.
 */
export type UiAppValue =
  | UiAppPrimitive
  | readonly UiAppValue[]
  | { readonly [key: string]: UiAppValue }
  | { readonly $state: string }
  | { readonly $item: string }
  | { readonly $index: true }
  | { readonly $template: string }
  | {
      readonly $cond: UiAppCondition;
      readonly $then: UiAppValue;
      readonly $else: UiAppValue;
    }
  | { readonly $bindState: string }
  | { readonly $bindItem: string };

/** A value after the expressions are resolved. */
export type UiAppResolvedValue =
  | UiAppPrimitive
  | readonly UiAppResolvedValue[]
  | { readonly [key: string]: UiAppResolvedValue };

/**
 * One condition.
 *
 * Exactly one subject is named: a state path, a field of the repeated item,
 * the repeat index, or an `$and` / `$or` group. `not` negates the subject's
 * truthiness or the comparison; `eq` / `neq` compare a JSON value; the four
 * ordered comparisons compare numbers.
 */
export type UiAppCondition =
  | boolean
  | {
      readonly $state?: string;
      readonly $item?: string;
      readonly $index?: true;
      readonly $and?: readonly UiAppCondition[];
      readonly $or?: readonly UiAppCondition[];
      readonly not?: true;
      readonly eq?: UiAppValue;
      readonly neq?: UiAppValue;
      readonly gt?: number;
      readonly gte?: number;
      readonly lt?: number;
      readonly lte?: number;
    };

/** How a `setState` action changes the value at its path. */
export type UiAppSetStateOp =
  | "set"
  | "toggle"
  | "increment"
  | "append"
  | "remove";

/**
 * One action an element can run.
 *
 * `setState` and `resetState` change the card's own state. `sendMessage` is
 * the only action that leaves the card: it sends the resolved text as the
 * user's next message. Nothing else can reach the server, a URL or code.
 */
export type UiAppAction =
  | {
      readonly action: "setState";
      readonly path: string;
      readonly op?: UiAppSetStateOp;
      readonly value?: UiAppValue;
      readonly index?: UiAppValue;
      readonly by?: number;
    }
  | { readonly action: "resetState" }
  | { readonly action: "sendMessage"; readonly text: UiAppValue };

/** One element of the flat element map. */
export type UiAppElement = {
  readonly type: string;
  readonly props?: Readonly<Record<string, UiAppValue>>;
  readonly children?: readonly string[];
  readonly visible?: UiAppCondition;
  readonly on?: Readonly<Record<string, UiAppAction | readonly UiAppAction[]>>;
};

/** One card as written. */
export type UiAppSpec = {
  readonly version: 1;
  readonly title?: string;
  readonly description?: string;
  /** The initial state. A card never writes it back to the message. */
  readonly state: Readonly<Record<string, unknown>>;
  readonly root: string;
  readonly elements: Readonly<Record<string, UiAppElement>>;
};

/** The result of one parse. On failure, `problem` says what to fix. */
export type UiAppParseResult =
  | { readonly ok: true; readonly spec: UiAppSpec }
  | { readonly ok: false; readonly problem: string };

/** Where a bound prop reads and writes: the state path it names. */
export type UiAppBinding = { readonly path: string };

/**
 * What one draw knows besides the element: the state snapshot, and the item
 * of the nearest enclosing `<Repeat>` when there is one.
 *
 * `itemPath` is the state path of that item when the repeat's `over` is a
 * state path. `$bindItem` needs it; a repeat over an item field has no
 * address to write, so the parser refuses `$bindItem` there.
 */
export type UiAppContext = {
  readonly state: Readonly<Record<string, unknown>>;
  readonly item: unknown;
  readonly index: number;
  readonly itemPath: string | null;
  readonly bindItem: boolean;
};

/** One element's props after resolution, plus the paths its inputs write. */
export type UiAppResolvedProps = {
  readonly props: Readonly<Record<string, UiAppResolvedValue>>;
  readonly bindings: Readonly<Record<string, UiAppBinding>>;
};
