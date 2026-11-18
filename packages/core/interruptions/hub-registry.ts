/**
 * One hub per session, created on demand.
 *
 * Three interruption kinds keep a hub per session and each spelled the map
 * and its four operations out by hand. The ownership rule is the same for
 * all of them: a hub lives as long as its session, and the core's close,
 * delete and shutdown paths drop it by `forget`.
 */
export class HubRegistry<H> {
  private readonly hubs = new Map<string, H>();

  constructor(private readonly create: (sessionId: string) => H) {}

  /** The hub of a session, created on first use. */
  for(sessionId: string): H {
    const existing = this.hubs.get(sessionId);
    if (existing !== undefined) return existing;
    const hub = this.create(sessionId);
    this.hubs.set(sessionId, hub);
    return hub;
  }

  /** The hub only if it exists: reading a session that never asked must not
   * create an entry. */
  get(sessionId: string): H | undefined {
    return this.hubs.get(sessionId);
  }

  /** Drop a session's hub. */
  forget(sessionId: string): void {
    this.hubs.delete(sessionId);
  }

  /** The sessions that have a hub, for the shutdown sweep. */
  sessionIds(): Iterable<string> {
    return this.hubs.keys();
  }
}
