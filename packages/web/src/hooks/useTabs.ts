import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "preact/compat";
import {
  type SessionInfoDto,
  type SessionSnapshot,
  sessionApi,
} from "../api.ts";
import { applyRunState } from "../events.ts";
import { DRAFT_TAB } from "../tabs.ts";
import { emptyView, type SessionView, type TodoPhase } from "../types.ts";

/** View state for a tab opened from a snapshot: every piece of live state
 * comes from the snapshot (the same instant as its transcript), so a failure
 * or a question that happened without a connected UI is not silently hidden,
 * a title generated meanwhile is shown, and a run that is still going does
 * not render as finished — its `agent_start` is never replayed (see
 * applyRunState). */
function viewOf(
  info: SessionInfoDto,
  snapshot: SessionSnapshot,
  todos: TodoPhase[] = [],
): SessionView {
  const v = emptyView(info, snapshot);
  v.error = snapshot.error;
  v.todos = todos;
  v.pendingQuestions = snapshot.questions;
  if (v.info.name !== snapshot.name) {
    v.info = { ...v.info, name: snapshot.name };
  }
  return applyRunState(v, snapshot.running);
}

/** What the tab strip and the chat body read of the open tabs. */
export interface TabsControls {
  /** The sessions this page has open, in the order they were opened. Not the
   * strip: the draft tab is not a session (it is the `/code` screen), so a
   * caller that prunes per-session state uses this list, and one that draws
   * the bar uses `strip`. */
  open: string[];
  /** The strip: `open`, plus the draft tab while `/code` is the screen. */
  strip: string[];
  /** The address names a session whose view is not here yet: the body shows
   * the wait rather than the new-session screen, which would otherwise flash
   * under the address of a session. */
  loading: boolean;
  /** Drop tabs (the closes), telling their sessions about it. The caller
   * navigates away from the shown session FIRST: closing the tab the address
   * names would leave the URL pointing at a screen that is gone. */
  closeTabs: (ids: string[], keepRunning?: ReadonlySet<string>) => void;
  /** Put a session in the strip whose view the caller already has (a session
   * it just created): the address reaches the strip on the next render, and
   * without this the session would be read back from the server the moment
   * it appears there. */
  adopt: (key: string) => void;
}

/**
 * The open tabs, and the one the address bar names.
 *
 * The address IS the open tab: `/code/s/<id>` shows that session and `/code`
 * shows the draft. Moving between tabs is therefore a navigation, and the
 * strip is written to match — a session the address names but the page has
 * never drawn is read here, with the same three requests a restored tab
 * always needed (info, transcript snapshot, todo plan).
 *
 * Nothing is restored from `localStorage`: the URL already says what to open,
 * and a stored set would be a second answer to the same question — one that
 * silently overrode the address the reader had just typed or pasted.
 *
 * `activeTab` is an input, not a state. The strip is still a list (the
 * reader's way back to what they opened in this page), but its contents
 * follow the address rather than deciding it.
 */
export function useTabs(
  setViews: Dispatch<SetStateAction<Map<string, SessionView>>>,
  /** Seed the revision marker of a tab from the snapshot it was built from
   * (see useSessionEvents.seedRevision): a tab opened from a snapshot must
   * watch for lost frames from the snapshot it started with, not from its
   * next full sync. */
  seedRevision: (key: string, rev: number) => void,
  /** Fetch and merge one tab's panel snapshots (see
   * useSessionEvents.resyncPanels). A tab opened on a session whose run is
   * still going needs them: a run left going by "close and keep running" can
   * have sub-agent tasks and background commands that no event has described
   * to this page yet. */
  resyncPanels: (key: string) => void,
  /** Forget a closed tab's revision marker (see
   * useSessionEvents.forgetRevisions): the map is only ever added to, so a
   * page that opens and closes many tabs must drop what it no longer reads. */
  forgetRevisions: (keys: Iterable<string>) => void,
  /** The tab key the route names, or null for the draft screen. */
  activeTab: string | null,
  /** The session could not be opened (it was deleted, or the peer that owns
   * it does not answer). The App takes the reader back to the mode's top: an
   * address naming a screen this page cannot draw is not a screen. */
  onUnopenable: (key: string) => void,
): TabsControls {
  /** The sessions this page has open, in the order they were opened. */
  const [tabs, setTabs] = useState<string[]>([]);
  /** Reads in flight, by key. A re-render of the same address must not read
   * the same session twice; a ref rather than state, because the guard is
   * not something to draw. */
  const pending = useRef(new Set<string>());
  /** Sessions whose read failed. The address may keep naming one (a stale
   * bookmark, a peer that went away) for a render or two, and remembering
   * the failure is what keeps the fallback from being attempted on every
   * render. Cleared when the address stops naming a session, so a later
   * visit tries again — the session may have been reopened since. */
  const failed = useRef(new Set<string>());

  const onUnopenableRef = useRef(onUnopenable);
  onUnopenableRef.current = onUnopenable;

  /** Read one session into a tab, or do nothing when it is already there. */
  const open = useCallback(
    (key: string) => {
      if (key === DRAFT_TAB || pending.current.has(key)) return;
      pending.current.add(key);
      void (async () => {
        try {
          const [info, snapshot, todo] = await Promise.all([
            sessionApi(key).getSession(),
            sessionApi(key).getMessages(),
            sessionApi(key).getTodo(),
          ]);
          setTabs((prev) => (prev.includes(key) ? prev : [...prev, key]));
          setViews((prev) => {
            const next = new Map(prev);
            next.set(key, viewOf(info, snapshot, todo.todos));
            return next;
          });
          // The tab starts watching for lost frames from this snapshot.
          seedRevision(key, snapshot.rev);
          if (snapshot.running) resyncPanels(key);
        } catch {
          // The session is gone, or its peer does not answer. The App
          // navigates to the mode's top, which clears the markers below.
          failed.current.add(key);
          onUnopenableRef.current(key);
        } finally {
          pending.current.delete(key);
        }
      })();
      // The three callbacks are the App's own (stable); the ref carries the
      // one value that changes.
    },
    [setViews, seedRevision, resyncPanels],
  );

  // The address names the session: open it unless the strip already holds
  // it. A tab the strip holds keeps its live state — reading it again would
  // throw away the events that streamed since — so only a session this page
  // has never drawn is read.
  useEffect(() => {
    if (activeTab === null || activeTab === DRAFT_TAB) {
      // The address no longer names a session, so nothing is left to retry
      // against: a later visit reads the session afresh.
      failed.current.clear();
      return;
    }
    if (tabs.includes(activeTab)) return;
    if (failed.current.has(activeTab)) return;
    open(activeTab);
  }, [activeTab, tabs, open]);

  /** Close the given tabs: drop the tabs and their views, and tell the
   * owning server about the sessions among them — except the ones named in
   * `keepRunning`, whose `POST /close` is skipped, so a run that is still
   * going keeps working on the server (the tab is gone, the session stays
   * open, and reopening it from the session history rejoins the run). The
   * App asks before it takes the `POST /close` route for a running tab (see
   * CloseTabsDialog) and navigates away from the shown one first. */
  const closeTabs = useCallback(
    (ids: string[], keepRunning?: ReadonlySet<string>) => {
      const toClose = new Set(ids);
      for (const id of ids) {
        if (id !== DRAFT_TAB && !keepRunning?.has(id)) {
          sessionApi(id).close().catch(console.error);
        }
      }
      forgetRevisions(ids);
      setTabs((prev) => prev.filter((id) => !toClose.has(id)));
      setViews((prev) => {
        const next = new Map(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    [setViews, forgetRevisions],
  );

  const adopt = useCallback((key: string) => {
    setTabs((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, []);

  const atTop = activeTab === null || activeTab === DRAFT_TAB;
  // The draft tab is in the strip while the draft is the screen, at the end:
  // that is where "+" has always put it, and where a started session's tab
  // appears. A session being read is not in the strip yet — `loading` says
  // why the body is empty, and the tab arrives with its view.
  const strip = atTop ? [...tabs, DRAFT_TAB] : [...tabs];
  const loading = !atTop && !tabs.includes(activeTab);

  return { open: tabs, strip, loading, closeTabs, adopt };
}
