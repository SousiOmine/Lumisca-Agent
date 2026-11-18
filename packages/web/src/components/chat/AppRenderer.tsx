import {
  applyActions,
  bindingOf,
  isExpression,
  resolveCondition,
  resolveProps,
  resolveValue,
  UI_APP_LIMITS,
  type UiAppAction,
  type UiAppContext,
  type UiAppElement,
  type UiAppSpec,
  type UiAppState,
  type UiAppStateStore,
  type UiAppValue,
} from "@lumisca/core/shared";
import { type ComponentChildren, Fragment } from "preact";
import { appComponents } from "./app-components.tsx";

/** What one draw knows besides the state: the spec, its store, and the
 * conversation's next-message callback. */
type RenderContext = UiAppContext & {
  readonly spec: UiAppSpec;
  readonly store: UiAppStateStore;
  readonly onSend?: (text: string) => void;
  readonly disabled: boolean;
  readonly depth: number;
};

/**
 * One app card's element tree.
 *
 * The parser has already refused unknown components, missing children and
 * invalid paths. This component walks the tree, resolves props, evaluates
 * visibility and repeats, and hands each leaf to the registry. It is the
 * only place that knows how `Repeat` and `Tabs` expand; the components
 * below them only draw.
 */
export function AppRenderer({
  spec,
  store,
  state,
  onSend,
  disabled,
}: {
  spec: UiAppSpec;
  store: UiAppStateStore;
  state: UiAppState;
  onSend?: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <AppNode
      id={spec.root}
      ctx={{
        spec,
        store,
        state,
        item: null,
        index: 0,
        itemPath: null,
        bindItem: false,
        onSend,
        disabled,
        depth: 1,
      }}
    />
  );
}

/** One element and its children. */
function AppNode({ id, ctx }: { id: string; ctx: RenderContext }) {
  const element = ctx.spec.elements[id];
  if (element === undefined) {
    return <div className="app-unknown">Missing element: {id}</div>;
  }
  if (ctx.depth > UI_APP_LIMITS.depth) return null;
  if (
    element.visible !== undefined &&
    !resolveCondition(element.visible, ctx)
  ) {
    return null;
  }
  if (element.type === "Repeat") {
    return <RepeatNode element={element} ctx={ctx} />;
  }
  if (element.type === "Tabs") {
    return <TabsNode element={element} ctx={ctx} />;
  }
  if (element.type === "Tab") {
    return <>{renderChildren(element, ctx)}</>;
  }
  const Component = appComponents[element.type];
  if (Component === undefined) {
    return <div className="app-unknown">Unknown component: {element.type}</div>;
  }
  const { props, bindings } = resolveProps(element.props, ctx);
  const emit = (event: string) => {
    if (ctx.disabled) return;
    const action = element.on?.[event];
    if (action === undefined) return;
    const actions: readonly UiAppAction[] = Array.isArray(action)
      ? action
      : [action];
    applyActions(actions, ctx, ctx.store, ctx.onSend);
  };
  const setBound = (prop: string, value: unknown) => {
    if (ctx.disabled) return;
    const binding = bindings[prop];
    if (binding === undefined) {
      throw new Error(`No binding for ${element.type}.${prop}`);
    }
    ctx.store.set(binding.path, value);
  };
  return (
    <Component
      props={props}
      bindings={bindings}
      emit={emit}
      setBound={setBound}
      disabled={ctx.disabled}
    >
      {renderChildren(element, ctx)}
    </Component>
  );
}

/** A `Repeat`'s children, once per item of the resolved array. */
function RepeatNode({
  element,
  ctx,
}: {
  element: UiAppElement;
  ctx: RenderContext;
}) {
  const over = element.props?.over;
  if (over === undefined) return null;
  const value = resolveValue(over, ctx);
  if (!Array.isArray(value)) return null;
  const shown = value.slice(0, UI_APP_LIMITS.repeatItems);
  const base = repeatPathOf(over);
  const childCtx = (item: unknown, index: number): RenderContext => ({
    ...ctx,
    item,
    index,
    itemPath: base === null ? null : `${base}/${index}`,
    bindItem: base !== null,
    depth: ctx.depth + 1,
  });
  return (
    <>
      {shown.map((item, index) => (
        <Fragment key={index}>
          {(element.children ?? []).map((childId) => (
            <AppNode
              key={`${index}-${childId}`}
              id={childId}
              ctx={childCtx(item, index)}
            />
          ))}
        </Fragment>
      ))}
      {value.length > shown.length && (
        <div className="app-limit" aria-hidden="true">
          …
        </div>
      )}
    </>
  );
}

/** A `Tabs` bar and the active `Tab`'s content. */
function TabsNode({
  element,
  ctx,
}: {
  element: UiAppElement;
  ctx: RenderContext;
}) {
  const valueProp = element.props?.value;
  const active = valueProp === undefined ? "" : resolveValue(valueProp, ctx);
  const children = (element.children ?? []).filter((childId) => {
    const child = ctx.spec.elements[childId];
    return child?.visible === undefined || resolveCondition(child.visible, ctx);
  });
  const labels = children.map((childId) => {
    const child = ctx.spec.elements[childId];
    const label = child?.props?.label;
    return typeof label === "string" ? label : "";
  });
  const activeIndex = typeof active === "string" ? labels.indexOf(active) : -1;
  const activeId = activeIndex >= 0 ? children[activeIndex] : undefined;
  const binding = valueProp === undefined ? null : bindingOf(valueProp, ctx);
  const content =
    activeId === undefined
      ? null
      : (ctx.spec.elements[activeId]?.children ?? []).map((childId) => (
          <AppNode
            key={childId}
            id={childId}
            ctx={{ ...ctx, depth: ctx.depth + 1 }}
          />
        ));
  const Component = appComponents.Tabs;
  if (Component === undefined) return null;
  return (
    <Component
      props={{ value: typeof active === "string" ? active : "" }}
      bindings={{}}
      emit={() => {}}
      setBound={() => {}}
      disabled={ctx.disabled}
      items={labels}
      onSelect={(label) => {
        if (binding === null) return;
        ctx.store.set(binding.path, label);
      }}
    >
      {content}
    </Component>
  );
}

/** One element's children, one level deeper. */
function renderChildren(
  element: UiAppElement,
  ctx: RenderContext,
): ComponentChildren {
  return (element.children ?? []).map((childId) => (
    <AppNode
      key={childId}
      id={childId}
      ctx={{ ...ctx, depth: ctx.depth + 1 }}
    />
  ));
}

/** The state path a `Repeat`'s `over` names, or null when it is not a state
 * path. `$bindItem` uses it; a repeat over an item field has no address. */
function repeatPathOf(over: UiAppValue): string | null {
  if (!isExpression(over)) return null;
  const expression = over as Record<string, unknown>;
  return typeof expression.$state === "string" ? expression.$state : null;
}
