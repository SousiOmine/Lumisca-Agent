import type { ReactNode } from "preact/compat";

/** A labelled field: caption above, control below (the shape every settings
 * form uses). */
export function Field({
  label,
  children,
  style,
}: {
  label: string;
  children: ReactNode;
  style?: Record<string, string | number>;
}) {
  return (
    <label className="field" style={style}>
      <span>{label}</span>
      {children}
    </label>
  );
}
