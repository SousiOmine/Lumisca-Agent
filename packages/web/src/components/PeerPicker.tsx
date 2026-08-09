import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconServer } from "@tabler/icons-react";
import type { FederatedWorkspace, PeerStatus } from "../types.ts";

interface PeerPickerProps {
  peers: PeerStatus[];
  workspaces: FederatedWorkspace[];
  /** Currently selected peerId ("" = local). */
  value: string;
  onChange: (peerId: string) => void;
}

/** Dropdown for selecting the target machine (peer). Shows the local server
 * as "このPC" and each connected remote peer with a reachability dot. */
export function PeerPicker({
  peers,
  workspaces,
  value,
  onChange,
}: PeerPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /** Collect unique peer ids from the workspace list and peer status.
   * Local ("") is always first. */
  const allPeerIds = (() => {
    const ids = new Set<string>();
    ids.add(""); // local always present
    for (const w of workspaces) ids.add(w.peerId);
    for (const p of peers) ids.add(p.id);
    return [...ids];
  })();

  const peerMap = new Map(peers.map((p) => [p.id, p]));

  const displayName = (peerId: string): string => {
    if (peerId === "") return "このPC";
    return peerMap.get(peerId)?.name ?? peerId;
  };

  const isReachable = (peerId: string): boolean => {
    if (peerId === "") return true;
    return peerMap.get(peerId)?.ok ?? false;
  };

  const peerError = (peerId: string): string | undefined => {
    return peerMap.get(peerId)?.error;
  };

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="peer-picker" ref={rootRef}>
      <button
        type="button"
        className="peer-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={displayName(value)}
      >
        <span className="peer-picker-dot-wrapper">
          <span
            className={`peer-picker-dot${isReachable(value) ? " ok" : " err"}`}
          />
        </span>
        <span className="peer-picker-name">{displayName(value)}</span>
        <span className={`peer-picker-chevron${open ? " open" : ""}`}>
          <IconChevronDown size={15} />
        </span>
      </button>

      {open && (
        <div className="peer-picker-popover" role="listbox">
          {allPeerIds.map((peerId) => {
            const reachable = isReachable(peerId);
            const error = peerError(peerId);
            return (
              <div
                key={peerId}
                role="option"
                aria-selected={peerId === value}
                className={`peer-option${peerId === value ? " selected" : ""}${
                  !reachable ? " unreachable" : ""
                }`}
                title={error}
                onClick={() => {
                  onChange(peerId);
                  setOpen(false);
                }}
              >
                <span className="peer-option-icon">
                  <IconServer size={14} />
                </span>
                <span
                  className={`peer-option-dot${reachable ? " ok" : " err"}`}
                />
                <span className="peer-option-name">
                  {displayName(peerId)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
