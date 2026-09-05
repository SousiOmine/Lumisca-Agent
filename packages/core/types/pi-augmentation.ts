// Global augmentation of pi-agent-core's CustomAgentMessages so
// NotificationMessage and ModeMessage join the AgentMessage union
// everywhere (events, steering, persistence, the UI). An ambient module
// is the only way to merge an interface declared inside the pi package —
// this is their documented extension point for custom message types.
// The JSR slow-types rule does not apply here: this workspace is not
// published to JSR.
// deno-lint-ignore-file no-slow-types
import type { NotificationMessage } from "./notification.ts";
import type { ModeMessage } from "./mode-message.ts";

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: NotificationMessage;
    mode: ModeMessage;
  }
}
