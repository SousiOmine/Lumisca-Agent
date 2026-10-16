import { assert, assertEquals } from "@std/assert";
import { createComputerHost } from "./host.ts";

Deno.test("createComputerHost reports the platform when it has no host", {
  // Windows has a host, and so does Linux (wayland.ts, which reports the
  // desktop's own reason instead of the platform's name); this expectation
  // is for the platforms that have none yet.
  ignore: Deno.build.os === "windows" || Deno.build.os === "linux",
}, async () => {
  const result = await createComputerHost();
  assertEquals(result.available, false);
  if (result.available) return; // narrowed for the assertions below
  assert(
    result.reason.includes(Deno.build.os),
    `the reason must name the platform: ${result.reason}`,
  );
});

Deno.test("createComputerHost returns either a usable host or a reason", async () => {
  const result = await createComputerHost();
  if (result.available) {
    try {
      // A host that cannot describe itself or list a display would be
      // unusable: the tool layer resolves capture regions from that list.
      assert(result.host.describe().length > 0);
      assert(result.host.displays().length > 0);
      // The capabilities and the calls they gate must agree: a host that
      // says it cannot see windows must not silently return a stale list,
      // and one that cannot report the pointer must not invent a position.
      const cursor = result.host.cursor();
      assertEquals(cursor === undefined, !result.host.capabilities.cursor);
      if (!result.host.capabilities.windows) {
        assertEquals(result.host.windows().length, 0);
      }
    } finally {
      result.host.close();
    }
    return;
  }
  assert(
    result.reason.length > 0,
    "an unavailable host must say why (the settings toggle shows it)",
  );
});
