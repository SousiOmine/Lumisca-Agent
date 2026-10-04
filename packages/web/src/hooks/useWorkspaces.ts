import { useCallback, useEffect, useState } from "preact/compat";
import { fed, workspaceApi } from "../api.ts";
import { errorText } from "../providers.ts";
import { useT } from "../i18n.ts";
import { useAsyncEffect } from "./useAsync.ts";
import type { FederatedWorkspace, InitialData, PeerStatus } from "../types.ts";

/** Custom event dispatched after the connection registry (settings →
 * 接続先サーバー) is mutated, so the federated list is re-read without a
 * page reload: both the peer picker and the workspace list come from it. */
export const CONNECTIONS_UPDATED_EVENT = "lumisca:connections-updated";

/** Announce a connection registry change (save / delete). */
export function notifyConnectionsUpdated(): void {
  globalThis.dispatchEvent(new CustomEvent(CONNECTIONS_UPDATED_EVENT));
}

/** Workspace + peer state: the federated workspace list with peer
 * reachability, plus the shared create/update/delete flows. `loaded` tells
 * whether that list has arrived (a failed load counts too — the list is
 * then known to be empty/unusable, and callers must not wait for it
 * forever). The bootstrap data is only a preview of THIS server's
 * workspaces, so it never stands in for the load: the peers it does not
 * know about are exactly what the picker offers. */
export function useWorkspaces(initialData?: InitialData) {
  /** Message lookup of the app language (the delete confirmation is a
   * catalogue string). */
  const t = useT();
  const [workspaces, setWorkspaces] = useState<FederatedWorkspace[]>(
    initialData?.workspaces.map((ws) => ({
      peerId: "",
      peerName: "",
      workspace: ws,
    })) ?? [],
  );
  const [peers, setPeers] = useState<PeerStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Bumped to re-read the list (bootstrap and registry changes both land
   * here). */
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useAsyncEffect(async (isStale) => {
    setLoadError(null);
    try {
      // The federated list: this server's workspaces plus every peer's,
      // with peer reachability for the picker.
      const result = await fed.workspaces();
      if (isStale()) return;
      setWorkspaces(result.workspaces);
      setPeers(result.peers);
    } catch (error) {
      // A stale failure must not overwrite the newer list's verdict.
      if (!isStale()) setLoadError(errorText(error));
    } finally {
      // Loaded either way: a failure leaves an unusable list, but waiting
      // for it would block the draft screen's fallback forever.
      if (!isStale()) setLoaded(true);
    }
  }, [nonce]);

  useEffect(() => {
    globalThis.addEventListener(CONNECTIONS_UPDATED_EVENT, reload);
    return () => {
      globalThis.removeEventListener(CONNECTIONS_UPDATED_EVENT, reload);
    };
  }, [reload]);

  /** Insert or replace a workspace after it was created/edited. */
  const handleWorkspaceChanged = useCallback((fws: FederatedWorkspace) => {
    setWorkspaces((prev) => {
      const exists = prev.some(
        (w) => w.peerId === fws.peerId && w.workspace.id === fws.workspace.id,
      );
      if (exists) {
        return prev.map((w) =>
          w.peerId === fws.peerId && w.workspace.id === fws.workspace.id
            ? fws
            : w
        );
      }
      return [fws, ...prev];
    });
  }, []);

  const handleWorkspaceDeleted = useCallback((peerId: string, id: string) => {
    setWorkspaces((prev) =>
      prev.filter((w) => !(w.peerId === peerId && w.workspace.id === id))
    );
  }, []);

  /** The single delete flow (confirm + API + state), shared by the draft
   * tab and the workspace edit modal. Remote workspaces are deleted on the
   * peer that owns them. */
  const deleteWorkspace = useCallback(async (fws: FederatedWorkspace) => {
    if (
      !globalThis.confirm(
        t("common.workspaceDeleteConfirm", { name: fws.workspace.name }),
      )
    ) {
      return;
    }
    await workspaceApi(fws.peerId).delete(fws.workspace.id);
    handleWorkspaceDeleted(fws.peerId, fws.workspace.id);
  }, [handleWorkspaceDeleted, t]);

  return {
    workspaces,
    peers,
    loadError,
    loaded,
    handleWorkspaceChanged,
    deleteWorkspace,
  };
}
