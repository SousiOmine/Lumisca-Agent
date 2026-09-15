/**
 * The shape every catalogue entry has: the same message in every supported
 * locale. Keeping both languages in ONE entry (rather than one file per
 * locale) makes a half-done translation impossible to commit — the type
 * requires the other language, so the compiler names every missing string.
 *
 * Lives in its own module (not `messages.ts`) so the area catalogues can
 * import it without a cycle: `messages.ts` imports them.
 */
export interface LocalizedText {
  /** Japanese (the app's original language). */
  readonly ja: string;
  /** English. */
  readonly en: string;
}
