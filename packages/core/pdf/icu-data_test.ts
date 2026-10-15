import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { findCanvasIcuDataFile } from "./icu-data.ts";

Deno.test("findCanvasIcuDataFile takes LUMISCA_ICU_DATA from the injected env", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-icu-" });
  try {
    const file = join(dir, "icudtl.dat");
    await Deno.writeTextFile(file, "icu");

    // The environment is a parameter, not the process: Deno.env is shared by
    // every test file the runner parallels, so a test passes its own.
    assertEquals(
      findCanvasIcuDataFile(() => ({ LUMISCA_ICU_DATA: file })),
      file,
    );
    // A stale override is not an error: the search falls through instead of
    // throwing (the file is simply not found on this host).
    assert(
      findCanvasIcuDataFile(() => ({ LUMISCA_ICU_DATA: join(dir, "gone") })) !==
        join(dir, "gone"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
