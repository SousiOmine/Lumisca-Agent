/**
 * The JSON UI an agent writes into a reply's `ui` fence.
 *
 * `parseAppSpec` reads one finished spec, `parseAppSpecPartial` reads one
 * still being written, `createUiAppState` holds the card's own state, and
 * `resolveProps` / `applyActions` are the renderer's runtime. The catalog is
 * the one vocabulary the parser, the renderer and the model's guide share.
 */
export {
  appComponentNames,
  completeJson,
  parseAppSpec,
  parseAppSpecPartial,
} from "./build.ts";
export {
  UI_APP_COMPONENT_BY_NAME,
  UI_APP_COMPONENTS,
  UI_APP_ROOT_TYPE,
  type UiAppComponent,
  type UiAppItemKind,
  type UiAppProp,
  type UiAppPropKind,
} from "./catalog.ts";
export { appHelp, UI_HELP } from "./help.ts";
export { UI_APP_LIMITS } from "./limits.ts";
export {
  applyAction,
  applyActions,
  bindingOf,
  isExpression,
  resolveCondition,
  resolveProps,
  resolveValue,
  templateReferences,
  textOf,
  UI_APP_EXPRESSION_KEYS,
} from "./resolve.ts";
export {
  cloneJson,
  createUiAppState,
  itemValue,
  pathSegments,
  type UiAppState,
  type UiAppStateStore,
  valueAtPath,
} from "./state.ts";
export type {
  UiAppAction,
  UiAppBinding,
  UiAppCondition,
  UiAppContext,
  UiAppElement,
  UiAppParseResult,
  UiAppPrimitive,
  UiAppResolvedProps,
  UiAppResolvedValue,
  UiAppSetStateOp,
  UiAppSpec,
  UiAppValue,
} from "./types.ts";
