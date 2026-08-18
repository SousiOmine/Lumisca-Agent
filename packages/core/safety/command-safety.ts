import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { CommandApproval, CommandSafetyKind } from "../shared.ts";
import {
  COMMAND_SAFETY_APPROVALS_KEY,
  COMMAND_SAFETY_ENABLED_KEY,
} from "../shared.ts";

/** The outcome of one safety check. `ok: false` carries the judge's reason,
 * which becomes the tool result text (the command is not executed). */
export interface CommandSafetyVerdict {
  ok: boolean;
  reason?: string;
}

/** Dependencies injected by the core: the settings surface and the fast
 * model pipeline. Deliberately narrow so the checker stays testable with
 * fakes. */
export interface CommandSafetyDeps {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  /** The configured fast model (undefined when unset). */
  getFastModel(): Model<Api> | undefined;
  streamFn: StreamFn;
}

/** System prompt for the judging model: development commands are the norm
 * and must pass; only clearly destructive or hostile activity is blocked. */
const SAFETY_SYSTEM_PROMPT =
  "You are the safety checker of a coding agent that works inside a " +
  "project workspace. You judge whether a command the agent wants to run " +
  "is safe. Development activity is NORMAL and must NOT be blocked: " +
  "builds, tests, linting, package installation (npm install, pip install, " +
  "deno add, ...), git operations, reading/editing files inside the " +
  "workspace, process inspection, downloading public packages or docs, " +
  "running servers/watchers/migrations, and data-processing code. " +
  "Block only what would: irreversibly destroy user data outside build " +
  "artifacts (rm -rf /, formatting, wiping home directories); modify or " +
  "damage the host system (system config, OS files, boot settings); steal " +
  "credentials or private data; send private data to external servers; " +
  "install malware, miners or backdoors; attack other systems; or bypass " +
  "security controls. Reply with JSON only, no prose: " +
  '{"safe": true|false, "reason": "short explanation"}';

/** How long a judgement may take before the check gives up. */
const CHECK_TIMEOUT_MS = 30_000;

/** Commands longer than this are never recorded as approved — the record
 * would bloat the settings file, and exact re-runs of such payloads are
 * unlikely anyway. */
const MAX_APPROVAL_CHARS = 4096;

/** Reasons for a blocked (fail-closed) result when the enabled check could
 * not produce a verdict. */
const REASON_NO_JUDGE =
  "The safety check is enabled but no fast model is configured, so " +
  "the command could not be judged.";
const REASON_JUDGE_FAILED =
  "The safety check could not reach the fast model and the command was " +
  "not judged.";
const REASON_UNPARSEABLE =
  "The safety check could not interpret the fast model's reply and " +
  "the command was not judged.";

/**
 * Judges whether bash / eval commands may run, using the fast model.
 * Opt-in via the `command_safety_enabled` setting; approved commands are
 * recorded (by hash of kind + resolved cwd + command) under
 * `command_safety_approvals` and skip the check afterwards.
 *
 * Fail-open only when the feature is explicitly disabled. When it is
 * enabled, any check that ends without a verdict — no fast model, an API
 * error, a timeout, an unparseable reply — BLOCKS the command rather than
 * letting it run unjudged.
 *
 * Approval records are scoped to the execution context (kind + resolved
 * cwd): an approval granted for one kind, workspace or directory is never
 * shared with another. The raw command is never persisted — only a hash for
 * matching and a redacted display form, so secrets inside commands stay out
 * of the settings file.
 */
export class CommandSafety {
  constructor(private readonly deps: CommandSafetyDeps) {}

  /** The feature is opt-in: unset = disabled (commands run unchecked). */
  isEnabled(): boolean {
    return this.deps.getSetting(COMMAND_SAFETY_ENABLED_KEY) === "1";
  }

  /** The recorded approvals, in insertion order. */
  approvals(): CommandApproval[] {
    const raw = this.deps.getSetting(COMMAND_SAFETY_APPROVALS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        // Drop entries that are not in the expected shape (a legacy record
        // of plain command strings migrates to an empty list).
        return parsed.filter(isCommandApproval);
      }
    } catch {
      // Corrupt record: treat as empty (the next approval rewrites it).
    }
    return [];
  }

  /** Judge whether `payload` may run in the resolved directory `cwd`.
   * Approved commands and the (explicitly disabled) setting pass without a
   * model call; a verdict the check could not obtain blocks the command. */
  async check(
    kind: CommandSafetyKind,
    payload: string,
    cwd: string,
  ): Promise<CommandSafetyVerdict> {
    if (!this.isEnabled()) return { ok: true };
    const command = payload.trim();
    if (command.length === 0) return { ok: true };
    const hash = await sha256Hex(this.contextKey(kind, cwd, command));
    if (this.approvals().some((a) => a.hash === hash)) return { ok: true };
    const model = this.deps.getFastModel();
    if (model === undefined) return { ok: false, reason: REASON_NO_JUDGE };
    let verdict: { safe: boolean; reason: string } | null;
    try {
      verdict = await this.ask(model, kind, cwd, command);
    } catch {
      return { ok: false, reason: REASON_JUDGE_FAILED };
    }
    if (verdict === null) return { ok: false, reason: REASON_UNPARSEABLE };
    if (verdict.safe) {
      if (command.length <= MAX_APPROVAL_CHARS) {
        await this.approve(kind, command, cwd);
      }
      return { ok: true };
    }
    return { ok: false, reason: verdict.reason };
  }

  /** Record a command as approved for its kind+cwd context (stored by hash,
   * with a redacted display form). Future identical checks skip the judge. */
  async approve(
    kind: CommandSafetyKind,
    command: string,
    cwd: string,
  ): Promise<void> {
    const entry: CommandApproval = {
      hash: await sha256Hex(this.contextKey(kind, cwd, command)),
      kind,
      cwd,
      command: redactSecrets(command),
    };
    const list = this.approvals();
    if (!list.some((a) => a.hash === entry.hash)) {
      list.push(entry);
      this.deps.setSetting(
        COMMAND_SAFETY_APPROVALS_KEY,
        JSON.stringify(list),
      );
    }
  }

  /** Remove one approval by its hash (it will be judged again next time). */
  deleteApproval(hash: string): void {
    const list = this.approvals().filter((a) => a.hash !== hash);
    this.deps.setSetting(COMMAND_SAFETY_APPROVALS_KEY, JSON.stringify(list));
  }

  /** Forget every approval. */
  clearApprovals(): void {
    this.deps.setSetting(COMMAND_SAFETY_APPROVALS_KEY, "[]");
  }

  /** The string an approval is keyed on: kind, resolved cwd, command. This
   * ties every approval to the exact context it was granted in. */
  private contextKey(
    kind: CommandSafetyKind,
    cwd: string,
    command: string,
  ): string {
    return `${kind}\u0000${cwd}\u0000${command}`;
  }

  /** Ask the fast model for a verdict. Returns null when the reply is not
   * the expected JSON; throws on stream errors. */
  private async ask(
    model: Model<Api>,
    kind: CommandSafetyKind,
    cwd: string,
    command: string,
  ): Promise<{ safe: boolean; reason: string } | null> {
    const controller = new AbortController();
    const describe = kind === "bash"
      ? `The agent wants to run this shell command in the directory ${cwd}:\n${command}`
      : `The agent wants to evaluate this JavaScript/TypeScript snippet (working directory ${cwd}):\n${command}`;
    const collect = async () => {
      const stream = await this.deps.streamFn(model, {
        systemPrompt: SAFETY_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: describe }],
          timestamp: Date.now(),
        }],
      }, { signal: controller.signal });
      let text = "";
      for await (const event of stream) {
        if (event.type === "text_delta") {
          text += event.delta;
        } else if (event.type === "error") {
          throw new Error(
            event.error.errorMessage ?? "safety check request failed",
          );
        }
      }
      return parseVerdict(text);
    };
    // Race the reply against the timeout: aborting the controller closes
    // well-behaved streams, and the race covers providers that ignore the
    // signal — the check must never hang the agent loop. A timeout fails
    // the check (like an API error); only a reply that does not parse into
    // the expected JSON comes back as null.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        collect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("safety check timed out"));
          }, CHECK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Type guard for one stored approval entry (corrupt/missing fields are
 * dropped so old plain-string records migrate to an empty list). */
function isCommandApproval(value: unknown): value is CommandApproval {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.kind === "bash" || v.kind === "eval") &&
    typeof v.hash === "string" &&
    typeof v.cwd === "string" &&
    typeof v.command === "string";
}

/** SHA-256 of `text`, hex-encoded (Web Crypto; the record never needs to
 * recover the plaintext command from the hash). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract {"safe": bool, "reason": string} from the model's reply. Models
 * occasionally wrap the JSON in markdown fences or add prose; take the
 * first balanced {...} object and parse it. Returns null when nothing
 * parses into the expected shape. */
export function parseVerdict(
  text: string,
): { safe: boolean; reason: string } | null {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (match === null) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as { safe?: unknown }).safe === "boolean" &&
      typeof (parsed as { reason?: unknown }).reason === "string"
    ) {
      return parsed as { safe: boolean; reason: string };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Secret-named keys whose values are redacted in `key=value` / `key: value`
 * positions. Case-insensitive; the `-`/`_` variants cover HTTP header
 * styles (`X-API-Key`, `client_secret`) as well as config/env formats. */
const SECRET_KEY_RE =
  "api[_-]?key|access[_-]?token|refresh_token|client[_-]?secret|" +
  "secret|secret[_-]?key|password|passwd|pwd|private[_-]?key|" +
  "bearer_token|access_key|auth[_-]?token|session[_-]?token|" +
  "github[_-]?token|slack[_-]?token";

/**
 * Best-effort redaction of secret values in a command string, for display
 * only. Authorization headers (curl `-H`/`--header`, bare `Name: value`)
 * and values of secret-named keys are replaced with `***`; anything the
 * redactor misses still only ends up as the display form, so this is a
 * safeguard, not a sanitization boundary.
 */
export function redactSecrets(text: string): string {
  // Header names (Authorization / Proxy-Authorization) and the names of
  // commonly-secret keys. Unanchored + case-insensitive so `-H "X-API-Key:
  // …"` and bare `api_key=…` both redact.
  const headerRe = "(?:proxy-)?authorization\\b";
  const keyRe = `(?:${SECRET_KEY_RE})\\b`;
  const redact = (
    name: string,
    value: string,
    replacement: (_m: string, p: string) => string,
  ): void => {
    text = text.replace(
      new RegExp(`(${name}\\s*[:=]\\s*)(?:${value})`, "gi"),
      replacement,
    );
  };
  // Unquoted values first (`Authorization: Bearer abc`); quote-aware so a
  // quoted value is left for the quoted passes below, keeping the outer
  // quotes intact.
  redact(headerRe, "[^\"'\\n]+", (_m, p) => `${p}***`);
  redact(keyRe, "[^\"'\\n]+", (_m, p) => `${p}***`);
  // Quoted values (curl -H "…" / --header '…', config writes, ...).
  redact(headerRe, '"[^"]*"', (_m, p) => `${p}"***"`);
  redact(headerRe, "'[^']*'", (_m, p) => `${p}'***'`);
  redact(keyRe, '"[^"]*"', (_m, p) => `${p}"***"`);
  redact(keyRe, "'[^']*'", (_m, p) => `${p}'***'`);
  // `Bearer <credential>` in any position.
  text = text.replace(/(\bBearer\s+)\S+/gi, "$1***");
  return text;
}
