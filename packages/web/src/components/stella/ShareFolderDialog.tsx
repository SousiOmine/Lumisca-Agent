import { errorMessage } from "@lumisca/core/shared";
import { IconFolder } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { useT } from "../../i18n.ts";
import {
  folderName,
  loadRecentFolders,
  type RecentShareFolder,
  rememberFolder,
} from "../../share-recents.ts";
import { loadShareIdle, minutesOf, useShareIdle } from "../../shareIdle.ts";
import { inDesktopShell, shellCall } from "../../shell.ts";
import { Modal } from "../Modal.tsx";
import { ShareTerms } from "./ShareList.tsx";

/** One loan as the shell answered it (`share/grant`): the grant the lending
 * child serves it under, and the terms. */
export interface ShareGrantView {
  id: string;
  sessionId: string;
  /** The folder on this computer, absolute. */
  path: string;
  write: boolean;
  /** The loan it belongs to, when several places were lent at once. */
  group?: string | null;
}

/** One place a whole-computer loan may cover: a drive on Windows, the root
 * on macOS and Linux. The shell enumerates them because only it can see the
 * disk this window runs on. */
export interface ComputerRoot {
  path: string;
  label: string;
  kind: string;
}

export interface ShareFolderDialogProps {
  /** The conversation's server-side session id: the loan is made to it, and
   * the shell passes it to the lending child unchanged. */
  sessionId: string;
  onClose: () => void;
  /** Called after a loan was made, before the dialog leaves. The card that
   * asked for a folder answers the blocked tool with this; the composer's
   * menu, which asks for nothing, passes none. */
  onLent?: (grant: ShareGrantView) => void;
}

/**
 * Lend this computer, or one folder on it, to the open conversation.
 *
 * A conversation that needs several places at once (a Windows machine with
 * more than one drive) is one loan: the places are checked together, lent
 * under one group, and withdrawn together. One folder is still a loan of its
 * own, chosen with the OS picker, which is the consent for that path.
 *
 * The picker is the consent for a folder; for the whole computer the shell
 * asks before it lends. Nothing is lent before the last press: a dialog that
 * lent as soon as a place was chosen would take a click on a drive for
 * agreement to everything else on the sheet.
 */
export function ShareFolderDialog({
  sessionId,
  onClose,
  onLent,
}: ShareFolderDialogProps) {
  const t = useT();
  const [recent] = useState<RecentShareFolder[]>(() => loadRecentFolders());
  const [selected, setSelected] = useState<RecentShareFolder | null>(null);
  // Terms start read only. A folder lent again starts from its own last
  // terms instead (see choose and lend). Commands are always allowed, so
  // there is nothing else to ask.
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The whole computer: the places the shell can lend, which of them the
  // user kept checked, and whether that loan is under way.
  const [roots, setRoots] = useState<ComputerRoot[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [computerWrite, setComputerWrite] = useState(false);
  const [computerBusy, setComputerBusy] = useState(false);
  const [computerError, setComputerError] = useState<string | null>(null);
  // The deadline the loan will actually get: the dialog states it before the
  // user agrees, and the settings page is where it is chosen.
  const idle = useShareIdle();

  useEffect(() => {
    loadShareIdle();
  }, []);

  useEffect(() => {
    // A plain browser has no shell and therefore no disk to lend: the section
    // stays away and the folder picker's own explanation shows instead.
    if (!inDesktopShell()) return;
    let live = true;
    void shellCall<{ roots: ComputerRoot[] }>("share/computer-roots")
      .then((answer) => {
        if (!live) return;
        setRoots(answer.roots);
        setChosen(answer.roots.map((root) => root.path));
      })
      .catch(() => {
        // No roots is the same as no section: nothing to lend here.
      });
    return () => {
      live = false;
    };
  }, []);

  const choose = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await shellCall<{ path: string | null }>(
        "share/pick-folder",
      );
      if (answer.path !== null) {
        const known = recent.find((entry) => entry.path === answer.path);
        setSelected({
          path: answer.path,
          name: folderName(answer.path),
          write: known?.write ?? false,
        });
        setWrite(known?.write ?? false);
      }
    } catch (failure) {
      setError(
        t("chat.stella.share.pickFailed", { error: errorMessage(failure) }),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Lend one folder and leave. `close` is the dialog's own exit, so the
   * sheet does not vanish in one frame. */
  const lend = async (folder: RecentShareFolder, close: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await shellCall<{ ok: boolean; grant: ShareGrantView }>(
        "share/grant",
        {
          sessionId,
          path: folder.path,
          write: folder.write ? "1" : "0",
        },
      );
      rememberFolder(folder);
      onLent?.(answer.grant);
      close();
    } catch (failure) {
      setError(
        t("chat.stella.share.lendFailed", { error: errorMessage(failure) }),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Lend every checked place as one loan. The shell confirms the list
   * before it lends, so a page bug cannot lend a disk on its own. */
  const lendComputer = async (close: () => void) => {
    if (computerBusy || chosen.length === 0) return;
    setComputerBusy(true);
    setComputerError(null);
    try {
      const answer = await shellCall<{
        ok: boolean;
        grants: ShareGrantView[];
      }>("share/grant-computer", {
        sessionId,
        roots: chosen.join("\n"),
        write: computerWrite ? "1" : "0",
      });
      const first = answer.grants[0];
      if (first !== undefined) onLent?.(first);
      close();
    } catch (failure) {
      setComputerError(
        t("chat.stella.share.computer.failed", {
          error: errorMessage(failure),
        }),
      );
    } finally {
      setComputerBusy(false);
    }
  };

  const toggleRoot = (path: string) => {
    setChosen((previous) =>
      previous.includes(path)
        ? previous.filter((entry) => entry !== path)
        : [...previous, path],
    );
  };

  return (
    <Modal onClose={onClose} label={t("chat.stella.share.title")}>
      {(close) => (
        <>
          <h2>{t("chat.stella.share.title")}</h2>
          <p className="stella-share-hint">{t("chat.stella.share.hint")}</p>

          {roots !== null && (
            <section className="stella-share-computer">
              <h3 className="stella-pane-section">
                {t("chat.stella.share.computer.title")}
              </h3>
              <p className="stella-share-hint">
                {t("chat.stella.share.computer.hint")}
              </p>

              {roots.length === 0 ? (
                <p className="stella-share-note">
                  {t("chat.stella.share.computer.none")}
                </p>
              ) : (
                <>
                  <ul className="stella-share-roots">
                    {roots.map((root) => (
                      <li key={root.path}>
                        <label className="stella-share-root">
                          <input
                            type="checkbox"
                            checked={chosen.includes(root.path)}
                            disabled={computerBusy}
                            onChange={() => toggleRoot(root.path)}
                          />
                          <span className="stella-share-root-name">
                            {root.path === "/"
                              ? t("chat.stella.share.computer.everything")
                              : root.label}
                          </span>
                          <code
                            className="stella-share-origin"
                            title={root.path}
                          >
                            {root.path}
                          </code>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <label className="stella-share-choice">
                    <input
                      type="radio"
                      name="stella-share-computer-write"
                      checked={!computerWrite}
                      disabled={computerBusy}
                      onChange={() => setComputerWrite(false)}
                    />
                    {t("chat.stella.share.readOnly")}
                  </label>
                  <label className="stella-share-choice">
                    <input
                      type="radio"
                      name="stella-share-computer-write"
                      checked={computerWrite}
                      disabled={computerBusy}
                      onChange={() => setComputerWrite(true)}
                    />
                    {t("chat.stella.share.readWrite")}
                  </label>
                  {idle !== null && (
                    <p className="stella-share-note">
                      {idle === "never"
                        ? t("chat.stella.share.idleNever")
                        : t("chat.stella.share.idle", {
                            minutes: minutesOf(idle),
                          })}
                    </p>
                  )}
                  <div className="stella-share-actions">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={computerBusy || chosen.length === 0}
                      onClick={() => void lendComputer(() => close())}
                    >
                      {computerBusy
                        ? t("chat.stella.share.computer.lending")
                        : t("chat.stella.share.computer.lend")}
                    </button>
                  </div>
                </>
              )}
              {computerError !== null && (
                <p className="error-text" role="alert">
                  {computerError}
                </p>
              )}
            </section>
          )}

          {roots !== null && <hr className="stella-share-divider" />}

          <button
            type="button"
            className="btn stella-share-pick"
            disabled={busy}
            onClick={() => void choose()}
          >
            <IconFolder size={15} />
            {t("chat.stella.share.pick")}
          </button>

          {selected !== null && (
            <div className="stella-share-terms-panel">
              <p className="stella-share-path" title={selected.path}>
                {selected.name}
                <span className="stella-share-origin">{selected.path}</span>
              </p>
              <label className="stella-share-choice">
                <input
                  type="radio"
                  name="stella-share-write"
                  checked={!write}
                  onChange={() => setWrite(false)}
                />
                {t("chat.stella.share.readOnly")}
              </label>
              <label className="stella-share-choice">
                <input
                  type="radio"
                  name="stella-share-write"
                  checked={write}
                  onChange={() => setWrite(true)}
                />
                {t("chat.stella.share.readWrite")}
              </label>
              {idle !== null && (
                <p className="stella-share-note">
                  {idle === "never"
                    ? t("chat.stella.share.idleNever")
                    : t("chat.stella.share.idle", {
                        minutes: minutesOf(idle),
                      })}
                </p>
              )}
              <div className="stella-share-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    void lend({ ...selected, write }, () => close())
                  }
                >
                  {busy
                    ? t("chat.stella.share.lending")
                    : t("chat.stella.share.lend")}
                </button>
              </div>
            </div>
          )}

          {recent.length > 0 && (
            <section className="stella-share-recent">
              <h3 className="stella-pane-section">
                {t("chat.stella.share.recent")}
              </h3>
              <ul className="stella-share-list">
                {recent.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="stella-recent-folder"
                      disabled={busy}
                      title={entry.path}
                      onClick={() => void lend(entry, () => close())}
                    >
                      <IconFolder size={15} />
                      <span className="stella-recent-name">{entry.name}</span>
                      <ShareTerms write={entry.write} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error !== null && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {/* Always here, not only in the decision: on a phone the dialog
           * fills the screen, so the backdrop is not a way out. */}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => close()}>
              {t("common.close")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
