import { useCallback, useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import { useT } from "../i18n.ts";
import { useAsyncEffect } from "./useAsync.ts";
import type { InitialData, Workspace } from "../types.ts";
import { confirmAction } from "../confirm.ts";

/** Workspace state of the server this window displays: the list, plus the
 * shared create/update/delete flows. `loaded` tells whether that list has
 * arrived (a failed load counts too — the list is then known to be
 * unusable, and callers must not wait for it forever).
 *
 * The list is this server's own. Switching machines is the desktop title
 * bar's job (`components/ConnectionPicker.tsx`), which navigates the window
 * to another server; the page then loads that server's workspaces. The
 * bootstrap data is a preview of the same list, so it seeds the first paint
 * and the API read replaces it. */
export function useWorkspaces(initialData?: InitialData) {
  /** Message lookup of the app language (the delete confirmation is a
   * catalogue string). */
  const t = useT();
  const [workspaces, setWorkspaces] = useState<Workspace[]>(
    initialData?.workspaces ?? [],
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useAsyncEffect(async (isStale) => {
    setLoadError(null);
    try {
      const list = await api.listWorkspaces();
      if (isStale()) return;
      setWorkspaces(list);
    } catch (error) {
      // A stale failure must not overwrite the newer list's verdict.
      if (!isStale()) setLoadError(errorText(error));
    } finally {
      // Loaded either way: a failure leaves an unusable list, but waiting
      // for it would block the draft screen's fallback forever.
      if (!isStale()) setLoaded(true);
    }
  }, []);

  /** Insert or replace a workspace after it was created/edited. */
  const handleWorkspaceChanged = useCallback((ws: Workspace) => {
    setWorkspaces((prev) =>
      prev.some((w) => w.id === ws.id)
        ? prev.map((w) => (w.id === ws.id ? ws : w))
        : [ws, ...prev]
    );
  }, []);

  const handleWorkspaceDeleted = useCallback((id: string) => {
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
  }, []);

  /** The single delete flow (confirm + API + state), shared by the draft
   * tab and the workspace edit modal. */
  const deleteWorkspace = useCallback(async (ws: Workspace) => {
    if (
      !confirmAction(
        t("common.workspaceDeleteConfirm", { name: ws.name }),
      )
    ) {
      return;
    }
    await api.deleteWorkspace(ws.id);
    handleWorkspaceDeleted(ws.id);
  }, [handleWorkspaceDeleted, t]);

  return {
    workspaces,
    loadError,
    loaded,
    handleWorkspaceChanged,
    deleteWorkspace,
  };
}
