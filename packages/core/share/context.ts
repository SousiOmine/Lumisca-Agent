/**
 * The folders lent to this conversation, as a context message.
 *
 * Not the system prompt: a loan lasts minutes and the prompt is a stable
 * document whose first tokens the provider caches (see
 * agent/factory.ts `ensureSystemPrompt`). Not a tool description either — the
 * file tools are the same tools whether a folder was lent or not, and a
 * description cannot say "right now these two folders exist".
 *
 * The publication is the whole list every time, and its absence is meaningful
 * too: when the last loan ends, the conversation is told so, because an agent
 * that keeps trying `/lend/proj` would otherwise read the failures as a broken
 * tool instead of an ended loan. Being a context message, it also survives a
 * compaction honestly: the checkpoint folds it away, the provider republishes
 * it before the next run (see SessionAgent.rebaseContexts).
 */
import {
  type ContextProvider,
  type ContextUpdate,
  contextMessage,
} from "../ai/context-providers.ts";
import type { ContextMessage } from "../ai/types.ts";
import type { FolderGrant } from "./grant.ts";
import { grantAccess, shareRootOf } from "./grant.ts";

const TITLE = "Lent folders";

/** What the model reads for one loan: the path it addresses, what it may
 * write, and which computer and shell it is. */
function describe(grant: FolderGrant): string {
  const root = shareRootOf(grant.name);
  const access = grantAccess(grant);
  const where = grant.host.name === "" ? grant.host.platform : grant.host.name;
  return (
    `- ${root} — ${access}, commands run there (${grant.host.shell}) — ` +
    `lent from ${where}`
  );
}

function signatureOf(grants: readonly FolderGrant[]): string {
  return grants
    .map(
      (grant) =>
        `${grant.id}|${grant.name}|${grant.sessionId}|${grant.write}|${grant.host.shell}`,
    )
    .join("\n");
}

/**
 * The provider. `grants` is read on every publish attempt (once per run), so a
 * loan made while the user waits for an answer is announced before the next
 * turn without rebuilding anything.
 */
export function createShareProvider(options: {
  grants: () => readonly FolderGrant[];
}): ContextProvider {
  /** The state of the last publication, as its message carries it (see
   * ContextUpdate.state). */
  let published: string | undefined;
  /** Whether a loan was ever announced in this view: the first empty list of
   * a session must say nothing, while the list that goes empty must say the
   * loan ended. */
  let announced = false;

  const update = (body: string, state: string): ContextUpdate => ({
    title: TITLE,
    body,
    state,
  });

  return {
    name: "shares",
    next(): ContextUpdate[] {
      const grants = options.grants();
      const signature = signatureOf(grants);
      if (signature === published) return [];
      published = signature;
      if (grants.length === 0) {
        if (!announced) return [];
        announced = false;
        return [
          update(
            "The folders lent to you from the user's computer are no longer " +
              "available: the loan ended or the user withdrew it. Nothing " +
              "under /lend can be used any more.",
            signature,
          ),
        ];
      }
      announced = true;
      const roots = grants.map((grant) => shareRootOf(grant.name));
      return [
        update(
          [
            "The user lent you these folders from their own computer for " +
              "this conversation:",
            "",
            ...grants.map(describe),
            "",
            "They are not one of the folders this session works in. Address " +
              `them by absolute path (${roots.join(", ")} and below): a ` +
              "relative path never reaches them. A command whose working " +
              "directory is inside one of these folders runs on that " +
              "computer, in its shell; the shell you normally use is " +
              "elsewhere. To copy a file between this computer and a lent " +
              "folder unchanged, use the share_upload and share_download " +
              "tools: find them with tool_search. The user can withdraw a " +
              "folder at any time, and then it is gone.",
          ].join("\n"),
          signature,
        ),
      ];
    },
    rebase(state: unknown): void {
      // The signature is one line per loan, so an empty string is the list
      // that has nothing to say — and a non-empty one is a loan the model has
      // already been told about.
      published = typeof state === "string" ? state : undefined;
      announced = typeof state === "string" && state !== "";
    },
  };
}

/**
 * The messages a sub-agent is spawned with, when folders are lent to its
 * session.
 *
 * A sub-agent's transcript is memory-only and nothing republishes its context
 * (see tools/task-hub.ts), so this one publication is the whole conversation
 * it has about the loan. Without it the sub-agent can still reach
 * `/lend/<name>` — its backends are the session's — but nothing tells it the
 * folder exists, and an agent that does not know a folder is there will not
 * look in it when the parent's request points at it.
 */
export function shareSeedMessages(
  provider: ContextProvider,
  timestamp: number,
): ContextMessage[] {
  return provider
    .next()
    .map((update) => contextMessage(provider.name, update, timestamp));
}
