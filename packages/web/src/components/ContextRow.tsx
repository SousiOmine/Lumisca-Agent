import { IconFileText, IconSparkles } from "@tabler/icons-preact";
import type { ContextMessage } from "../types.ts";
import { SystemRow } from "./SystemRow.tsx";

/** Icon for a context provider. */
function providerIcon(provider: string) {
  switch (provider) {
    case "instructions":
      return <IconFileText size={13} />;
    default:
      return <IconSparkles size={13} />;
  }
}

/** A dynamic-context snapshot (the session's skill catalog, or an update to
 * the workspace instruction files) rendered as a compact one-line row; the
 * model-facing text expands on click. The row is what the model received,
 * so a session shows exactly which instructions and skills were in play. */
export function ContextRow({ message }: { message: ContextMessage }) {
  return (
    <SystemRow
      title={message.title}
      body={message.body}
      status="neutral"
      icon={providerIcon(message.provider)}
    />
  );
}
