/**
 * The port the launcher binds when nothing names one.
 *
 * It lives in its own module because four places must agree on it: the
 * launcher, the Vite dev proxy, the demo server and the token probe. Two of
 * them are not server code and must not import the launcher (which reads the
 * environment and the runtime).
 */
export const DEFAULT_PORT = 8000;
