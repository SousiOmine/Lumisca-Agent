import type { ReactNode } from "preact/compat";
import { IconChevronRight } from "@tabler/icons-preact";

/**
 * One entry of a provider list (AI or web search): the name, an optional
 * status on the right, and the action that opens it.
 *
 * Both provider lists are the same hand-built row three times over — a
 * button whose padding, badge position and trailing chevron drifted apart.
 * Sharing it is what makes the two sections of the プロバイダー category
 * read as one list of services with different keys.
 */
export function ProviderRow({
  name,
  status,
  onOpen,
  trailing,
}: {
  name: string;
  /** The row's state on the right of the name (設定済み, 既定, …). */
  status?: ReactNode;
  /** Opens the entry's detail. Omitted → the row is a plain label (the
   * search list keeps its actions outside the row body). */
  onOpen?: () => void;
  /** Actions after the chevron (edit, delete, "make default"). */
  trailing?: ReactNode;
}) {
  const body = (
    <>
      <span className="provider-row-name">{name}</span>
      {status !== undefined && (
        <span className="provider-row-status">{status}</span>
      )}
      {onOpen !== undefined && (
        <span className="provider-row-chevron" aria-hidden="true">
          <IconChevronRight size={15} />
        </span>
      )}
    </>
  );
  return (
    <div className="provider-row">
      {onOpen === undefined
        ? <div className="provider-row-body">{body}</div>
        : (
          <button type="button" className="provider-row-body" onClick={onOpen}>
            {body}
          </button>
        )}
      {trailing !== undefined && (
        <span className="provider-row-actions">{trailing}</span>
      )}
    </div>
  );
}
