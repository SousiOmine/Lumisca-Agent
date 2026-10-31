import { useEffect, useRef, useState } from "preact/compat";
import {
  IconChevronDown,
  IconPlus,
  IconServer,
  IconSettings,
} from "@tabler/icons-preact";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import {
  connectionLabel,
  CONNECTIONS_UPDATED_EVENT,
  displayedConnectionId,
  serverLabel,
} from "../connections.ts";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useT } from "../i18n.ts";
import { shellCall, type ShellState } from "../shell.ts";
import type { ConnectionEntry } from "../types.ts";

interface ConnectionPickerProps {
  /** Open settings → 接続先サーバー (the place servers are added and edited). */
  onManage: () => void;
}

/**
 * Which server this window shows, and how to show another one.
 *
 * The registry lives in the server's database and is shared, but *which* of
 * the entries the window displays is the shell's state: it survives
 * navigation (the page is reloaded onto the chosen server) and a restart.
 * Before this control the answer was only visible inside settings → 接続先
 * サーバー, one dialog deeper than the question — a page served by a remote
 * machine looks exactly like the local one.
 *
 * It lives in the desktop title bar in the corner every desktop window keeps
 * its "where am I" affordance, beside the app menu. In a plain browser there
 * is no such ambiguity (the address bar is the answer) and no bridge to
 * switch with, so the title bar does not render and this control is not
 * shown.
 *
 * Both answers are read once on mount and refreshed when the settings
 * dialog saves into the registry. The shell's answer is fixed for the
 * lifetime of the page — switching servers navigates the window and loads
 * a new page — so it is not polled here; the title bar already polls it and
 * hands it over through `state` when it changes.
 *
 * The displayed name is the shell's: the registry of a REMOTE page is that
 * server's registry, which usually has no entry for itself, so matching the
 * display against this list cannot name it. The shell remembers the name of
 * the entry the window was switched to and reports it with the state.
 *
 * The popover is drawn by the app rather than by the platform (`<select>`
 * would be): it lists a switchable choice of whole servers with their
 * address, marks the current one, and ends with the two ways into the
 * registry, which a native list cannot carry.
 */
export function ConnectionPicker({ onManage }: ConnectionPickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ShellState | null>(null);
  const [servers, setServers] = useState<ConnectionEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useClickOutside(rootRef, () => setOpen(false), open);

  /** Read the displayed server and the registry together: the label of one
   * depends on the other. */
  const load = async () => {
    setError(null);
    try {
      const [{ connections }, shell] = await Promise.all([
        api.getConnections(),
        shellCall<ShellState>("state"),
      ]);
      setServers(connections);
      setState(shell);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // The settings dialog saves into the same registry: keep the list (and an
  // open popover) in step instead of showing the servers of the last read.
  useEffect(() => {
    const reload = () => void load();
    globalThis.addEventListener(CONNECTIONS_UPDATED_EVENT, reload);
    return () =>
      globalThis.removeEventListener(CONNECTIONS_UPDATED_EVENT, reload);
  }, []);

  const selected = state === null
    ? null
    : displayedConnectionId(servers ?? [], state);

  /** The current server's label: the name the shell was switched with, or —
   * for a server this page's registry knows nothing about — its origin. */
  const currentLabel = (): string => {
    if (state === null) return t("common.loading");
    if (state.mode === "local") return t("chrome.connections.local");
    const entry = (servers ?? []).find((s) => s.id === selected);
    if (entry !== undefined) return connectionLabel(entry);
    return serverLabel(state.name, state.url);
  };

  const connect = (target: ConnectionEntry | "local") => {
    setBusy(target === "local" ? "" : target.id);
    setError(null);
    const switching = target === "local"
      ? shellCall("connect-local")
      // The shell owns the navigation: passing the URL through the bridge
      // keeps the token out of this page's own history. The name travels
      // with it because the page that loads next cannot look it up: a
      // remote page's registry is that server's own.
      : shellCall("connect-remote", {
        url: target.url.trim(),
        token: target.token,
        name: connectionLabel(target),
      });
    void switching.then(
      () => {
        setBusy(null);
        setOpen(false);
      },
      (failure) => {
        setBusy(null);
        setError(errorText(failure));
      },
    );
  };

  return (
    <div className="connection-picker" ref={rootRef}>
      <button
        type="button"
        className="titlebar-btn connection-picker-trigger"
        onClick={() => {
          if (!open) void load();
          setOpen((value) => !value);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("chrome.connections.current", { name: currentLabel() })}
      >
        <IconServer size={14} />
        <span className="connection-picker-label">{currentLabel()}</span>
        <span className={`connection-picker-chevron${open ? " open" : ""}`}>
          <IconChevronDown size={13} />
        </span>
      </button>

      {open && (
        <div className="connection-picker-popover" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={state?.mode === "local"}
            className={`connection-option${
              state?.mode === "local" ? " selected" : ""
            }`}
            disabled={busy !== null}
            onClick={() => connect("local")}
          >
            <IconServer size={14} />
            <span className="connection-option-name">
              {t("chrome.connections.local")}
            </span>
          </button>

          {servers === null && (
            <p className="connection-picker-note">{t("common.loading")}</p>
          )}
          {servers !== null && servers.length === 0 && (
            <p className="connection-picker-note">
              {t("chrome.connections.empty")}
            </p>
          )}
          {servers?.map((server) => (
            <button
              key={server.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected === server.id}
              className={`connection-option${
                selected === server.id ? " selected" : ""
              }`}
              disabled={busy !== null}
              title={server.url}
              onClick={() => connect(server)}
            >
              <IconServer size={14} />
              <span className="connection-option-name">
                {connectionLabel(server)}
              </span>
            </button>
          ))}

          {error !== null && (
            <p className="error-text connection-picker-note" role="alert">
              {error}
            </p>
          )}

          <div className="connection-picker-sep" />
          <button
            type="button"
            role="menuitem"
            className="connection-option manage"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <IconSettings size={14} />
            <span className="connection-option-name">
              {t("chrome.connections.manage")}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="connection-option manage"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <IconPlus size={14} />
            <span className="connection-option-name">
              {t("chrome.connections.add")}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
