import { errorMessage } from "@lumisca/core/shared";
import { useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import { shellCall } from "../../shell.ts";
import type { FolderShare } from "../../types.ts";

/** What a loan allows, in words the reader set in the dialog. Commands are
 * always allowed, so only the write permission is a choice. */
export function ShareTerms({ write }: { write: boolean }) {
  const t = useT();
  return (
    <span className="stella-share-terms">
      {t(write ? "chat.stella.share.readWrite" : "chat.stella.share.readOnly")}
    </span>
  );
}

/** The shares of one whole-computer loan, and the folders lent one by one.
 * Map iteration keeps the order the server announced, and every grant of a
 * loan carries the same group id. */
function splitLoans(shares: readonly FolderShare[]): {
  groups: Array<[string, FolderShare[]]>;
  singles: FolderShare[];
} {
  const groups = new Map<string, FolderShare[]>();
  const singles: FolderShare[] = [];
  for (const share of shares) {
    if (share.group === undefined || share.group === "") {
      singles.push(share);
      continue;
    }
    const list = groups.get(share.group);
    if (list === undefined) groups.set(share.group, [share]);
    else list.push(share);
  }
  return { groups: [...groups], singles };
}

/**
 * The folders this conversation may reach on this computer, with the way to
 * take one back.
 *
 * It sits under the machine's screen in the information panel, and it is a
 * security fact rather than progress: the user lent a folder on their own
 * disk, and the only place that says so while it lasts is here. Disconnecting goes through the
 * shell (the folder is on this computer; the server only hears the shorter
 * list), and the list then changes by itself through the conversation's
 * `shares` event — this component keeps no copy.
 */
export function ShareList({ shares }: { shares: readonly FolderShare[] }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (shares.length === 0) return null;

  const { groups, singles } = splitLoans(shares);

  const disconnect = async (id: string) => {
    if (busy !== null) return;
    setBusy(id);
    setError(null);
    try {
      await shellCall("share/revoke", { id });
    } catch (failure) {
      setError(
        t("chat.stella.share.disconnectFailed", {
          error: errorMessage(failure),
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  /** One withdrawal for every place of a whole-computer loan. */
  const disconnectGroup = async (group: string) => {
    if (busy !== null) return;
    setBusy(group);
    setError(null);
    try {
      await shellCall("share/revoke-group", { group });
    } catch (failure) {
      setError(
        t("chat.stella.share.computer.disconnectFailed", {
          error: errorMessage(failure),
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="stella-shares"
      aria-label={t("chat.stella.share.panel")}
    >
      <h3 className="stella-pane-section">{t("chat.stella.share.panel")}</h3>
      <ul className="stella-share-list">
        {groups.map(([group, list]) => {
          // The loan is named after the computer that lent it: the shell's
          // own host name, not a word the page made up.
          const name = list[0]?.host.name.trim() ?? "";
          return (
            <li key={group} className="stella-share-group">
              <div className="stella-share-group-head">
                <span className="stella-share-group-title">
                  {name === "" ? t("chat.stella.share.computer.title") : name}
                </span>
                <button
                  type="button"
                  className="btn small"
                  disabled={busy !== null}
                  onClick={() => void disconnectGroup(group)}
                >
                  {t("chat.stella.share.disconnect")}
                </button>
              </div>
              <ul className="stella-share-group-roots">
                {list.map((share) => (
                  <li key={share.id} className="stella-share-root-row">
                    <div className="stella-share-main">
                      <span className="stella-share-root-line">
                        <code className="stella-share-name">
                          {`/lend/${share.name}`}
                        </code>
                        <span
                          className="stella-share-origin"
                          title={share.path}
                        >
                          {share.path}
                        </span>
                      </span>
                      <ShareTerms write={share.write} />
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
        {singles.map((share) => (
          <li key={share.id} className="stella-share-row">
            <div className="stella-share-main">
              <code className="stella-share-name">{`/lend/${share.name}`}</code>
              <span className="stella-share-origin" title={share.path}>
                {share.path}
              </span>
              <ShareTerms write={share.write} />
            </div>
            <button
              type="button"
              className="btn small"
              disabled={busy !== null}
              onClick={() => void disconnect(share.id)}
            >
              {t("chat.stella.share.disconnect")}
            </button>
          </li>
        ))}
      </ul>
      {error !== null && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
