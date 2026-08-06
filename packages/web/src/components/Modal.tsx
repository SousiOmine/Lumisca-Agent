import type { ReactNode } from "react";

interface ModalProps {
  width?: string;
  onClose: () => void;
  children: ReactNode;
}

/** Shared backdrop + dialog shell; click on the backdrop closes. */
export function Modal({ width, onClose, children }: ModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={width ? { width } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
