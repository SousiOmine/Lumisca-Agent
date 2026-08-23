import type { ReactElement } from "react";
import { IconBrowser, IconLayoutSidebarRight } from "@tabler/icons-react";

/** Resolve the icon for a docked pane content kind. Unknown kinds (a
 * future desktop shell returning a content type this UI does not know
 * yet) fall back to the generic pane icon, so a new kind never breaks
 * the header or the title-bar toggle. */
export function paneIcon(kind: string, size: number): ReactElement {
  switch (kind) {
    case "browser":
      return <IconBrowser size={size} />;
    default:
      return <IconLayoutSidebarRight size={size} />;
  }
}
