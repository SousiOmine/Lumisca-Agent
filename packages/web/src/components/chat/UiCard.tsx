import { useId, useState } from "preact/compat";
import type {
  UiBlock,
  UiChoiceBlock,
  UiField,
  UiFormBlock,
  UiView,
} from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import { Flowchart } from "./Flowchart.tsx";

/**
 * A card shown in the chat by the `chat_ui` tool: text, a list, a table, a
 * flow chart, or a question with a choice or a form.
 *
 * The card is drawn from the tool call's own arguments — nothing about it is
 * stored on the server — so a reload (or a session reopened weeks later)
 * draws the same card. A markup the server accepted but this build cannot
 * read shows the "could not be displayed" note instead of half a card.
 *
 * A Choice or Form click is the user's next message, not a tool result: the
 * card ends its turn, and `sendMessage` starts the next one. That is why the
 * buttons stay clickable while the agent is idle and why a single-choice
 * option sends on the first click.
 */
export function UiCard({
  view,
  onSend,
}: {
  view: UiView | null;
  /** Send the card's answer as the user's next message. */
  onSend: (text: string) => void;
}) {
  const t = useT();
  if (view === null) {
    return (
      <section className="ui-card ui-card-invalid">
        <p>{t("panels.ui.invalid")}</p>
      </section>
    );
  }
  return (
    <section className="ui-card">
      {view.title !== null && <h3 className="ui-card-title">{view.title}</h3>}
      {view.blocks.map((block, index) => (
        <BlockView key={index} block={block} onSend={onSend} />
      ))}
    </section>
  );
}

function BlockView({
  block,
  onSend,
}: {
  block: UiBlock;
  onSend: (text: string) => void;
}) {
  switch (block.type) {
    case "text":
      return <p className="ui-card-text">{block.text}</p>;
    case "list":
      return (
        <ul className={`ui-card-list${block.ordered ? " ordered" : ""}`}>
          {block.items.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      );
    case "table":
      return <TableBlock rows={block.rows} />;
    case "flow":
      return <Flowchart block={block} />;
    case "choice":
      return <ChoiceBlock block={block} onSend={onSend} />;
    case "form":
      return <FormBlockView block={block} onSend={onSend} />;
  }
}

/** The first row is the header; the rest are the body. */
function TableBlock({ rows }: { rows: readonly (readonly string[])[] }) {
  const [header, ...body] = rows;
  if (header === undefined) return null;
  return (
    <div className="ui-card-table-wrap">
      <table className="ui-card-table">
        <thead>
          <tr>
            {header.map((cell, index) => <th key={index}>{cell}</th>)}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One answer of a choice: the selected labels joined by ", " (the form the
 * model reads as a message). */
function choiceMessage(
  choice: UiChoiceBlock,
  selected: readonly number[],
): string {
  return selected
    .map((index) => choice.options[index]?.label)
    .filter((label): label is string => label !== undefined)
    .join(", ");
}

function ChoiceBlock({
  block,
  onSend,
}: {
  block: UiChoiceBlock;
  onSend: (text: string) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<number[]>([]);

  const toggle = (index: number) => {
    // A single choice sends on the click itself: making the user press
    // "send" after picking one of two options is a second step for nothing.
    if (!block.multiple) {
      setSelected([index]);
      const message = choiceMessage(block, [index]);
      if (message.length > 0) onSend(message);
      return;
    }
    setSelected((current) =>
      current.includes(index)
        ? current.filter((item) => item !== index)
        : [...current, index]
    );
  };

  return (
    <div className="ui-card-choice" role="group">
      {block.multiple && (
        <span className="ui-card-hint">{t("panels.ui.multiple")}</span>
      )}
      {block.options.map((option, index) => {
        const active = selected.includes(index);
        return (
          <button
            key={index}
            type="button"
            role={block.multiple ? "checkbox" : "radio"}
            aria-checked={active}
            className={`ui-card-option${active ? " selected" : ""}`}
            onClick={() => toggle(index)}
          >
            <span className="ui-card-option-label">{option.label}</span>
            {option.description !== null && (
              <span className="ui-card-option-desc">{option.description}</span>
            )}
          </button>
        );
      })}
      {block.multiple && (
        <button
          type="button"
          className="btn primary ui-card-submit"
          disabled={selected.length === 0}
          onClick={() => {
            const message = choiceMessage(block, selected);
            if (message.length > 0) onSend(message);
          }}
        >
          {t("panels.ui.submit")}
        </button>
      )}
    </div>
  );
}

/** The form's answer as a message: one `label: value` line per field, with
 * checkboxes always written out (yes/no) and empty optional text omitted. */
function formMessage(
  form: UiFormBlock,
  values: Readonly<Record<number, string | boolean>>,
  words: { yes: string; no: string },
): string {
  const lines: string[] = [];
  form.fields.forEach((field, index) => {
    const value = values[index];
    if (field.type === "checkbox") {
      lines.push(`${field.label}: ${value === true ? words.yes : words.no}`);
      return;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length === 0) return;
    lines.push(`${field.label}: ${text}`);
  });
  return lines.join("\n");
}

/** Whether every required field carries a value (submit enabled). */
function formComplete(
  form: UiFormBlock,
  values: Readonly<Record<number, string | boolean>>,
): boolean {
  return form.fields.every((field, index) => {
    if (!field.required) return true;
    const value = values[index];
    if (field.type === "checkbox") return value === true;
    return typeof value === "string" && value.trim().length > 0;
  });
}

function FormBlockView({
  block,
  onSend,
}: {
  block: UiFormBlock;
  onSend: (text: string) => void;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<number, string | boolean>>({});

  const set = (index: number, value: string | boolean) => {
    setValues((current) => ({ ...current, [index]: value }));
  };

  const submit = () => {
    const message = formMessage(block, values, {
      yes: t("panels.ui.yes"),
      no: t("panels.ui.no"),
    });
    if (message.length > 0) onSend(message);
  };

  return (
    <div className="ui-card-form">
      {block.fields.map((field, index) => (
        <FieldView
          key={index}
          field={field}
          value={values[index]}
          onChange={(value) => set(index, value)}
        />
      ))}
      <button
        type="button"
        className="btn primary ui-card-submit"
        disabled={!formComplete(block, values)}
        onClick={submit}
      >
        {block.submit ?? t("panels.ui.submit")}
      </button>
    </div>
  );
}

function FieldView({
  field,
  value,
  onChange,
}: {
  field: UiField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const id = useId();
  if (field.type === "checkbox") {
    return (
      <div className="ui-card-field ui-card-field-check">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <label htmlFor={id}>
          {field.label}
          {field.required && <span className="ui-card-required">*</span>}
        </label>
      </div>
    );
  }
  const label = (
    <label className="ui-card-field-label" htmlFor={id}>
      {field.label}
      {field.required && <span className="ui-card-required">*</span>}
    </label>
  );
  if (field.type === "select") {
    return (
      <div className="ui-card-field">
        {label}
        <select
          id={id}
          className="ui-card-input"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <option value="">{field.placeholder ?? ""}</option>
          {field.options.map((option, index) => (
            <option key={index} value={option.label}>{option.label}</option>
          ))}
        </select>
      </div>
    );
  }
  const text = typeof value === "string" ? value : "";
  const onChangeText = (event: Event) =>
    onChange((event.currentTarget as HTMLInputElement).value);
  // Two branches rather than a computed `type`: the element's props differ
  // per input type in the DOM typings, and a union matches neither.
  if (field.type === "number") {
    return (
      <div className="ui-card-field">
        {label}
        <input
          id={id}
          className="ui-card-input"
          type="number"
          placeholder={field.placeholder ?? undefined}
          value={text}
          onChange={onChangeText}
        />
      </div>
    );
  }
  return (
    <div className="ui-card-field">
      {label}
      <input
        id={id}
        className="ui-card-input"
        type="text"
        placeholder={field.placeholder ?? undefined}
        value={text}
        onChange={onChangeText}
      />
    </div>
  );
}
