import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join, join as pathJoin } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { findCanvasIcuDataFile } from "./icu-data.ts";

test("findCanvasIcuDataFile takes LUMISCA_ICU_DATA from the injected env", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-icu-"));
  try {
    const file = join(dir, "icudtl.dat");
    await fsp.writeFile(file, "icu");

    // The environment is a parameter, not the process: process.env is shared by
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
    await fsp.rm(dir, { recursive: true });
  }
});
