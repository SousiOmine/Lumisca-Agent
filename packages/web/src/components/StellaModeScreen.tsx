import type { StellaHook } from "../hooks/useStella.ts";
import type {
  PendingFile,
  PendingImage,
  StellaAgent,
  StellaAgentSummary,
  StellaStatus,
} from "../types.ts";
import { StellaSidebar } from "./StellaSidebar.tsx";
import { StellaView } from "./StellaView.tsx";

/**
 * stella mode's screen: the agents on the left, the open conversation in the
 * middle.
 *
 * Extracted from App.tsx, which held both modes' bodies in one JSX tree: a
 * change to stella's narrow-screen navigation (the two screens below the
 * compact width) meant reading code about tabs and a draft composer, and the
 * reverse. The split is by mode, which is the seam the product itself has —
 * the two modes share the shell (title bar, banners, dialogs) and nothing
 * about their body.
 *
 * stella has no tabs and no session list: the sidebar IS its list, and the
 * conversation is the whole surface. `data-screen` says which of the two the
 * reader is on, and the selection decides it — no extra state, so going back
 * and opening the same agent lands where the reader left off. With nobody
 * picked there is no conversation at all: the sheet is not drawn, and the list
 * stands in the middle of the window (stella.css). The same attribute narrows
 * the two to one screen each below the compact breakpoint (see
 * useCompactViewport); there it is the same answer, read by the stylesheet
 * inside its media query.
 */
export interface StellaModeScreenProps {
  /** Everything useStella answers (agents, selection, conversation, actions). */
  stella: StellaHook;
  /** The open agent's row, or null before the first selection. */
  agent: StellaAgentSummary | null;
  /** The machine's state, for the conversation header and the screen pane. */
  status: StellaStatus | null;
  /** The composer's unsent text and attachments, owned by the App so a
   * remount does not throw them away. */
  input: string;
  onInputChange: (value: string) => void;
  images: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;
  files: PendingFile[];
  onFilesChange: (files: PendingFile[]) => void;
  onAgentChanged: (agent: StellaAgent) => void;
  /** Open the create dialog. The App owns it (the title bar's create button
   * opens the same one at phone widths). */
  onNewAgent: () => void;
  /** Open an agent's conversation. A navigation: the address names the
   * conversation (`/stella/a/<id>`), which is what makes a conversation
   * reloadable and linkable. The way back to the list is the title bar's
   * (StellaTitleBarHeader.onBack), which the App draws. */
  onSelectAgent: (id: string) => void;
  onOpenSettings: () => void;
  /** Whether the reader wants the machine's screen open. Owned by the App
   * because the toggle that flips it lives in the title bar, which is drawn
   * above this screen (see App.tsx). */
  screenOpen: boolean;
  onScreenOpenChange: (open: boolean) => void;
}

export function StellaModeScreen({
  stella,
  agent,
  status,
  input,
  onInputChange,
  images,
  onImagesChange,
  files,
  onFilesChange,
  onAgentChanged,
  onNewAgent,
  onSelectAgent,
  onOpenSettings,
  screenOpen,
  onScreenOpenChange,
}: StellaModeScreenProps) {
  const conversation = stella.conversation;
  return (
    <div
      className="stella-shell"
      data-screen={stella.activeAgentId === null ? "list" : "conversation"}
    >
      <StellaSidebar
        agents={stella.agents}
        loading={stella.agentsLoading}
        activeId={stella.activeAgentId}
        onSelect={onSelectAgent}
        onChanged={stella.reloadAgents}
        onAgentChanged={onAgentChanged}
        onNewAgent={onNewAgent}
      />
      <StellaView
        agent={agent}
        conversation={conversation}
        sessionId={stella.sessionId}
        conversationError={stella.error}
        loading={stella.loading}
        status={status}
        screenOpen={screenOpen}
        onScreenOpenChange={onScreenOpenChange}
        input={input}
        onInputChange={onInputChange}
        images={images}
        onImagesChange={onImagesChange}
        files={files}
        onFilesChange={onFilesChange}
        onPrompt={(text, promptImages, promptFiles) =>
          stella.prompt(text, promptImages, promptFiles)
        }
        onAbort={() => stella.abort()}
        onRewind={(timestamp) => stella.rewind(timestamp)}
        onLoadOlder={stella.loadOlder}
        loadingOlder={stella.loadingOlder}
        onFinishHandover={(note, toolCallId) =>
          stella.finishHandover(note, toolCallId)
        }
        onProvideEnv={(value, toolCallId) =>
          stella.provideEnv(value, toolCallId)
        }
        onDeclineEnv={(toolCallId) => stella.declineEnv(toolCallId)}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
