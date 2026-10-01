import { Fragment, useEffect, useRef, useState } from "preact/compat";
import {
  type Icon,
  IconArrowLeft,
  IconArrowUp,
  IconChevronRight,
  IconDeviceDesktop,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFileText,
  IconFolder,
  IconHome,
} from "@tabler/icons-preact";
import type { Translator } from "@lumisca/core/shared";
import { workspaceApi } from "../api.ts";
import type { FsBrowse, FsEntry, FsPlace, FsPlaceKind } from "../types.ts";
import { errorText } from "../providers.ts";
import { useAsyncEffect } from "../hooks/useAsync.ts";
import { useT } from "../i18n.ts";
import { useTouchInput } from "../hooks/useMediaQuery.ts";

/** Sidebar icon of each place: a root is a drive/volume, so it reads as a
 * folder. */
const PLACE_ICONS: Record<FsPlaceKind, Icon> = {
  home: IconHome,
  desktop: IconDeviceDesktop,
  documents: IconFileText,
  downloads: IconDownload,
  root: IconFolder,
};

/** Label of a sidebar place: the user folders carry translated names, a
 * root is shown as the path it is. */
function placeLabel(place: FsPlace, t: Translator): string {
  switch (place.kind) {
    case "home":
      return t("chrome.folderBrowser.place.home");
    case "desktop":
      return t("chrome.folderBrowser.place.desktop");
    case "documents":
      return t("chrome.folderBrowser.place.documents");
    case "downloads":
      return t("chrome.folderBrowser.place.downloads");
    case "root":
      return place.path;
  }
}

/** Whether an entry is hidden: the dot-prefix rule the OS file managers
 * follow, and the same one the app's file walk uses
 * (`core/workspace/walk.ts`). */
export function isHiddenEntry(entry: FsEntry): boolean {
  return entry.name.startsWith(".");
}

/** The rows the list shows. Hidden entries stay out of the way until they
 * are asked for: a home folder carries dozens of dot-folders (`.cache`,
 * `.config`, `.local`, …) and they sort before every other name, so listing
 * them would push the folders the user came for below the fold of a pane
 * that shows about a dozen rows. */
export function visibleEntries(
  entries: FsEntry[],
  showHidden: boolean,
): FsEntry[] {
  return showHidden
    ? entries
    : entries.filter((entry) => !isHiddenEntry(entry));
}

/** One row of the list pane. A folder selects on click and opens on double
 * click (or Enter, handled by the list itself); a file is listed for
 * orientation only — a workspace is built from folders — so it is dimmed and
 * inert. On a touch screen (`tapOpens`) the first click opens instead of
 * selecting: there is no double click to descend with, and the folder the
 * user is in is what the "select" button adds, so tapping to descend is the
 * whole interaction. */
function EntryRow(
  { entry, selected, onSelect, onOpen, tapOpens }: {
    entry: FsEntry;
    selected: boolean;
    onSelect: (path: string) => void;
    onOpen: (path: string) => void;
    /** Whether a single click opens the folder (see above). */
    tapOpens: boolean;
  },
) {
  const t = useT();
  if (entry.kind === "file") {
    return (
      <div
        className="folder-browser-row file"
        role="option"
        aria-selected={false}
        aria-disabled="true"
      >
        <span className="folder-icon">
          <IconFile size={15} />
        </span>
        {
          /* The hint rides on the name, not the row: a title on the row would
         * replace the file name as its accessible name. */
        }
        <span
          className="folder-browser-name"
          title={t("chrome.folderBrowser.fileNotSelectable")}
        >
          {entry.name}
        </span>
      </div>
    );
  }
  return (
    <div
      className={`folder-browser-row dir${selected ? " selected" : ""}`}
      role="option"
      aria-selected={selected}
      onClick={() => (tapOpens ? onOpen(entry.path) : onSelect(entry.path))}
      onDblClick={() => onOpen(entry.path)}
    >
      <span className="folder-icon">
        <IconFolder size={15} />
      </span>
      <span className="folder-browser-name">{entry.name}</span>
    </div>
  );
}

/** In-app filesystem browser for picking a workspace folder (the fallback
 * when the desktop shell's native picker is unavailable). Browsing happens
 * on the peer that owns the workspace (its filesystem).
 *
 * Two panes, like the OS file managers it imitates: the left one lists the
 * machine's places (its user folders plus its filesystem roots), the right
 * one the contents of the open folder. A single click selects a folder, a
 * double click (or Enter) opens it; the "select" button adds the selected
 * folder — or the open one while nothing is selected — to the workspace. A
 * touch screen has no double click, so a single tap opens there (see
 * EntryRow), and the button adds the folder the user is in. */
export function FolderBrowser(
  { peerId, peerName, onAdd, onBack }: {
    peerId: string;
    peerName: string;
    onAdd: (path: string) => void;
    onBack: () => void;
  },
) {
  const t = useT();
  // A finger has no double click: the rows open on the first tap there.
  const touch = useTouchInput();
  const [places, setPlaces] = useState<FsPlace[]>([]);
  const [open, setOpen] = useState<FsBrowse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** Whether the list also shows hidden entries: off at first, the way the
   * OS file managers open. */
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Browsing happens on the peer that owns the workspace (its filesystem).
  const wsApi = workspaceApi(peerId);
  const listRef = useRef<HTMLDivElement>(null);
  /** Navigation sequence: a response for a folder the user has already left
   * (rapid clicks on 上の階層) must never overwrite the newer one. */
  const visit = useRef(0);

  const openFolder = async (path: string): Promise<void> => {
    const id = ++visit.current;
    setLoading(true);
    setError(undefined);
    try {
      const listing = await wsApi.fsBrowse(path);
      if (id !== visit.current) return;
      setOpen(listing);
      setSelected(null);
    } catch (e) {
      // The folder that failed never becomes the open one: the panes keep
      // showing the folder the user was in (address bar included).
      if (id === visit.current) setError(errorText(e));
    } finally {
      if (id === visit.current) setLoading(false);
    }
  };

  useAsyncEffect(async (isStale) => {
    try {
      const list = await wsApi.fsPlaces();
      if (isStale()) return;
      setPlaces(list);
      // Open a folder right away, the way a file manager does: the home
      // folder when the machine has one, otherwise the first place (a drive
      // on Windows).
      const start = list.find((place) => place.kind === "home") ?? list[0];
      if (start) void openFolder(start.path);
    } catch (e) {
      if (!isStale()) setError(errorText(e));
    }
  }, [peerId]);

  // Focus the list on open so ↑/↓ and Enter work without a click: the focus
  // stayed on the 選択 button that brought this view up, and that button is
  // gone now.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // The rows of the open folder, and the folders among them: ↑/↓ and Enter
  // walk the same list the user sees.
  const entries = open ? visibleEntries(open.entries, showHidden) : [];
  const folders = entries.filter((entry) => entry.kind === "dir");

  const moveSelection = (step: number) => {
    if (folders.length === 0) return;
    const index = folders.findIndex((entry) => entry.path === selected);
    // With nothing selected yet, both directions enter the list at its edge.
    const next = index === -1
      ? (step > 0 ? 0 : folders.length - 1)
      : Math.min(Math.max(index + step, 0), folders.length - 1);
    setSelected(folders[next]!.path);
  };

  const onListKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        return;
      case "Enter":
        event.preventDefault();
        if (selected) void openFolder(selected);
        return;
      // "go up", the file managers' key for the parent folder.
      case "Backspace":
        event.preventDefault();
        if (open?.parent) void openFolder(open.parent);
        return;
    }
  };

  const chosen = entries.find((entry) => entry.path === selected) ?? null;
  const target = chosen?.path ?? open?.path ?? null;
  // The button names the folder it will add: the selected one, or the open
  // one while nothing is selected.
  const targetName = chosen?.name ?? open?.breadcrumbs.at(-1)?.name ?? "";

  return (
    <>
      <div className="modal-header">
        <button type="button" className="btn" onClick={onBack}>
          <IconArrowLeft size={14} /> {t("common.back")}
        </button>
        <h2>{t("chrome.folderBrowser.title")}</h2>
      </div>
      <p className="settings-note">
        {peerId === ""
          ? t("chrome.folderBrowser.selectPrompt")
          : t("chrome.folderBrowser.selectPeerPrompt", { peerName, peerId })}
      </p>

      <div className="folder-browser-panes">
        <div className="folder-browser-sidebar">
          <div className="folder-browser-sidebar-title">
            {t("chrome.folderBrowser.placesLabel")}
          </div>
          {places.map((place) => {
            const PlaceIcon = PLACE_ICONS[place.kind];
            return (
              <button
                key={place.path}
                type="button"
                className={`folder-browser-place${
                  place.path === open?.path ? " active" : ""
                }`}
                title={place.path}
                onClick={() => void openFolder(place.path)}
              >
                <span className="folder-icon">
                  <PlaceIcon size={15} />
                </span>
                <span className="folder-browser-place-name">
                  {placeLabel(place, t)}
                </span>
              </button>
            );
          })}
          {places.length === 0 && (
            <div className="folder-browser-empty">
              {t("chrome.folderBrowser.noPlaces")}
            </div>
          )}
        </div>

        <div className="folder-browser-main">
          <div className="folder-browser-toolbar">
            <div className="folder-browser-crumbs">
              {open?.breadcrumbs.map((crumb, index) => (
                <Fragment key={crumb.path}>
                  {index > 0 && (
                    <span className="folder-browser-sep">
                      <IconChevronRight size={12} />
                    </span>
                  )}
                  <button
                    type="button"
                    className={`folder-browser-crumb${
                      index === open.breadcrumbs.length - 1 ? " current" : ""
                    }`}
                    title={crumb.path}
                    disabled={index === open.breadcrumbs.length - 1}
                    onClick={() =>
                      void openFolder(crumb.path)}
                  >
                    {crumb.name}
                  </button>
                </Fragment>
              ))}
            </div>
            <button
              type="button"
              className={`btn small folder-browser-toggle${
                showHidden ? " on" : ""
              }`}
              title={showHidden
                ? t("chrome.folderBrowser.hideHidden")
                : t("chrome.folderBrowser.showHidden")}
              aria-label={showHidden
                ? t("chrome.folderBrowser.hideHidden")
                : t("chrome.folderBrowser.showHidden")}
              onClick={() => {
                setShowHidden((prev) => !prev);
                // The toggle is not a place to stay: the keyboard returns to
                // the list (its rows are operated with ↑/↓ and Enter).
                listRef.current?.focus();
              }}
            >
              {showHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </button>
            <button
              type="button"
              className="btn small"
              title={t("chrome.folderBrowser.goUp")}
              aria-label={t("chrome.folderBrowser.goUp")}
              disabled={!open?.parent}
              onClick={() => open?.parent && void openFolder(open.parent)}
            >
              <IconArrowUp size={14} />
            </button>
          </div>

          <div
            ref={listRef}
            className={`folder-browser-list${loading ? " loading" : ""}`}
            role="listbox"
            aria-label={open?.path}
            aria-busy={loading}
            tabIndex={0}
            onKeyDown={onListKeyDown}
            // A click inside the list (its rows are not tab stops) keeps the
            // keyboard on the list: otherwise Enter would activate whatever
            // still has focus — the place button the user just used, say —
            // instead of opening the selected folder.
            onClick={() => listRef.current?.focus()}
          >
            {!open && (
              <div className="folder-browser-empty">
                {loading
                  ? t("common.loading")
                  : t("chrome.folderBrowser.chooseStart")}
              </div>
            )}
            {entries.map((entry) => (
              <EntryRow
                key={entry.path}
                entry={entry}
                selected={entry.path === selected}
                onSelect={setSelected}
                onOpen={(path) => void openFolder(path)}
                tapOpens={touch}
              />
            ))}
            {open && open.entries.length === 0 && (
              <div className="folder-browser-empty">
                {t("chrome.folderBrowser.emptyFolder")}
              </div>
            )}
            {
              /* An empty *listing* is not an empty folder: the hidden entries
             * are simply out of sight (and the toggle in the toolbar brings
             * them back). */
            }
            {open && open.entries.length > 0 && entries.length === 0 && (
              <div className="folder-browser-empty">
                {t("chrome.folderBrowser.hiddenOnly")}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onBack}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="btn primary"
          title={target ?? undefined}
          disabled={target === null}
          onClick={() => target && onAdd(target)}
        >
          {targetName === ""
            ? t("chrome.folderBrowser.selectThis")
            : t("chrome.folderBrowser.selectNamed", { name: targetName })}
        </button>
      </div>
    </>
  );
}
