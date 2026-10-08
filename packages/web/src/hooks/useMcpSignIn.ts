import { useEffect, useRef, useState } from "preact/compat";
import { serializeMcpServers } from "@lumisca/core/shared";
import type { McpAuthSnapshot, McpServerInfo } from "../types.ts";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import { useT } from "../i18n.ts";

/** Cadence of the status poll while a sign-in waits for the browser. The
 * flow itself runs on the server (the OAuth callback finishes it); the UI
 * only has to notice that it ended. */
const POLL_MS = 1200;

/** How long the copy button says "copied" (same as the provider login's
 * device-code copy). */
const COPIED_NOTICE_MS = 2000;

export interface McpSignIn {
  /** A sign-in is being started or waits for the browser (drives the
   * button's spinner and its waiting label). */
  pending: boolean;
  error: string | null;
  /** Where the user has to authorize, once the flow reached that point.
   * The sign-in opens it in a new tab; a WebView that refuses to open
   * windows (the desktop app) shows this so the user can copy it instead —
   * the callback is on this server's own origin either way. */
  authorizationUrl: string | null;
  /** The URL was just copied (the button's confirmation). */
  copied: boolean;
  /** Start a sign-in for one server and open the authorization page. */
  start: (server: McpServerInfo) => Promise<void>;
  /** Give up on the running sign-in. */
  cancel: () => Promise<void>;
  /** Put the authorization URL on the clipboard (the WebView fallback). */
  copyUrl: () => Promise<void>;
}

/**
 * Drive one interactive MCP OAuth sign-in from the settings UI: start it on
 * the server, open the authorization page it answers with, then poll until
 * the flow ends. `onDone` runs once it completed — the caller re-tests the
 * server (the detail form) or reloads the list, now that the grant exists.
 */
export function useMcpSignIn(onDone: () => void): McpSignIn {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  /** Latest completion callback, so polling never restarts because the
   * caller re-created it (it is usually an inline closure). */
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  /** Forget the running sign-in (the flow is over, one way or another). */
  const finish = (): void => {
    setSessionId(null);
    setAuthorizationUrl(null);
    setCopied(false);
  };

  /** A settled snapshot: completion calls back, anything else is shown. */
  const reportSettled = (snapshot: McpAuthSnapshot): void => {
    if (snapshot.status === "done") {
      done.current();
      return;
    }
    setError(
      snapshot.error !== undefined
        ? t("settings.mcp.authFailed", { error: snapshot.error })
        : t("settings.mcp.authStartFailed"),
    );
  };

  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    const poll = async () => {
      let snapshot: McpAuthSnapshot;
      try {
        snapshot = await api.getMcpAuth(sessionId);
      } catch (e) {
        if (cancelled) return;
        setError(errorText(e));
        finish();
        return;
      }
      if (cancelled) return;
      if (snapshot.status === "starting" || snapshot.status === "waiting") {
        pollTimer.current = setTimeout(poll, POLL_MS);
        return;
      }
      finish();
      if (snapshot.status === "done" || snapshot.status === "error") {
        reportSettled(snapshot);
      }
    };
    pollTimer.current = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(pollTimer.current);
    };
  }, [sessionId, t]);

  const start = async (server: McpServerInfo): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const snapshot = await api.startMcpAuth(serializeMcpServers([server]));
      if (snapshot.authorizationUrl !== undefined) {
        setAuthorizationUrl(snapshot.authorizationUrl);
        globalThis.open(snapshot.authorizationUrl, "_blank", "noopener");
      }
      if (snapshot.status === "waiting") {
        setSessionId(snapshot.sessionId);
        return;
      }
      // Settled within the request: the stored grant already worked (there
      // was nothing to authorize) or the flow never reached the browser.
      finish();
      reportSettled(snapshot);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    const id = sessionId;
    finish();
    if (id === null) return;
    try {
      await api.cancelMcpAuth(id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const copyUrl = async (): Promise<void> => {
    if (authorizationUrl === null) return;
    try {
      await navigator.clipboard.writeText(authorizationUrl);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(
        () => setCopied(false),
        COPIED_NOTICE_MS,
      );
    } catch (e) {
      setError(errorText(e));
    }
  };

  return {
    pending: busy || sessionId !== null,
    error,
    authorizationUrl,
    copied,
    start,
    cancel,
    copyUrl,
  };
}
