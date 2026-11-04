import { StellaSidebar } from "./StellaSidebar.tsx";
import { StellaView } from "./StellaView.tsx";
import type {
  PendingFile,
  PendingImage,
  StellaAgent,
  StellaAgentSummary,
  StellaStatus,
} from "../types.ts";
import type { StellaHook } from "../hooks/useStella.ts";

/**
 * stella mode's screen: the agents on the left, the open conversation in the
 * middle.
 *
 * Extracted from App.tsx, which held both modes' bodies in one JSX tree: a
 * change to stella's narrow-screen navigation (the two screens a phone gets)
 * meant reading code about tabs and a draft composer, and the reverse. The
 * split is by mode, which is the seam the product itself has — the two modes
 * share the shell (title bar, banners, dialogs) and nothing about their body.
 *
 * stella has no tabs and no session list: the sidebar IS its list, and the
 * conversation is the whole surface. `data-screen` is the phone layout: the
 * list until one is picked, the conversation afterwards, and the selection
 * itself decides which — no extra state, so going back and opening the same
 * agent lands where the reader left off.
 */
export interface StellaModeScreenProps {
  /** Everything useStella answers (agents, selection, conversation, actions). */
  stella: StellaHook;
  /** The open agent's row, or null before the first selection. */
  agent: StellaAgentSummary | null;
  /** The machine's state, for the conversation header and the screen pane. */
  status: StellaStatus | null;
  /** Phone layout: one surface at a time (see the module comment). */
  narrow: boolean;
  /** The composer's unsent text and attachments, owned by the App so a
   * remount does not throw them away. */
  input: string;
  onInputChange: (value: string) => void;
  images: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;
  files: PendingFile[];
  onFilesChange: (files: PendingFile[]) => void;
  onAgentChanged: (agent: StellaAgent) => void;
  onOpenSettings: () => void;
}

export function StellaModeScreen({
  stella,
  agent,
  status,
  narrow,
  input,
  onInputChange,
  images,
  onImagesChange,
  files,
  onFilesChange,
  onAgentChanged,
  onOpenSettings,
}: StellaModeScreenProps) {
  const conversation = stella.conversation;
  return (
    <div
      className="stella-shell"
      data-screen={narrow && stella.activeAgentId !== null
        ? "conversation"
        : "list"}
    >
      <StellaSidebar
        agents={stella.agents}
        loading={stella.agentsLoading}
        activeId={stella.activeAgentId}
        onSelect={stella.select}
        onChanged={stella.reloadAgents}
        onAgentChanged={onAgentChanged}
        running={conversation?.running === true}
      />
      <StellaView
        agent={agent}
        onAgentChanged={onAgentChanged}
        conversation={conversation}
        sessionId={stella.sessionId}
        conversationError={stella.error}
        loading={stella.loading}
        status={status}
        input={input}
        onInputChange={onInputChange}
        images={images}
        onImagesChange={onImagesChange}
        files={files}
        onFilesChange={onFilesChange}
        onPrompt={(text, promptImages, promptFiles) =>
          stella.prompt(text, promptImages, promptFiles)}
        onAbort={() => stella.abort()}
        onRewind={(timestamp) => stella.rewind(timestamp)}
        onModelChange={(provider, modelId) =>
          stella.setModel(provider, modelId)}
        onLoadOlder={stella.loadOlder}
        loadingOlder={stella.loadingOlder}
        onFinishHandover={(note, toolCallId) =>
          stella.finishHandover(note, toolCallId)}
        onOpenSettings={onOpenSettings}
        onBack={narrow ? stella.clearSelection : undefined}
      />
    </div>
  );
}
