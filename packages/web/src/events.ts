/**
 * A session view's state transitions, split by what they are about.
 *
 * The module used to be one 916-line file holding the identity rules, two
 * merge algorithms, five equality checks, the snapshot application and the
 * event switch. They are four different jobs:
 *
 * - `./identity.ts` — what tells two messages apart, and how a freshly read
 *   window is folded into what a view holds;
 * - `./reducer.ts` — one live event applied to a view (the streaming case);
 * - `./equality.ts` — whether a server snapshot says anything new (the
 *   resync must not re-render a tab that is already in step);
 * - `./snapshot.ts` — the resync itself: fetched pieces applied to a view;
 * - `./merge.ts` — the window merge both transcripts share, with no session
 *   type in sight.
 *
 * This barrel keeps the existing import sites (`../events.ts`) working: what
 * a caller may use is the union, and which file holds it is an implementation
 * detail.
 */
export {
  applyRunState,
  filterRemoved,
  type LoadedHistory,
  mergeNewestWindow,
  messageKey,
  prependOlderWindow,
} from "./events/identity.ts";
export { applyEvent } from "./events/reducer.ts";
export {
  revisionGap,
  sameBackgrounds,
  sameGoal,
  sameQuestions,
  sameTasks,
  sameTodoPlan,
} from "./events/equality.ts";
export {
  applySnapshot,
  type LiveStateBefore,
  mergeBackgrounds,
  mergeTasks,
  type SnapshotParts,
} from "./events/snapshot.ts";
export {
  type LoadedWindow,
  mergeNewestWindow as mergeWindow,
  type MergeRules,
  prependHistoricWindow,
  prependOlderWindow as prependPage,
} from "./events/merge.ts";
