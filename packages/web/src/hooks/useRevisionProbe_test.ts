/**
 * The revision probe both event streams share.
 *
 * The rule worth pinning is the seeding one: the first read of a key records
 * the value, and only a LATER change counts as a gap. Without it the first
 * tick would resync every open tab the moment the timer fired, which is the
 * opposite of what the probe is for (one tiny request per tab, a snapshot
 * re-read only when something actually moved).
 */
import { assertEquals } from "@std/assert";
import { probeOnce, type RevisionProbeOptions } from "./useRevisionProbe.ts";

/** A probe over a fixed set of keys, recording what it decided. */
function harness(
  revisions: Map<string, number>,
  options: Partial<RevisionProbeOptions> = {},
) {
  const known = new Map<string, number>();
  const moved: string[] = [];
  const reads: string[] = [];
  const probe: RevisionProbeOptions = {
    knownRevision: (key) => known.get(key),
    remember: (key, revision) => known.set(key, revision),
    readRevision: (key) => {
      reads.push(key);
      const rev = revisions.get(key);
      if (rev === undefined) return Promise.reject(new Error("gone"));
      return Promise.resolve(rev);
    },
    onMoved: (key) => moved.push(key),
    keys: () => [...revisions.keys()],
    enabled: () => true,
    disposed: () => false,
    ...options,
  };
  return { probe, known, moved, reads };
}

Deno.test("the first read only seeds the marker", async () => {
  const revisions = new Map([["a", 7]]);
  const { probe, known, moved } = harness(revisions);
  await probeOnce(probe);
  assertEquals(moved, [], "an unseeded view must not be treated as a gap");
  assertEquals(known.get("a"), 7);
});

Deno.test("a later change is reported once per move", async () => {
  const revisions = new Map([["a", 7]]);
  const { probe, moved } = harness(revisions);
  await probeOnce(probe); // seed
  await probeOnce(probe); // still 7
  assertEquals(moved, []);
  revisions.set("a", 8);
  await probeOnce(probe);
  assertEquals(moved, ["a"]);
  await probeOnce(probe); // 8 recorded, no second report
  assertEquals(moved, ["a"]);
});

Deno.test("each key is compared on its own", async () => {
  const revisions = new Map([
    ["a", 1],
    ["b", 1],
  ]);
  const { probe, moved } = harness(revisions);
  await probeOnce(probe); // seed both
  revisions.set("b", 2);
  await probeOnce(probe);
  assertEquals(moved, ["b"]);
});

Deno.test("a failed read is not a state change", async () => {
  const revisions = new Map<string, number>([["a", 1]]);
  const { probe, moved, known } = harness(revisions);
  await probeOnce(probe);
  revisions.delete("a"); // the session was closed elsewhere: the read throws
  await probeOnce(probe);
  assertEquals(moved, [], "a throwing probe must not resync");
  assertEquals(known.get("a"), 1, "the marker survives a failed read");
});

Deno.test("a disposed or disconnected owner is not probed", async () => {
  const revisions = new Map([["a", 1]]);
  const disposed = harness(revisions, { disposed: () => true });
  await probeOnce(disposed.probe);
  assertEquals(disposed.reads, []);

  const disconnected = harness(revisions, { enabled: () => false });
  await probeOnce(disconnected.probe);
  assertEquals(disconnected.reads, []);
});

Deno.test("a key closed mid-flight is not re-read", async () => {
  const revisions = new Map([
    ["a", 1],
    ["b", 1],
  ]);
  const open = new Set(["a", "b"]);
  const { probe, moved } = harness(revisions);
  await probeOnce(probe); // seed
  // `b` closes while the probe for `a` is in flight: simulate by having the
  // read for `a` remove it before returning.
  probe.readRevision = ((original) => (key: string) => {
    if (key === "a") open.delete("b");
    return original(key);
  })(probe.readRevision);
  probe.keys = () => [...open];
  revisions.set("a", 2);
  revisions.set("b", 2);
  await probeOnce(probe);
  assertEquals(moved, ["a"], "the closed key must not be consulted");
});
