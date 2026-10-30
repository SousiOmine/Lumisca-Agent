import type { ReactNode } from "preact/compat";

/**
 * The two settings-row primitives every settings screen was re-implementing.
 *
 * `Toggle` is the on/off switch: a checkbox behind the same slider markup
 * that was copy-pasted into seven panels, so a change to the look (or to the
 * accessibility wiring) could not reach all of them.
 *
 * `SettingRow` is the "label + description, control on the right" row that
 * eight screens built by hand out of `update-item` / `update-info` /
 * `update-label` / `update-desc`. One component keeps the spacing and the
 * semantics (`aria-label` on the control, the description read as part of
 * the row) identical everywhere.
 */

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name of the switch (the row's label, when it has one). */
  label: string;
}) {
  return (
    <label className="toggle-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        aria-label={label}
      />
      <span className="toggle-slider" />
    </label>
  );
}

export function SettingRow({
  label,
  description,
  children,
  title,
}: {
  label: ReactNode;
  /** The explanation under the label. Omitted → a plain one-line row. */
  description?: ReactNode;
  /** The control on the right (a Toggle, a button, a percentage…). */
  children?: ReactNode;
  /** Tooltip for the whole row. */
  title?: string;
}) {
  return (
    <div className="update-item" title={title}>
      <div className="update-info">
        <span className="update-label">{label}</span>
        {description !== undefined && (
          <span className="update-desc">{description}</span>
        )}
      </div>
      {children}
    </div>
  );
}
