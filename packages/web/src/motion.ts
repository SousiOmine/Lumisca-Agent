/**
 * The one entry point to the motion library.
 *
 * Only a few surfaces need JavaScript motion (an element that must animate
 * out before it unmounts, a pane whose travel is decided at runtime), and
 * they all come through here, for three reasons:
 *
 * 1. **One import, one loading decision.** `motion/mini` is the WAAPI-backed
 *    build (≈2.3 KB, no React bindings): it plays on the compositor and hands
 *    back an `AnimationPlaybackControls` whose `finished` promise says when
 *    the element is gone. The full `motion` entry pulls the hybrid animator,
 *    which this app has no use for.
 * 2. **It initialises late.** The library is imported on first use rather
 *    than at module scope: nothing runs until a surface actually needs motion,
 *    so the first frame of the app — drawing the transcript, placing the
 *    composer — never waits on it.
 *
 *    It is NOT a separate download: the client bundle is built into one file
 *    (packages/server/bundle.ts, `format: "esm"` with a single outfile), and
 *    esbuild inlines a dynamic import into that file. Measured on the real
 *    entry point: `motion/mini` costs 14.2 KiB minified (≈5 KiB gzipped) and
 *    is part of `app.js`. Splitting it out would mean `outdir` + `splitting`
 *    in the bundler and a route that serves the chunks, which is a change to
 *    the build rather than to this file.
 * 3. **Reduced motion is honoured here, once.** A caller asks for motion and
 *    gets `null` when the reader asked for less: the caller then applies its
 *    end state directly. That is the "fewer and gentler, not none" rule of
 *    styles/reduced-motion.css, applied to motion a stylesheet cannot cancel.
 */

/** The curves the app uses, as WAAPI will take them. Kept in step with
 * styles/tokens.css by hand (a CSS custom property cannot be handed to
 * `element.animate` as an easing) — see styles_test.ts, which checks that
 * those tokens exist. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** Durations of the exits, in seconds (the library's unit). The entrances are
 * stylesheet work; these are the few that have to run in JavaScript. */
export const EXIT_SECONDS = 0.14;

/** What a caller gets to play: `finished` resolves when the animation ends or
 * is cancelled (a redirect, an unmount), so a caller can always clean up. */
export interface Playing {
  finished: Promise<void>;
}

/** The slice of `motion/mini`'s `animate` this module uses. */
type Animate = (
  element: Element,
  keyframes: Record<string, unknown>,
  options?: Record<string, unknown>,
) => { finished?: Promise<unknown> };

/** The loaded animator, or undefined before the first use. */
let animator: Promise<Animate | null> | undefined;

function loadAnimator(): Promise<Animate | null> {
  animator ??= import("motion/mini").then(
    (module) => (module.animate as unknown as Animate | undefined) ?? null,
    // A failed load (an offline reload with a cold cache) must not take the
    // caller down with it: the surface then opens and closes without motion,
    // which is what it did before any of this existed.
    () => null,
  );
  return animator;
}

/**
 * Play `keyframes` on `element`.
 *
 * Returns `null` when there is nothing to play — the reader asked for reduced
 * motion, the element is gone, or the animator could not be loaded — and the
 * caller must then apply its end state immediately. `finished` is returned
 * even for a zero-length animation, so a caller's cleanup has one path.
 *
 * `prefersReducedMotion` is passed rather than read: the caller already knows
 * (it is a `useReducedMotion()` hook result), and reading the media query
 * again here would give the two answers a chance to disagree for a frame.
 */
export async function play(
  element: Element | null,
  keyframes: Record<string, unknown>,
  options: {
    duration: number;
    delay?: number;
    easing?: readonly [number, number, number, number];
    /** Nobody will wait for this exit (the reader asked for less motion). */
    prefersReducedMotion: boolean;
  },
): Promise<Playing | null> {
  if (element === null) return null;
  if (options.prefersReducedMotion) return null;
  const animate = await loadAnimator();
  if (animate === null) return null;
  const controls = animate(element, keyframes, {
    duration: options.duration,
    delay: options.delay ?? 0,
    // A bezier is passed to WAAPI as four numbers and the library recognises it
    // by the first one (`isBezierDefinition`), turning it into
    // `cubic-bezier(...)`. A function (a spring) would need `linear()` support,
    // which older WebKit builds lack — the curves here are all beziers.
    ease: [...(options.easing ?? EASE_OUT)],
    // The element is usually removed or restyled right after: without `fill`
    // the start frame would flash back for one frame.
    fill: "both",
  });
  return {
    finished: Promise.resolve(controls.finished).then(() => {}, () => {}),
  };
}
