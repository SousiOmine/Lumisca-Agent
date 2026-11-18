/**
 * The two waits every command path shares.
 *
 * `bash` and `async_bash` run the same commands, only one at a time or in
 * the background. Their kill and flush bounds were defined twice with the
 * same values; a change to one side alone would make the foreground and the
 * background disagree about how long a killed process may take to settle.
 */

/** How long a finished process's pipe readers get to flush the last output
 * before the operation that ended it reports what it has (the completion
 * notification for a background command, the tool result for bash).
 * Descendants that keep the pipe open must not block that report. */
export const FINAL_FLUSH_GRACE_MS = 250;

/** Upper bound for a kill to wait for the process to actually die. */
export const KILL_WAIT_MS = 3000;

/** Upper bound for a kill to settle: death plus the final flush. Waiting for
 * death alone would resolve a kill while the record still says "running". */
export const KILL_SETTLE_WAIT_MS = KILL_WAIT_MS + FINAL_FLUSH_GRACE_MS;
