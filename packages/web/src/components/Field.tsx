import type { ReactNode } from "react";

/** A labeled full-width field (label above, input below — matches the
 * settings forms). */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <p className="settings-note">{label}</p>
      {children}
    </div>
  );
}
