import { useCallback, useEffect, useState } from "react";
import { fed, workspaceApi } from "../api.ts";
import { errorText } from "../providers.ts";
import type { FederatedWorkspace, InitialData, PeerStatus } from "../types.ts";

/** Workspace + peer state: the federated workspace list with peer
 * reachability, plus the shared create/update/delete flows. `loaded` tells
 * whether the workspace list has arrived (initial data counts as loaded;
 * a failed load counts too — the list is then known to be empty/unusable,
 * and callers must not wait for it forever). */
export function useWorkspaces(initialData?: InitialData) {
  const [workspaces, setWorkspaces] = useState<FederatedWorkspace[]>(
    initialData?.workspaces.map((ws) => ({
      peerId: "",
      peerName: "",
      workspace: ws,
    })) ?? [],
  );
  const [peers, setPeers] = useState<PeerStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(initialData !== undefined);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // The federated list: this server's workspaces plus every peer's,
      // with peer reachability for the picker.
      const result = await fed.workspaces();
      setWorkspaces(result.workspaces);
      setPeers(result.peers);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      // Loaded either way: a failure leaves an empty/unusable list, but
      // waiting for it would block the draft screen's fallback forever.
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // The bootstrap script already provides the data; refresh only when it
    // is absent.
    if (!initialData) load();
  }, [load, initialData]);

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
        `ワークスペース「${fws.workspace.name}」を削除しますか？`,
      )
    ) {
      return;
    }
    await workspaceApi(fws.peerId).delete(fws.workspace.id);
    handleWorkspaceDeleted(fws.peerId, fws.workspace.id);
  }, [handleWorkspaceDeleted]);

  return {
    workspaces,
    peers,
    loadError,
    loaded,
    handleWorkspaceChanged,
    deleteWorkspace,
  };
}
