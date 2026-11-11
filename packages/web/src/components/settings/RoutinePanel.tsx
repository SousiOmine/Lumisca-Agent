import type {
  MessageKey,
  MessageParams,
  RoutineSchedule,
  RoutineStatus,
} from "@lumisca/core/shared";
import { errorMessage } from "@lumisca/core/shared";
import {
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-preact";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/compat";
import { NEVER, useVisibleInterval } from "../../hooks/useVisibleInterval.ts";
import { useLocale, useT } from "../../i18n.ts";
import type { RoutineView } from "../../types.ts";
import { SettingsSection } from "./SettingsSection.tsx";

/**
 * Routines: the requests this conversation runs on a schedule.
 *
 * The panel is a list, not an editor. A routine's name and request are things
 * the user said in a conversation, so the agent writes them (the `routine_*`
 * tools); what the user needs here is the state — when it fires next, how the
 * last run went — and the four actions that belong to a person's judgment:
 * turn it off, run it now, stop a run, delete it.
 *
 * The list polls only while something is running: "running now" is the one
 * fact that changes without a request from this screen.
 */

export type { RoutineView } from "../../types.ts";

/** How often the list re-reads itself while a run is going. */
const RUNNING_POLL_MS = 3_000;

const WEEKDAY_KEYS: readonly MessageKey[] = [
  "panels.routine.weekday.1",
  "panels.routine.weekday.2",
  "panels.routine.weekday.3",
  "panels.routine.weekday.4",
  "panels.routine.weekday.5",
  "panels.routine.weekday.6",
  "panels.routine.weekday.7",
];

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The schedule in the app's words ("every day at 08:30", "every 30
 * minutes"). Exported so the conversation can describe a routine the same
 * way the list does. */
export function scheduleLabel(schedule: RoutineSchedule, t: Translate): string {
  switch (schedule.kind) {
    case "daily":
      return t("panels.routine.schedule.daily", { time: schedule.time });
    case "weekly": {
      const days = [...schedule.days]
        .sort((a, b) => a - b)
        .map((day) => t(WEEKDAY_KEYS[day - 1] ?? WEEKDAY_KEYS[0]!))
        .join(" ");
      return t("panels.routine.schedule.weekly", {
        days,
        time: schedule.time,
      });
    }
    case "every":
      return t("panels.routine.schedule.every", {
        minutes: String(schedule.minutes),
      });
    case "once":
      // The stored text already reads as the machine's clock
      // (`YYYY-MM-DD HH:MM`), like the bare `08:30` the daily shape shows.
      return t("panels.routine.schedule.once", { at: schedule.at });
    case "watch":
      return t("panels.routine.schedule.watch", {
        minutes: String(schedule.everyMinutes),
        what: watchSourceLabel(schedule.source, t),
      });
  }
}

/** What a watch reads, in the list's words. The condition is part of it: a
 * routine that fires when a page's body changes and one that fires when its
 * status changes are different routines. */
export function watchSourceLabel(
  source: Extract<RoutineSchedule, { kind: "watch" }>["source"],
  t: Translate,
): string {
  switch (source.kind) {
    case "http": {
      const condition =
        source.expect.status !== undefined
          ? t("panels.routine.watch.status", {
              status: String(source.expect.status),
            })
          : source.expect.hash === true
            ? t("panels.routine.watch.bodyChanged")
            : t("panels.routine.watch.contains", {
                text: JSON.stringify(source.expect.includes ?? ""),
              });
      return t("panels.routine.watch.http", { url: source.url, condition });
    }
    case "file": {
      const condition =
        source.compare === "hash"
          ? t("panels.routine.watch.content")
          : t("panels.routine.watch.modified");
      return t("panels.routine.watch.file", {
        path: source.path,
        condition,
      });
    }
    case "command": {
      const condition =
        source.expect.exitCode !== undefined
          ? t("panels.routine.watch.exit", {
              code: String(source.expect.exitCode),
            })
          : t("panels.routine.watch.contains", {
              text: JSON.stringify(source.expect.includes ?? ""),
            });
      return t("panels.routine.watch.command", {
        command: source.command,
        condition,
      });
    }
    case "mcp": {
      // The args are left out: this list row is one line, and the tool's
      // name is what the user recognizes. The condition is what makes two
      // watches of the same tool different routines.
      const condition =
        "ids" in source.expect
          ? t("panels.routine.watch.newItem")
          : t("panels.routine.watch.valueChanged");
      return t("panels.routine.watch.mcp", {
        server: source.server,
        tool: source.tool,
        condition,
      });
    }
  }
}

/** One timestamp as the user reads it (their language's short date and
 * time), or a dash when there is none. */
function formatWhen(at: number | null, locale: string): string {
  if (at === null) return "—";
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

function statusKey(status: RoutineStatus | null): MessageKey | null {
  switch (status) {
    case "ok":
      return "panels.routine.status.ok";
    case "error":
      return "panels.routine.status.error";
    case "stopped":
      return "panels.routine.status.stopped";
    case "skipped":
      return "panels.routine.status.skipped";
    default:
      return null;
  }
}

export interface RoutinePanelProps {
  /** The routines of the agent whose conversation is open (empty when none
   * exists yet). */
  routines: RoutineView[];
  loading: boolean;
  error: string | null;
  agentName: string | null;
  onRefresh: () => void;
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>;
  onRun: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/**
 * The routines panel of the settings dialog.
 *
 * Creating one is not offered here: a routine is a request the agent writes
 * from what the user said ("every morning, check the deploy"), and a form
 * would ask the user to restate it. The empty state says how to make one.
 */
export function RoutinePanel({
  routines,
  loading,
  error,
  agentName,
  onRefresh,
  onSetEnabled,
  onRun,
  onStop,
  onDelete,
}: RoutinePanelProps) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Poll while a run is going OR waiting: both change without a request
  // from this screen (a queued run starts when the conversation frees), and
  // a list that showed "waiting" for ever would be worse than one that
  // catches up.
  const hasRunning = useMemo(
    () => routines.some((routine) => routine.running || routine.queued),
    [routines],
  );
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);
  // Follow a running routine until it finishes. A hidden page does not
  // poll: the list is re-read by the visibility handler when the user
  // returns (see useVisibleInterval), which is when they could see it.
  useVisibleInterval(
    () => refreshRef.current(),
    hasRunning ? RUNNING_POLL_MS : NEVER,
  );

  const act = useCallback(async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    setActionError(null);
    try {
      await action();
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <SettingsSection
      description={
        agentName === null
          ? t("panels.routine.noAgent")
          : t("panels.routine.description", { agent: agentName })
      }
      action={
        <button
          type="button"
          className="btn"
          onClick={onRefresh}
          title={t("common.reload")}
          aria-label={t("common.reload")}
        >
          <IconRefresh size={14} />
        </button>
      }
    >
      {loading && <p className="settings-note">{t("common.loading")}</p>}
      {error !== null && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {actionError !== null && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}

      {!loading && error === null && routines.length === 0 && (
        <p className="settings-note">{t("panels.routine.empty")}</p>
      )}

      <ul className="routine-list">
        {routines.map((routine) => {
          const status = statusKey(routine.lastStatus);
          // A waiting run and a running one are both "in flight" for the
          // actions below, but only one of them is working.
          const inFlight = routine.running || routine.queued;
          return (
            <li
              key={routine.id}
              className={`routine-row${routine.enabled ? "" : " disabled"}`}
            >
              <div className="routine-main">
                <div className="routine-title">
                  <span className="routine-name">{routine.name}</span>
                  {routine.running && (
                    <span className="routine-badge running">
                      {t("panels.routine.status.running")}
                    </span>
                  )}
                  {routine.queued && (
                    <span className="routine-badge">
                      {t("panels.routine.queued")}
                    </span>
                  )}
                  {!routine.enabled && (
                    <span className="routine-badge">
                      {t("panels.routine.disabled")}
                    </span>
                  )}
                </div>
                <div className="routine-meta">
                  <span>{scheduleLabel(routine.schedule, t)}</span>
                  <span>·</span>
                  <span>
                    {t("panels.routine.next", {
                      when: formatWhen(routine.nextRunAt, locale),
                    })}
                  </span>
                  {status !== null && (
                    <>
                      <span>·</span>
                      <span
                        className={
                          routine.lastStatus === "error"
                            ? "error-text"
                            : undefined
                        }
                      >
                        {t("panels.routine.last", {
                          status: t(status),
                          when: formatWhen(routine.lastRunAt, locale),
                        })}
                      </span>
                    </>
                  )}
                  {/* A check is not a run: its own line keeps "last run"
                      honest while a stopped machine keeps being checked. */}
                  {routine.watchCheckedAt !== undefined && (
                    <>
                      <span>·</span>
                      <span
                        className={
                          routine.watchError === undefined
                            ? undefined
                            : "error-text"
                        }
                      >
                        {routine.watchError === undefined
                          ? t("panels.routine.checked", {
                              when: formatWhen(routine.watchCheckedAt, locale),
                            })
                          : t("panels.routine.checkFailed", {
                              when: formatWhen(routine.watchCheckedAt, locale),
                            })}
                      </span>
                    </>
                  )}
                </div>
                <p className="routine-prompt">{routine.prompt}</p>
                {routine.watchError !== undefined && (
                  <p className="routine-detail error-text">
                    {routine.watchError}
                  </p>
                )}
                {routine.lastDetail !== null && (
                  <p className="routine-detail">{routine.lastDetail}</p>
                )}
              </div>
              <div className="routine-actions">
                {inFlight ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === routine.id}
                    onClick={() => act(routine.id, () => onStop(routine.id))}
                  >
                    <IconPlayerStop size={14} />
                    {t("panels.routine.stop")}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === routine.id}
                      onClick={() => act(routine.id, () => onRun(routine.id))}
                    >
                      <IconPlayerPlay size={14} />
                      {t("panels.routine.run")}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === routine.id}
                      onClick={() =>
                        act(routine.id, () =>
                          onSetEnabled(routine.id, !routine.enabled),
                        )
                      }
                    >
                      {routine.enabled
                        ? t("panels.routine.disable")
                        : t("panels.routine.enable")}
                    </button>
                  </>
                )}
                {confirming === routine.id ? (
                  <>
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busy === routine.id}
                      onClick={() =>
                        act(routine.id, async () => {
                          await onDelete(routine.id);
                          setConfirming(null);
                        })
                      }
                    >
                      {t("common.delete")}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setConfirming(null)}
                    >
                      {t("common.cancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === routine.id}
                    onClick={() => setConfirming(routine.id)}
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                  >
                    <IconTrash size={14} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
