import type {
  FlowBlock,
  FlowEdge,
  FlowNode,
  UiAppBinding,
  UiAppResolvedValue,
} from "@lumisca/core/shared";
import type { ComponentChildren, FunctionComponent } from "preact";
import { useId } from "preact/hooks";
import { Flowchart } from "./Flowchart.tsx";

/** What every app component receives from the renderer. */
export type AppComponentProps = {
  /** The element's props after expressions are resolved. */
  props: Readonly<Record<string, UiAppResolvedValue>>;
  /** The state path of every bound prop. */
  bindings: Readonly<Record<string, UiAppBinding>>;
  children?: ComponentChildren;
  /** Run the element's action for one event. */
  emit: (event: string) => void;
  /** Write a bound prop's value back to the state. */
  setBound: (prop: string, value: unknown) => void;
  /** The card is streaming or read-only: controls do nothing. */
  disabled: boolean;
  /** The labels of a `Tabs` bar. */
  items?: readonly string[];
  /** Pick a tab. */
  onSelect?: (value: string) => void;
};

/** One component of the registry. */
export type AppComponent = FunctionComponent<AppComponentProps>;

/** A string prop, or "". */
function text(props: AppComponentProps["props"], key: string): string {
  const value = props[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/** A number prop, or the fallback. */
function numberProp(
  props: AppComponentProps["props"],
  key: string,
  fallback: number,
): number {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A boolean prop. */
function booleanProp(props: AppComponentProps["props"], key: string): boolean {
  return props[key] === true;
}

/** An array prop, or an empty array. */
function arrayProp<T>(
  props: AppComponentProps["props"],
  key: string,
): readonly T[] {
  const value = props[key];
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

const Screen: AppComponent = ({ children }) => (
  <div className="app-screen">{children}</div>
);

const Stack: AppComponent = ({ props, children }) => (
  <div
    className="app-stack"
    data-gap={text(props, "gap") || undefined}
    data-align={text(props, "align") || undefined}
  >
    {children}
  </div>
);

const Row: AppComponent = ({ props, children }) => (
  <div
    className="app-row"
    data-gap={text(props, "gap") || undefined}
    data-align={text(props, "align") || undefined}
    data-wrap={booleanProp(props, "wrap") ? "true" : undefined}
  >
    {children}
  </div>
);

const Grid: AppComponent = ({ props, children }) => {
  const columns = Math.min(4, Math.max(1, numberProp(props, "columns", 1)));
  return (
    <div
      className="app-grid"
      data-columns={columns}
      data-gap={text(props, "gap") || undefined}
    >
      {children}
    </div>
  );
};

const Card: AppComponent = ({ props, children }) => {
  const title = text(props, "title");
  const description = text(props, "description");
  return (
    <section className="app-panel">
      {title.length > 0 && (
        <div className="app-panel-title" role="heading" aria-level={3}>
          {title}
        </div>
      )}
      {description.length > 0 && (
        <p className="app-panel-description">{description}</p>
      )}
      {children}
    </section>
  );
};

const Heading: AppComponent = ({ props }) => {
  const level = Math.min(4, Math.max(1, numberProp(props, "level", 2)));
  return (
    <div
      className="app-heading"
      data-level={level}
      role="heading"
      aria-level={level}
    >
      {text(props, "text")}
    </div>
  );
};

const Text: AppComponent = ({ props }) => (
  <p className="app-text" data-tone={text(props, "tone") || "default"}>
    {text(props, "text")}
  </p>
);

const Badge: AppComponent = ({ props }) => (
  <span className="app-badge" data-tone={text(props, "tone") || "default"}>
    {text(props, "text")}
  </span>
);

const Divider: AppComponent = () => <hr className="app-divider" />;

const Button: AppComponent = ({ props, emit, disabled }) => {
  const variant = text(props, "variant");
  const className =
    variant === "primary"
      ? "app-button primary"
      : variant === "ghost"
        ? "app-button ghost"
        : variant === "danger"
          ? "app-button danger"
          : "app-button secondary";
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || booleanProp(props, "disabled")}
      onClick={() => emit("press")}
    >
      {text(props, "label")}
    </button>
  );
};

const Input: AppComponent = ({ props, emit, setBound, disabled }) => {
  const id = useId();
  const label = text(props, "label");
  const placeholder = text(props, "placeholder");
  const value = text(props, "value");
  const type = text(props, "type");
  return (
    <div className="app-field">
      {label.length > 0 && (
        <label className="app-field-label" htmlFor={id}>
          {label}
        </label>
      )}
      <input
        id={id}
        className="app-input"
        // Preact's input props discriminate on a literal `type`; the parser
        // has already restricted this to text, number, password or email.
        type={
          (type === "number" || type === "password" || type === "email"
            ? type
            : "text") as any
        }
        placeholder={placeholder.length > 0 ? placeholder : undefined}
        aria-label={label.length > 0 ? undefined : placeholder || undefined}
        value={value}
        disabled={disabled}
        onInput={(event) => {
          setBound("value", event.currentTarget.value);
          emit("change");
        }}
      />
    </div>
  );
};

const Textarea: AppComponent = ({ props, emit, setBound, disabled }) => {
  const id = useId();
  const label = text(props, "label");
  const placeholder = text(props, "placeholder");
  const rows = Math.min(20, Math.max(1, numberProp(props, "rows", 3)));
  return (
    <div className="app-field">
      {label.length > 0 && (
        <label className="app-field-label" htmlFor={id}>
          {label}
        </label>
      )}
      <textarea
        id={id}
        className="app-input app-textarea"
        rows={rows}
        placeholder={placeholder.length > 0 ? placeholder : undefined}
        aria-label={label.length > 0 ? undefined : placeholder || undefined}
        value={text(props, "value")}
        disabled={disabled}
        onInput={(event) => {
          setBound("value", event.currentTarget.value);
          emit("change");
        }}
      />
    </div>
  );
};

const Select: AppComponent = ({ props, emit, setBound, disabled }) => {
  const id = useId();
  const label = text(props, "label");
  const options = arrayProp<{ label?: unknown; value?: unknown }>(
    props,
    "options",
  );
  return (
    <div className="app-field">
      {label.length > 0 && (
        <label className="app-field-label" htmlFor={id}>
          {label}
        </label>
      )}
      <select
        id={id}
        className="app-input app-select"
        aria-label={label.length > 0 ? undefined : "Select"}
        value={text(props, "value")}
        disabled={disabled}
        onChange={(event) => {
          setBound("value", event.currentTarget.value);
          emit("change");
        }}
      >
        {options.map((option, index) => (
          <option key={index} value={String(option.value ?? "")}>
            {typeof option.label === "string" ? option.label : ""}
          </option>
        ))}
      </select>
    </div>
  );
};

const Checkbox: AppComponent = ({ props, emit, setBound, disabled }) => {
  const id = useId();
  const label = text(props, "label");
  return (
    <label className="app-check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={booleanProp(props, "checked")}
        disabled={disabled}
        onChange={(event) => {
          setBound("checked", event.currentTarget.checked);
          emit("change");
        }}
      />
      <span>{label}</span>
    </label>
  );
};

const Switch: AppComponent = ({ props, emit, setBound, disabled }) => {
  const id = useId();
  const label = text(props, "label");
  return (
    <label className="app-switch" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={booleanProp(props, "checked")}
        disabled={disabled}
        onChange={(event) => {
          setBound("checked", event.currentTarget.checked);
          emit("change");
        }}
      />
      <span className="app-switch-track" aria-hidden="true">
        <span className="app-switch-knob" />
      </span>
      <span>{label}</span>
    </label>
  );
};

const Progress: AppComponent = ({ props }) => {
  const value = numberProp(props, "value", 0);
  const max = Math.max(1, numberProp(props, "max", 100));
  const percent = Math.min(100, Math.max(0, (value / max) * 100));
  const label = text(props, "label");
  return (
    <div className="app-progress">
      <div className="app-progress-head">
        {label.length > 0 && <span>{label}</span>}
        <span className="app-progress-value">
          {value} / {max}
        </span>
      </div>
      <div
        className="app-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label.length > 0 ? label : undefined}
      >
        <div className="app-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
};

const List: AppComponent = ({ props }) => {
  const items = arrayProp<string>(props, "items");
  const ordered = booleanProp(props, "ordered");
  return (
    <ul className={`app-list${ordered ? " ordered" : ""}`}>
      {items.map((item, index) => (
        <li key={index}>{String(item)}</li>
      ))}
    </ul>
  );
};

const Table: AppComponent = ({ props }) => {
  const columns = arrayProp<string>(props, "columns");
  const rows = arrayProp<readonly string[]>(props, "rows");
  return (
    <div className="app-table-wrap">
      <table className="app-table">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index}>{String(column)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {(Array.isArray(row) ? row : []).map((cell, cellIndex) => (
                <td key={cellIndex}>{String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Metric: AppComponent = ({ props }) => {
  const unit = text(props, "unit");
  const hint = text(props, "hint");
  return (
    <div className="app-metric">
      <span className="app-metric-label">{text(props, "label")}</span>
      <span className="app-metric-value">
        {text(props, "value")}
        {unit.length > 0 && <span className="app-metric-unit">{unit}</span>}
      </span>
      {hint.length > 0 && <span className="app-metric-hint">{hint}</span>}
    </div>
  );
};

const Tabs: AppComponent = ({ props, children, items, onSelect, disabled }) => {
  const value = text(props, "value");
  const labels = items ?? [];
  return (
    <div className="app-tabs">
      <div className="app-tabbar" role="tablist">
        {labels.map((label) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={label === value}
            className={`app-tab${label === value ? " active" : ""}`}
            disabled={disabled}
            onClick={() => onSelect?.(label)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="app-tabpanel" role="tabpanel">
        {children}
      </div>
    </div>
  );
};

const Tab: AppComponent = ({ children }) => <>{children}</>;

const Repeat: AppComponent = ({ children }) => <>{children}</>;

const Flow: AppComponent = ({ props }) => {
  const nodes = arrayProp<Record<string, unknown>>(props, "nodes").map(
    (node): FlowNode => ({
      id: String(node.id ?? ""),
      label: String(node.label ?? ""),
      shape:
        node.shape === "round" ||
        node.shape === "diamond" ||
        node.shape === "pill"
          ? node.shape
          : "box",
    }),
  );
  const edges = arrayProp<Record<string, unknown>>(props, "edges").map(
    (edge): FlowEdge => ({
      from: String(edge.from ?? ""),
      to: String(edge.to ?? ""),
      label: typeof edge.label === "string" ? edge.label : null,
      dashed: edge.dashed === true,
    }),
  );
  const block: FlowBlock = { type: "flow", nodes, edges };
  return <Flowchart block={block} />;
};

/** Every component the catalog names. A test compares the two lists. */
export const appComponents: Readonly<Record<string, AppComponent>> = {
  Screen,
  Stack,
  Row,
  Grid,
  Card,
  Heading,
  Text,
  Badge,
  Divider,
  Button,
  Input,
  Textarea,
  Select,
  Checkbox,
  Switch,
  Progress,
  List,
  Table,
  Metric,
  Tabs,
  Tab,
  Repeat,
  Flow,
};
