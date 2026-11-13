/**
 * Check the Japanese of the UI catalogue.
 *
 * Every user-facing string lives in `packages/core/shared/i18n/`, so checking
 * that one catalogue checks every screen. The rules below are the ones this
 * app keeps; they are narrower than a technical-writing linter on purpose,
 * because UI copy is not prose: a label has no closing period, and a
 * confirmation ends in "？" instead of "。". Each finding names the key, the
 * rule and the source file, shows the string as it is, and gives the fixed
 * string when the replacement is mechanical.
 *
 * Usage:
 *   bun run check:ja                  check every entry
 *   bun run check:ja --list [prefix]  print key, Japanese and English for
 *                                     review, oldest key first; `prefix`
 *                                     narrows it to one surface
 *
 * Exits 1 on findings.
 */

import { exit, runtime } from "../packages/core/runtime/runtime.ts";
import { chat } from "../packages/core/shared/i18n/chat.ts";
import { chrome } from "../packages/core/shared/i18n/chrome.ts";
import { common } from "../packages/core/shared/i18n/common.ts";
import { messages } from "../packages/core/shared/i18n/messages.ts";
import { panels } from "../packages/core/shared/i18n/panels.ts";
import { settings } from "../packages/core/shared/i18n/settings.ts";

/** One catalogue entry; only the Japanese is checked. */
export interface UiText {
  readonly ja: string;
  readonly en?: string;
}

export interface Finding {
  readonly key: string;
  readonly rule: string;
  readonly note: string;
  readonly text: string;
  /** The whole string after a mechanical correction, when there is one. */
  readonly fixed?: string;
}

type Rule = {
  readonly id: string;
  readonly note: string;
  /** Null when the rule does not apply; `{}` when it does but the fix is not
   * mechanical (a person has to choose the verb). */
  check(text: string): { readonly fixed?: string } | null;
};

/** Replace every match, even when the rule's own pattern is not global. */
function replaceEvery(
  text: string,
  pattern: RegExp,
  replacement: string,
): string {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return text.replace(new RegExp(pattern.source, flags), replacement);
}

function patternRule(
  id: string,
  note: string,
  pattern: RegExp,
  fix?: string,
): Rule {
  return {
    id,
    note,
    check(text) {
      if (!pattern.test(text)) return null;
      return {
        fixed: fix === undefined ? undefined : replaceEvery(text, pattern, fix),
      };
    },
  };
}

/** Corrections that depend on the whole string rather than one pattern. */
const RULES: readonly Rule[] = [
  // --- one word per concept ------------------------------------------------
  patternRule(
    "glossary/folder",
    'write "フォルダー", as the rest of the catalogue does',
    /フォルダ(?!ー)/,
    "フォルダー",
  ),
  patternRule(
    "glossary/default",
    'write "既定", as the rest of the catalogue does',
    /デフォルト/,
    "既定",
  ),
  patternRule(
    "glossary/browser",
    'write "ブラウザ", as the rest of the catalogue does',
    /ブラウザー/,
    "ブラウザ",
  ),
  patternRule("glossary/user", 'write "ユーザー"', /ユーザ(?!ー)/, "ユーザー"),
  patternRule(
    "glossary/server",
    'write "サーバー"',
    /サーバ(?!ー)/,
    "サーバー",
  ),
  patternRule(
    "glossary/lend",
    'a folder is "接続"した, not 貸した; say what the action does',
    /貸(?:す|した|して|せ|出)/,
  ),
  patternRule(
    "glossary/cut",
    'say what ends: a connection is "切断されます"',
    /切れます/,
  ),

  // --- translated English --------------------------------------------------
  patternRule(
    "style/potential",
    'say "〜できます" directly, not "〜することができます"',
    /することが(?:できます|可能です)/,
  ),
  patternRule(
    "style/humble",
    "drop させていただ and write the action plainly",
    /させていただ/,
  ),
  patternRule(
    "style/teineigo",
    'write "してください"',
    /して下さい/,
    "してください",
  ),
  patternRule("style/okonau", "use the verb itself, not を行う", /を行う/),
  patternRule("style/kanshite", 'write "について"', /に関して/, "について"),
  patternRule("style/oite", 'write "で"', /において/, "で"),
  patternRule("style/sai", 'write "とき"', /の際/),
  patternRule(
    "style/da",
    "sentences end in です・ます; a plain ending reads like a manual",
    /(?:する|である|だ|(?<![まで])した)。$/,
  ),

  // --- typography ----------------------------------------------------------
  patternRule(
    "format/ellipsis",
    'write one "…", not three periods',
    /\.\.\./,
    "…",
  ),
  patternRule("format/double-ellipsis", 'one "…" is enough', /……/, "…"),
  {
    id: "format/double-punctuation",
    note: "one punctuation mark is enough",
    check(text) {
      const fixed = text.replace(/([、。])\1+/g, "$1");
      return fixed === text ? null : { fixed };
    },
  },
  {
    id: "format/space-before-punctuation",
    note: "no space before a punctuation mark",
    check(text) {
      const fixed = text.replace(/[ 　]+([、。，．！？」）])/g, "$1");
      return fixed === text ? null : { fixed };
    },
  },
  patternRule("format/double-space", "one space between words", /[ 　]{2,}/),
  {
    id: "format/edge-space",
    note: "no space at either edge; a colon may wait for its value",
    check(text) {
      if (/^[ 　]/.test(text)) return {};
      // "cannot reach the shell: " is a prefix the component concatenates a
      // detail onto; that one space is the separator.
      if (/[ 　]$/.test(text) && !/[:：] $/.test(text)) return {};
      return null;
    },
  },
  patternRule(
    "format/fullwidth-ascii",
    "use half-width letters and digits",
    /[Ａ-Ｚａ-ｚ０-９]/,
  ),
  patternRule("format/halfwidth-kana", "use full-width kana", /[ｦ-ﾟ]/),
  patternRule(
    "format/emoji",
    "no emoji in UI text",
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
  ),
  patternRule("format/exclamation", "no exclamation mark in UI text", /！/),

  // --- sentences -----------------------------------------------------------
  {
    id: "sentence/unterminated",
    note:
      "a message with a sentence ends it with 。; only a trailing value " +
      "may leave it out",
    check(text) {
      const line = text.trimEnd();
      if (!line.includes("。")) return null;
      if (/[。？！…]$/.test(line)) return null;
      // "終了コード: {code}" is a label whose value follows the colon.
      if (/[:：]\s*\{[^}]+\}$/.test(line)) return null;
      return {};
    },
  },
  {
    id: "sentence/parentheses",
    note: "write a second sentence instead of a parenthetical gloss",
    check(text) {
      return text.includes("。") && /[（(]/.test(text) ? {} : null;
    },
  },
];

/** The catalogue key's owning file, for a finding the reader can open. The
 * core-generated keys (`notify.*`, `checkpoint.*`, `session.*`) live in
 * `common.ts` without that prefix, so the file is looked up by membership
 * instead of guessed from the first segment. */
const AREA_TABLES: Record<string, Record<string, UiText>> = {
  common,
  chrome,
  settings,
  chat,
  panels,
};

function sourceFile(key: string): string {
  for (const [name, table] of Object.entries(AREA_TABLES)) {
    if (key in table) return `packages/core/shared/i18n/${name}.ts`;
  }
  return "packages/core/shared/i18n/";
}

/** Every rule that applies to every entry, oldest key first. */
export function checkUiJapanese(
  catalogue: Record<string, UiText>,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const key of Object.keys(catalogue).sort()) {
    const text = catalogue[key]?.ja;
    if (text === undefined) continue;
    for (const rule of RULES) {
      const result = rule.check(text);
      if (result === null) continue;
      findings.push({
        key,
        rule: rule.id,
        note: rule.note,
        text,
        ...(result.fixed === undefined ? {} : { fixed: result.fixed }),
      });
    }
  }
  return findings;
}

/** One line per string, for reading a surface straight through. The English
 * is there to recover the intent when the Japanese sounds odd. */
function list(prefix: string): void {
  for (const key of Object.keys(messages).sort()) {
    if (!key.startsWith(prefix)) continue;
    const entry = messages[key as keyof typeof messages];
    console.log(`${key}\t${entry.ja}\t${entry.en}`);
  }
}

function main(): void {
  const [first, second] = runtime.args;
  if (first === "--list") {
    list(second ?? "");
    exit(0);
  }

  const findings = checkUiJapanese(messages);
  const count = Object.keys(messages).length;
  if (findings.length === 0) {
    console.log(`UI Japanese: ${count} strings, no findings.`);
    exit(0);
  }
  for (const finding of findings) {
    console.error(`\n${finding.key} [${finding.rule}]`);
    console.error(`  ${sourceFile(finding.key)}`);
    console.error(`  ${finding.note}`);
    console.error(`  now: ${finding.text}`);
    if (finding.fixed !== undefined) console.error(`  fix: ${finding.fixed}`);
  }
  console.error(`\n${findings.length} findings in ${count} strings.`);
  exit(1);
}

if (import.meta.main) main();
