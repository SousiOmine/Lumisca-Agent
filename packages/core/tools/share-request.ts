/**
 * `share_request` and `share_disconnect`: the two ways an agent asks about a
 * folder on the user's own computer.
 *
 * The file tools already reach a lent folder, and `share_upload` /
 * `share_download` move bytes through it — but neither can make a folder
 * appear, because only the user can lend one (the OS picker is the consent),
 * and only their desktop shell can take one back. These two tools are the
 * agent's end of that conversation:
 *
 * - `share_request` puts a card in the conversation and stops the run until
 *   the user lends a folder, refuses, or the deadline passes;
 * - `share_disconnect` ends one loan the run is finished with.
 *
 * Both are discoverable rather than preloaded (see the built-in
 * `folder-share` skill): most conversations never touch the user's disk, and
 * a tool definition kept in every turn's context for that is a cost with no
 * gain. Both are main-only as well — a sub-agent must not put a question in
 * front of the user, and must not end a loan its parent is still working in.
 */
import { CoreError } from "../errors.ts";
import {
  type FolderGrant,
  grantAccess,
  isShareName,
  shareRootOf,
} from "../share/grant.ts";
import {
  SHARE_DISCONNECT_TIMEOUT_MS,
  SHARE_LEND_TIMEOUT_MS,
  type ShareRequestHub,
  type ShareRequestOutcome,
} from "../share/request.ts";
import { TOOL_SHARE_DISCONNECT, TOOL_SHARE_REQUEST } from "../shared/mod.ts";
import {
  object,
  type SchemaObject,
  type SchemaString,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";

/** Longest reason accepted for a request. It is a sentence the user reads in
 * a card, not a document; the limit is the hand-over's, so the two cards that
 * ask a user to do something keep the same room. */
export const MAX_SHARE_REASON_CHARS = 500;

/** How long the tool waits for a loan the user just made to reach the server.
 *
 * The shell writes the grant to the lending child's stdin, and the child
 * announces it over its own socket to this server: the card answers as soon
 * as the shell took the loan, which can be a moment before the server knows
 * it. Waiting here is what lets the result name the folder instead of
 * guessing at it. */
const LOAN_ARRIVAL_MS = 2_000;

/** How often to look while waiting (see LOAN_ARRIVAL_MS). */
const LOAN_ARRIVAL_POLL_MS = 100;

const requestSchema: SchemaObject<{ reason: SchemaString }> = object({
  reason: string(
    "Why you need a folder from the user's own computer, in one sentence " +
      'they will read in the card (e.g. "read the CSV exports in my ' +
      'Downloads folder").',
  ),
});

const disconnectSchema: SchemaObject<{ name: SchemaString }> = object({
  name: string(
    "The folder's name in the namespace: the segment after /lend/, e.g. " +
      "`proj` for /lend/proj. Not a path and not a folder on this machine.",
  ),
});

export interface ShareRequestToolOptions {
  /** The folders lent to this conversation, as the server knows them. Read
   * per call: a loan made while the conversation idles is there for the
   * next answer. */
  grants: () => readonly FolderGrant[];
  /** This session's request hub: both tools block inside it. */
  requests: ShareRequestHub;
  /** How long a `lend` answer waits for the loan to reach the server.
   * Overridable so a test does not sit through the production window. */
  loanArrivalMs?: number;
}

/**
 * `share_request`: ask the user to lend a folder and wait for one.
 *
 * The result is derived from the server's own list of loans, not from what
 * the card claims: the announcement is the truth, and a folder is usable
 * exactly while it appears there.
 */
export function createShareRequestTool(
  options: ShareRequestToolOptions,
): Tool<typeof requestSchema> {
  return {
    name: TOOL_SHARE_REQUEST,
    label: "Lent Folder Request",
    description:
      "Ask the user to lend you a folder from their own computer, and wait " +
      "while they choose one. A card appears in the conversation; its " +
      "button opens the folder dialog, where they pick the folder and its " +
      "terms. Lend them when the work needs files that are on THEIR disk " +
      "and not in your machine — do not ask for a folder that is already " +
      "lent, and do not ask again right after they refuse. If nobody " +
      `answers within ${minutesText()} the card closes and the tool returns ` +
      "without a folder.",
    parameters: requestSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const reason = params.reason.trim();
      if (reason.length === 0) {
        throw new CoreError("reason must not be empty", "invalid");
      }
      if (reason.length > MAX_SHARE_REASON_CHARS) {
        throw new CoreError(
          `reason must be at most ${MAX_SHARE_REASON_CHARS} characters ` +
            `(got ${reason.length})`,
          "invalid",
        );
      }
      if (options.requests.pendingShareRequest() !== null) {
        throw new CoreError(
          "The user is already being asked about a lent folder",
          "conflict",
        );
      }
      const known = options.grants().map((grant) => grant.id);
      const outcome = await options.requests.askLend(
        _id,
        reason,
        known,
        signal,
      );
      switch (outcome.kind) {
        case "lent": {
          const lent = await borrowed(
            options.grants,
            known,
            options.loanArrivalMs ?? LOAN_ARRIVAL_MS,
            signal,
          );
          if (lent === undefined) {
            return text(
              "The user shared a folder, but the loan has not reached the " +
                "server yet. Wait for the lent-folder notice before using " +
                "it, then address it by its /lend path.",
            );
          }
          return text(
            [
              "The user lent you a folder from their computer:",
              "",
              ...lent.map((grant) => `- ${describe(grant)}`),
              "",
              "Address it by absolute path (/lend/...): a relative path never " +
                "reaches it. A command whose working directory is inside one " +
                "of these folders runs on that computer, in its shell. To " +
                "copy a file between this machine and a lent folder " +
                "unchanged, use share_upload and share_download.",
            ].join("\n"),
          );
        }
        case "declined":
          return text(
            "The user did not lend a folder. Continue without it: say what " +
              "needs the folder, and do not ask again immediately.",
          );
        default:
          return text(
            `The user did not answer within ${minutesText()}, so no folder ` +
              "was lent and the card closed. Do what you can without it, or " +
              "stop and say what you still need. Calling this tool again " +
              "starts a new wait.",
          );
      }
    },
  };
}

/**
 * `share_disconnect`: end one loan the run no longer needs.
 *
 * Nothing is put in front of the user: the page forwards this to the desktop
 * shell and posts what happened. The result is assembled from the shell's
 * answer and from the server's list, so "disconnected" is only said when the
 * folder is actually gone.
 */
export function createShareDisconnectTool(
  options: ShareRequestToolOptions,
): Tool<typeof disconnectSchema> {
  return {
    name: TOOL_SHARE_DISCONNECT,
    label: "Disconnect Lent Folder",
    description:
      "Stop using a folder the user lent you from their computer. The loan " +
      "ends on their machine as well, so nothing you still need can be read " +
      "from it afterwards: copy what you need into this machine first. Takes " +
      "the folder's name, the segment after /lend/.",
    parameters: disconnectSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const name = requireShareName(params.name, options.grants());
      const grant = options
        .grants()
        .find((candidate) => candidate.name === name);
      if (grant === undefined) {
        return text(
          [
            `No folder named ${name} is lent to this conversation, so there ` +
              "is nothing to disconnect.",
            lentLine(options.grants()),
          ].join("\n"),
        );
      }
      if (options.requests.pendingShareRequest() !== null) {
        throw new CoreError(
          "The user is already being asked about a lent folder",
          "conflict",
        );
      }
      const outcome = await options.requests.askDisconnect(
        _id,
        { id: grant.id, name: grant.name },
        signal,
      );
      return text(disconnectText(name, outcome, options.grants()));
    },
  };
}

/** Both tools, in the order the model reads them. */
export function createShareRequestTools(
  options: ShareRequestToolOptions,
): Tool[] {
  return [createShareRequestTool(options), createShareDisconnectTool(options)];
}

/** The request deadline as the model is told it, in whole minutes. */
function minutesText(): string {
  return `${Math.round(SHARE_LEND_TIMEOUT_MS / 60_000)} minutes`;
}

/** The disconnect deadline in whole seconds (see SHARE_DISCONNECT_TIMEOUT_MS:
 * nobody is asked anything, so this is only how long the shell's silence is
 * waited on). */
function disconnectWaitText(): string {
  return `${Math.round(SHARE_DISCONNECT_TIMEOUT_MS / 1_000)} seconds`;
}

/**
 * The folders lent after the request, waiting for the announcement to land.
 *
 * Undefined when nothing new arrived in time (the loan has not reached this
 * server yet), which the caller says rather than inventing a path.
 */
async function borrowed(
  grants: () => readonly FolderGrant[],
  known: readonly string[],
  arrivalMs: number,
  signal?: AbortSignal,
): Promise<readonly FolderGrant[] | undefined> {
  const deadline = Date.now() + arrivalMs;
  for (;;) {
    const now = grants();
    if (now.some((grant) => !known.includes(grant.id))) return now;
    if (Date.now() >= deadline) return undefined;
    if (signal?.aborted === true) return undefined;
    await new Promise((resolve) => setTimeout(resolve, LOAN_ARRIVAL_POLL_MS));
  }
}

/** The name `share_disconnect` was given, or a refusal that says what it
 * should have been. A path is refused rather than converted: the model reads
 * the absolute path in the lent-folder notice, so the mistake is common, and
 * the fix belongs in the answer the model reads. */
function requireShareName(raw: string, grants: readonly FolderGrant[]): string {
  const name = raw.trim();
  if (isShareName(name)) return name;
  const hinted = name.replace(/^\/lend\//, "").replace(/\/+$/, "");
  throw new CoreError(
    isShareName(hinted)
      ? `share_disconnect takes the folder's name, not its path: ` +
          `${name} is "${hinted}". ${lentLine(grants)}`
      : `${name} is not a lent folder's name. ${lentLine(grants)}`,
    "invalid",
  );
}

/** What is lent right now, for a message that has to say why something is
 * not there. */
function lentLine(grants: readonly FolderGrant[]): string {
  if (grants.length === 0) {
    return "No folder is lent to this conversation.";
  }
  return `Lent now: ${grants.map((grant) => shareRootOf(grant.name)).join(", ")}.`;
}

/** One loan as the model reads it: the path it addresses, what it may write,
 * and which computer and shell it is. */
function describe(grant: FolderGrant): string {
  const root = shareRootOf(grant.name);
  const access = grantAccess(grant);
  const where = grant.host.name === "" ? grant.host.platform : grant.host.name;
  const shell = grant.host.shell === "" ? "" : `, ${grant.host.shell}`;
  return `${root} — ${access}, commands run there${shell} — lent from ${where}`;
}

/** The tool's answer to a disconnect attempt, from how it ended and what the
 * server still lends. */
function disconnectText(
  name: string,
  outcome: ShareRequestOutcome,
  grants: readonly FolderGrant[],
): string {
  if (outcome.kind === "disconnected") {
    return (
      `The user's computer stopped lending /lend/${name}. It is no longer ` +
      "reachable: anything you still need from it must be asked for again."
    );
  }
  const still = grants.some((grant) => grant.name === name);
  if (outcome.kind === "failed") {
    return (
      `The user's computer could not disconnect /lend/${name}: ` +
      `${outcome.error}. ` +
      (still
        ? "The folder is still lent."
        : "The loan is gone anyway, so the folder cannot be used.")
    );
  }
  return (
    `The user's desktop app did not answer within ` +
    `${disconnectWaitText()}, so /lend/${name} is still lent as far ` +
    "as the server knows. Ask the user to disconnect it from the " +
    "conversation's information panel."
  );
}

/** One tool result: a sentence the model reads. */
function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }], details: {} };
}
