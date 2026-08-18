import { IconX } from "@tabler/icons-react";
import { Modal } from "./Modal.tsx";
import { RecentSessionsList } from "./RecentSessionsList.tsx";
import { useRecentSessions } from "../hooks/useRecentSessions.ts";

interface RecentSessionsModalProps {
  /** Tab keys currently open; those sessions are hidden ("閉じたセッション"). */
  openKeys: ReadonlySet<string>;
  /** Reopen the chosen session in a tab; the modal closes after the choice. */
  onOpen: (key: string) => void;
  onClose: () => void;
}

/** The "過去のセッション" modal (opened from the app menu): every closed
 * session of this server and the federated peers, reopened on click. */
export function RecentSessionsModal({
  openKeys,
  onOpen,
  onClose,
}: RecentSessionsModalProps) {
  const { items, loading, error, reload } = useRecentSessions();
  return (
    <Modal onClose={onClose}>
      <div className="modal-header">
        <h2>過去のセッション</h2>
        <button
          type="button"
          className="icon-btn push"
          onClick={onClose}
          title="閉じる"
          aria-label="閉じる"
        >
          <IconX size={15} />
        </button>
      </div>
      <RecentSessionsList
        items={items}
        loading={loading}
        error={error}
        openKeys={openKeys}
        onSelect={(key) => {
          onOpen(key);
          onClose();
        }}
        onReload={reload}
      />
    </Modal>
  );
}
