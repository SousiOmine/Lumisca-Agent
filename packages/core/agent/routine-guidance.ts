/**
 * What a routine run is told about speaking, on top of the session's prompt.
 *
 * A routine runs with nobody watching, and most of what it does is routine by
 * design: a deploy check that passes, an inbox with nothing in it. The
 * session prompt already says that a run with nothing to report replies with
 * exactly NO_RESPONSE (see silent-reply.ts), but that sentence is written for
 * a conversation the user is holding. A scheduled run reads the routine's
 * prompt as an instruction to report, so it answers every time — and every
 * answer is a row in the transcript, read again on the next run, forever.
 *
 * The guidance below says the part the session prompt does not: that the
 * silence applies here, and that the routine's prompt decides which outcome
 * is the silent one. It is appended to the ROUTINE's prompt (not the system
 * prompt) because it only holds for this run: the same conversation's next
 * turn is the user's, and it speaks.
 *
 * `runRoutine` sends it as the tail of the prompt. A routine whose prompt
 * ends in prose reads it as an instruction; a routine that reports nothing
 * ends with the sentinel and leaves no row in the conversation.
 */
export const ROUTINE_SILENCE_GUIDANCE =
  'This is a scheduled run of a routine, not a conversation the user is holding. Read the routine\'s prompt above as the instruction for what to check, and let it decide what counts as something to report. If this run found nothing worth telling the user, end with exactly NO_RESPONSE and nothing else: no summary, no "nothing to report", no all-clear, and no note about staying silent. Say something only when the user would act on it.';
