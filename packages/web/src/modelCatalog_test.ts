import { assert, assertEquals } from "@std/assert";
import {
  CatalogFetchError,
  type CatalogLoader,
  ModelCatalog,
  type PeerCatalog,
} from "./modelCatalog.ts";

/** A catalog with one provider ("faux") holding one model. */
function catalog(enabled = true): PeerCatalog {
  return {
    providers: [{ id: "faux", name: "Faux" }],
    modelsByProvider: new Map([
      ["faux", [{ id: "m1", name: "M1", enabled }]],
    ]),
  };
}

function enabledOf(store: ModelCatalog, peerId = ""): boolean | undefined {
  return store.state(peerId).modelsByProvider.get("faux")?.[0]?.enabled;
}

/** Wait for the fetch a subscribe kicked off to settle. */
async function waitLoaded(store: ModelCatalog, peerId = ""): Promise<void> {
  for (let i = 0; i < 50 && store.state(peerId).loading; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

Deno.test("ModelCatalog: the first subscriber loads, later ones reuse it", async () => {
  let loads = 0;
  const store = new ModelCatalog(() => {
    loads += 1;
    return Promise.resolve(catalog());
  });

  // Mounting (the hook subscribes) kicks off the load.
  const unsubscribe = store.subscribe("", () => {});
  await waitLoaded(store);
  assertEquals(loads, 1);
  assertEquals(store.state("").loading, false);
  assertEquals(store.state("").providers.length, 1);

  // A remount (reopening the settings dialog, a tab switch) must not
  // re-request the catalog.
  const unsubscribe2 = store.subscribe("", () => {});
  assertEquals(loads, 1);
  unsubscribe();
  unsubscribe2();
});

Deno.test("ModelCatalog: a committed enablement survives a remount", async () => {
  const store = new ModelCatalog(() => Promise.resolve(catalog(true)));
  store.subscribe("", () => {});
  await waitLoaded(store);
  assertEquals(enabledOf(store), true);

  // The settings list commits a disable: this is what setModelEnabled does
  // once the server accepted the change.
  store.applyModelEnabled("", "faux", "m1", false);
  assertEquals(enabledOf(store), false);

  // The list unmounts and mounts again (the settings dialog reopened) and
  // reads the store: the committed value must stay.
  const unsubscribe = store.subscribe("", () => {});
  assertEquals(enabledOf(store), false);

  // Re-enabling writes the flag back.
  store.applyModelEnabled("", "faux", "m1", true);
  assertEquals(enabledOf(store), true);
  unsubscribe();
});

Deno.test("ModelCatalog: applyModelEnabled ignores unknown models", async () => {
  const store = new ModelCatalog(() => Promise.resolve(catalog()));
  store.subscribe("", () => {});
  await waitLoaded(store);

  const before = store.state("");
  store.applyModelEnabled("", "other", "m1", false);
  store.applyModelEnabled("", "faux", "gone", false);
  // Nothing to patch: the state object is left alone (no pointless render)
  // even though the flags are remembered for the next fetch.
  assert(store.state("") === before);
  assertEquals(enabledOf(store), true);
});

Deno.test("ModelCatalog: subscribers see every publish", async () => {
  const store = new ModelCatalog(() => Promise.resolve(catalog()));
  const published: number[] = [];
  const unsubscribe = store.subscribe("", () => {
    published.push(store.state("").modelsByProvider.size);
  });
  await waitLoaded(store);
  store.applyModelEnabled("", "faux", "m1", false);

  // The load publishes twice (loading, settled), the toggle once.
  assert(published.length >= 2, `expected publishes, got ${published.length}`);
  assertEquals(published.at(-1), 1);

  const seen = published.length;
  unsubscribe();
  store.applyModelEnabled("", "faux", "m1", true);
  assertEquals(published.length, seen, "an unsubscribed listener stays quiet");
});

Deno.test("ModelCatalog: a failed fetch reports the failing phase", async () => {
  const store = new ModelCatalog(() => {
    throw new CatalogFetchError("providers", "server unreachable");
  });
  store.subscribe("", () => {});
  await waitLoaded(store);
  assertEquals(store.state("").error?.phase, "providers");
  assertEquals(store.state("").error?.message, "server unreachable");
  assertEquals(store.state("").loading, false);

  // A loader that fails without tagging the phase is reported just the same
  // (reload never rejects; the failure lands on the state).
  const boom: CatalogLoader = () => Promise.reject(new Error("boom"));
  const store2 = new ModelCatalog(boom);
  await store2.reload("peer-1");
  assertEquals(store2.state("peer-1").error?.phase, "providers");
  assertEquals(store2.state("peer-1").error?.message, "boom");
});

Deno.test("ModelCatalog: a commit during a fetch is not reverted by its snapshot", async () => {
  let release: (() => void) | undefined;
  const store = new ModelCatalog(() =>
    new Promise<PeerCatalog>((resolve) => {
      // The snapshot (still enabled) is resolved only after the commit
      // below lands — the ordering that used to turn a visible toggle back.
      release = () => resolve(catalog(true));
    })
  );
  store.subscribe("", () => {});
  // The models are not cached yet, so the commit only records itself here.
  store.applyModelEnabled("", "faux", "m1", false);

  release?.();
  await waitLoaded(store);
  // The stale snapshot (enabled) must not win over the newer commit.
  assertEquals(enabledOf(store), false);
});

Deno.test("ModelCatalog: a commit outlives a later fetch of the old value", async () => {
  // The server had not persisted the flag yet when the second fetch was
  // issued, so the snapshot still carries the pre-toggle value.
  let serverValue = true;
  const store = new ModelCatalog(() => Promise.resolve(catalog(serverValue)));
  store.subscribe("", () => {});
  await waitLoaded(store);
  store.applyModelEnabled("", "faux", "m1", false);

  await store.reload("");
  assertEquals(enabledOf(store), false);

  // Once the server catches up, the fetched value matches the commit and
  // the catalog is served as-is.
  serverValue = false;
  await store.reload("");
  assertEquals(enabledOf(store), false);
});

Deno.test("ModelCatalog: commits of one peer never leak into another", async () => {
  const store = new ModelCatalog(() => Promise.resolve(catalog(true)));
  await store.reload(""); // this server
  await store.reload("peer-1"); // a federated peer

  store.applyModelEnabled("", "faux", "m1", false);
  assertEquals(enabledOf(store), false);
  assertEquals(enabledOf(store, "peer-1"), true);

  // The other peer's fetch re-applies only its own commits.
  await store.reload("peer-1");
  assertEquals(enabledOf(store, "peer-1"), true);
  assertEquals(enabledOf(store), false);
});

Deno.test("ModelCatalog: a superseded fetch cannot overwrite the newer one", async () => {
  let releaseSlow: (() => void) | undefined;
  let calls = 0;
  const store = new ModelCatalog(async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      return catalog(false);
    }
    return catalog(true);
  });

  const slow = store.reload(""); // superseded below
  await store.reload(""); // the newer fetch wins
  assertEquals(enabledOf(store), true);

  releaseSlow?.();
  await slow;
  // The stale response (fetched before the newer one) is dropped.
  assertEquals(enabledOf(store), true);
});
